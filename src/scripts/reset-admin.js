// src/scripts/reset-admin.js
// Run this via terminal: node src/scripts/reset-admin.js <username> <new_password>

require('dotenv').config(); 
const { sql, getPool } = require('../db/mssql');
const { hashPassword } = require('../utils/password');
const { encrypt } = require('../utils/crypto');
const axios = require('axios');
const { getCtx, loadDbConfig } = require('../env');
const { joinUrl } = require('../utils/http');

async function syncBigFixAdminPassword(username, newPassword) {
    const ctx = getCtx();
    const { BIGFIX_BASE_URL, BIGFIX_USER, BIGFIX_PASS, httpsAgent } = ctx.bigfix;
    if (!BIGFIX_BASE_URL) return;

    console.log(`Syncing new password to BigFix API for ${username}...`);
    const auth = { username: BIGFIX_USER, password: BIGFIX_PASS };
    const opUrl = joinUrl(BIGFIX_BASE_URL, `/api/operator/${encodeURIComponent(username)}`);

    try {
        const opResp = await axios.get(opUrl, { httpsAgent, auth, headers: { Accept: "application/xml" }});
        let xml = String(opResp.data);

        // 1. STRIP READ-ONLY TAGS
        xml = xml.replace(/<(LastLoginTime|ActionCount|ComputerCount|RoleCount|SiteCount|UserGroupCount|LogOnCount|LogOnCountSinceLast)[^>]*>.*?<\/\1>/gi, '');

        // 2. INJECT NEW PASSWORD
        if (xml.includes('<Password>')) {
            xml = xml.replace(/<Password>.*?<\/Password>/i, `<Password>${newPassword}</Password>`);
        } else {
            xml = xml.replace('</Name>', `</Name>\n        <Password>${newPassword}</Password>`);
        }

        // 3. PUSH TO BIGFIX
        await axios.put(opUrl, xml, { httpsAgent, auth, headers: { "Content-Type": "application/xml" }});
        console.log(` BigFix API updated successfully.`);

        // 4. PREVENT THE 401 LOCKOUT
        if (username.toLowerCase() === BIGFIX_USER.toLowerCase()) {
            console.log(`[Warning] You changed the password for the Global Service Account! Updating AppConfiguration database...`);
            const pool = await getPool();
            const encGlobalPass = encrypt(newPassword);
            
            const updateConfig = async (key) => {
                await pool.request().input('key', sql.NVarChar, key).input('val', sql.NVarChar, encGlobalPass).query(`
                    MERGE dbo.AppConfiguration AS target
                    USING (SELECT @key AS ConfigKey, @val AS ConfigValue) AS source
                    ON (target.ConfigKey = source.ConfigKey)
                    WHEN MATCHED THEN UPDATE SET ConfigValue = source.ConfigValue, UpdatedAt = SYSUTCDATETIME()
                    WHEN NOT MATCHED THEN INSERT (ConfigKey, ConfigValue) VALUES (source.ConfigKey, source.ConfigValue);
                `);
            };

            await updateConfig('BIGFIX_PASS');
            const stages = ['SANDBOX', 'PILOT', 'PRODUCTION'];
            for (const stage of stages) {
                const stageUserKey = `${stage}_BIGFIX_USER`;
                if (ctx.cfg[stageUserKey] && ctx.cfg[stageUserKey].toLowerCase() === username.toLowerCase()) {
                    await updateConfig(`${stage}_BIGFIX_PASS`);
                }
            }
        }

    } catch (error) {
        console.warn(` Warning: Failed to sync with BigFix: ${error.response?.data || error.message}`);
    }
}

async function resetAdmin() {
    const args = process.argv.slice(2);
    if (args.length < 2) {
        console.error("Usage: node src/scripts/reset-admin.js <username> <new_password>");
        process.exit(1);
    }

    const [username, newPassword] = args;

    try {
        console.log(`Attempting to reset password for user: ${username}...`);
        const pool = await getPool();

        const rs = await pool.request()
            .input('LoginName', sql.NVarChar(128), username)
            .query("SELECT UserID, Role FROM dbo.USERS WHERE LoginName=@LoginName");

        const userRecord = rs.recordset[0];
        
        if (!userRecord) {
            console.error(`User '${username}' not found in the database.`);
            process.exit(1);
        }

        if (userRecord.Role !== 'Admin') {
            console.error(` User '${username}' is not an Admin. Use the web UI to reset normal users.`);
            process.exit(1);
        }

        // 1. Sync BigFix First
        await syncBigFixAdminPassword(username, newPassword);

        // 2. Sync Local Database
        const hp = hashPassword(newPassword);
        const encPass = encrypt(newPassword);

        await pool.request()
            .input('Hash', sql.NVarChar(128), hp.hash)
            .input('Salt', sql.NVarChar(128), hp.salt)
            .input('BfEnc', sql.NVarChar(sql.MAX), encPass)
            .input('UID', sql.Int, userRecord.UserID)
            .query('UPDATE dbo.USERS SET PasswordHash=@Hash, PasswordSalt=@Salt, BfPasswordEncrypted=@BfEnc, UpdatedAt=SYSUTCDATETIME() WHERE UserID=@UID');

        console.log(` Success! Local Database updated.`);
        console.log("You can now log in using the new password.");
        process.exit(0);

    } catch (error) {
        console.error("An error occurred during the reset process:");
        console.error(error);
        process.exit(1);
    }
}

resetAdmin();