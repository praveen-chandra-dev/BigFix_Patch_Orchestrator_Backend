// src/controllers/password.controller.js
const { sql, getPool } = require('../db/mssql');
const { hashPassword, verifyPassword } = require('../utils/password');
const { encrypt } = require('../utils/crypto'); 
const { getSessionUserLocal } = require('../middlewares/auth.middleware');

const axios = require('axios');
const { getCtx, loadDbConfig } = require('../env'); // Added loadDbConfig
const { joinUrl } = require('../utils/http');

async function updateBigFixPassword(username, newPassword) {
    const ctx = getCtx();
    const { BIGFIX_BASE_URL, BIGFIX_USER, BIGFIX_PASS, httpsAgent } = ctx.bigfix;
    if (!BIGFIX_BASE_URL) return;

    const auth = { username: BIGFIX_USER, password: BIGFIX_PASS };
    const opUrl = joinUrl(BIGFIX_BASE_URL, `/api/operator/${encodeURIComponent(username)}`);

    try {
        const opResp = await axios.get(opUrl, { httpsAgent, auth, headers: { Accept: "application/xml" }});
        let xml = String(opResp.data);

        // 1. STRIP READ-ONLY TAGS (Fixes the 500 / 400 Bad Request error)
        xml = xml.replace(/<(LastLoginTime|ActionCount|ComputerCount|RoleCount|SiteCount|UserGroupCount|LogOnCount|LogOnCountSinceLast)[^>]*>.*?<\/\1>/gi, '');

        // 2. INJECT NEW PASSWORD
        if (xml.includes('<Password>')) {
            xml = xml.replace(/<Password>.*?<\/Password>/i, `<Password>${newPassword}</Password>`);
        } else {
            xml = xml.replace('</Name>', `</Name>\n        <Password>${newPassword}</Password>`);
        }

        // 3. PUSH TO BIGFIX
        await axios.put(opUrl, xml, { httpsAgent, auth, headers: { "Content-Type": "application/xml" }});

        // 4. PREVENT THE 401 LOCKOUT
        // If the user being reset is the global service account, update the global App Config!
        if (username.toLowerCase() === BIGFIX_USER.toLowerCase()) {
            console.log(`[Password Reset] Global Service Account password changed! Updating AppConfiguration...`);
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
            
            // Update stage configs if they share the same username
            const stages = ['SANDBOX', 'PILOT', 'PRODUCTION'];
            for (const stage of stages) {
                const stageUserKey = `${stage}_BIGFIX_USER`;
                if (ctx.cfg[stageUserKey] && ctx.cfg[stageUserKey].toLowerCase() === username.toLowerCase()) {
                    await updateConfig(`${stage}_BIGFIX_PASS`);
                }
            }
            
            // Force memory reload immediately so the backend doesn't crash with 401s
            await loadDbConfig();
        }

    } catch (error) {
        const errorDetails = error.response?.data ? String(error.response.data) : error.message;
        throw new Error(`BigFix API rejected the password update: ${errorDetails}`);
    }
}

async function resetPassword(req, res) {
    try {
        const { username, newPassword, resetLocal, resetBigFix } = req.body;
        
        if (!username || !newPassword) return res.status(400).json({ ok: false, error: 'bad_request', message: 'Username and new password required.' });
        if (!resetLocal && !resetBigFix) return res.status(400).json({ ok: false, error: 'bad_request', message: 'Must select at least one system to reset.' });

        const pool = await getPool();
        const rs = await pool.request().input('LoginName', sql.NVarChar(128), username).query('SELECT UserID, PasswordHash FROM dbo.USERS WHERE LoginName=@LoginName');
        const userRecord = rs.recordset[0];
        
        if (!userRecord) return res.status(404).json({ ok: false, error: 'not_found', message: 'User account does not exist.' });
        if (userRecord.PasswordHash === 'LDAP_AUTH') return res.status(400).json({ ok: false, error: 'ldap_user', message: 'LDAP Active Directory users cannot reset passwords here.' });

        const hp = hashPassword(newPassword);
        const encPass = encrypt(newPassword);

        let updateLocalHash = false;
        let updateBfEnc = false;

        // 1. Sync with BigFix if requested
        if (resetBigFix) {
            await updateBigFixPassword(username, newPassword);
            updateBfEnc = true; 
        }

        // 2. Sync Local Patch Setu Login if requested
        if (resetLocal) {
            updateLocalHash = true;
        }

        // 3. Dynamically build the SQL update query
        let query = 'UPDATE dbo.USERS SET UpdatedAt=SYSUTCDATETIME()';
        if (updateLocalHash) query += ', PasswordHash=@Hash, PasswordSalt=@Salt';
        if (updateBfEnc) query += ', BfPasswordEncrypted=@BfEnc';
        query += ' WHERE UserID=@UID';

        const reqObj = pool.request();
        reqObj.input('UID', sql.Int, userRecord.UserID);
        if (updateLocalHash) {
            reqObj.input('Hash', sql.NVarChar(128), hp.hash);
            reqObj.input('Salt', sql.NVarChar(128), hp.salt);
        }
        if (updateBfEnc) {
            reqObj.input('BfEnc', sql.NVarChar(sql.MAX), encPass);
        }

        await reqObj.query(query);

        res.json({ ok: true, message: 'Password reset applied successfully to the selected systems.' });
    } catch (e) { 
        res.status(500).json({ ok: false, error: 'server_error', message: e.message }); 
    }
}

async function changePassword(req, res) {
    const username = getSessionUserLocal(req);
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ ok: false, error: 'Missing fields' });

    try {
        const pool = await getPool();
        const rs = await pool.request().input('LoginName', sql.NVarChar(128), username).query('SELECT UserID, PasswordHash, PasswordSalt FROM dbo.USERS WHERE LoginName=@LoginName');
        const userRecord = rs.recordset[0];
        
        if (!userRecord) return res.status(404).json({ ok: false, error: 'User not found' });
        if (userRecord.PasswordHash === 'LDAP_AUTH') return res.status(400).json({ ok: false, error: 'LDAP users must change their password in Active Directory.' });
        if (userRecord.PasswordHash === 'SYSTEM_USER') return res.status(400).json({ ok: false, error: 'System users cannot change passwords.' });

        if (!verifyPassword(currentPassword, userRecord.PasswordSalt, userRecord.PasswordHash)) return res.status(400).json({ ok: false, error: 'Invalid current password.' });

        await updateBigFixPassword(username, newPassword);

        const hp = hashPassword(newPassword);
        const encPass = encrypt(newPassword);

        await pool.request().input('Hash', sql.NVarChar(128), hp.hash).input('Salt', sql.NVarChar(128), hp.salt).input('BfEnc', sql.NVarChar(sql.MAX), encPass).input('UID', sql.Int, userRecord.UserID)
            .query('UPDATE dbo.USERS SET PasswordHash=@Hash, PasswordSalt=@Salt, BfPasswordEncrypted=@BfEnc, UpdatedAt=SYSUTCDATETIME() WHERE UserID=@UID');

        res.json({ ok: true, message: 'Password updated successfully.' });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
}

module.exports = { resetPassword, changePassword };