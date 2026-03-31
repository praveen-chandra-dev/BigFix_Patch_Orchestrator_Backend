const { sql, getPool } = require('../db/mssql');
const { hashPassword } = require('../utils/password');
const { encrypt } = require('../utils/crypto'); 
const { logger } = require('../services/logger');

const createOperator = require('../services/bigfix/createOperator');
const assignRole = require('../services/bigfix/assignRole');
const verifyMasterOperator = require('../services/bigfix/verifyMasterOperator'); // Our new service!

const HASH_ALGORITHM = 'PBKDF2';

async function setupRequired(req, res) {
    try {
        const pool = await getPool();
        const rs = await pool.request().query("SELECT COUNT(*) as Count FROM dbo.USERS WHERE Role = 'Admin'");
        res.json({ ok: true, requiresSetup: rs.recordset[0].Count === 0 });
    } catch (e) { res.status(500).json({ ok: false, error: 'server_error' }); }
}

async function signup(req, res) {
    try {
        const { username, password, role, createBfOp } = req.body || {};
        if (!username || !password) return res.status(400).json({ ok:false, error:'bad_request' });

        const pool = await getPool();
        const adminCheck = await pool.request().query("SELECT COUNT(*) as Count FROM dbo.USERS WHERE Role = 'Admin'");
        const isFirstSetup = adminCheck.recordset[0].Count === 0;
        
        let finalRole = 'Windows';

        if (isFirstSetup) {
            // Use our cleanly extracted MO checking logic!
            const isMO = await verifyMasterOperator(username, password);
            
            if (!isMO) {
                return res.status(403).json({ ok: false, error: 'forbidden', message: 'The first user MUST be a Master Operator in BigFix. Your account does not have sufficient privileges or credentials are invalid.' });
            }

            const { saveEnvAndReload } = require('../env');
            await saveEnvAndReload({ BIGFIX_USER: username, BIGFIX_PASS: password });

            finalRole = 'Admin';
            logger.info(`[Setup] First user '${username}' verified as MO and saved as Global System Account.`);
        } else {
            // Note: Normal admins use the user.controller.js to add users. This is a fallback.
            finalRole = role || 'Windows';
        }
        
        const exists = await pool.request().input('LoginName', sql.NVarChar(128), username).query('SELECT 1 FROM dbo.USERS WHERE LoginName=@LoginName');
        if (exists.recordset.length) return res.status(409).json({ ok:false, error:'user_exists' });

        if (createBfOp && !isFirstSetup) await createOperator(username, false, password, null, true);

        // Get next ID
        const gapRes = await pool.request().query(`SELECT MIN(t1.UserID + 1) AS NextID FROM dbo.USERS t1 LEFT JOIN dbo.USERS t2 ON t1.UserID + 1 = t2.UserID WHERE t2.UserID IS NULL AND t1.UserID < 9000`);
        let nextId = gapRes.recordset[0].NextID;
        if (!nextId) {
            const maxRes = await pool.request().query('SELECT MAX(UserID) as MaxID FROM dbo.USERS WHERE UserID < 9000');
            nextId = (maxRes.recordset[0].MaxID || 0) + 1;
        }

        if (finalRole !== 'Admin') await assignRole(username, finalRole);

        const hp = hashPassword(password);
        const encPass = encrypt(password); 

        await pool.request()
            .input('UserID', sql.Int, nextId)
            .input('LoginName', sql.NVarChar(128), username)
            .input('PasswordHash', sql.NVarChar(128), hp.hash)
            .input('PasswordSalt', sql.NVarChar(128), hp.salt)
            .input('BfPasswordEncrypted', sql.NVarChar(sql.MAX), encPass)
            .input('HashAlgorithm', sql.NVarChar(12), HASH_ALGORITHM)
            .input('Role', sql.NVarChar(100), finalRole) 
            .query(`INSERT INTO dbo.USERS (UserID, LoginName, PasswordHash, PasswordSalt, HashAlgorithm, Role, BfPasswordEncrypted, CreatedAt, UpdatedAt) VALUES (@UserID, @LoginName, @PasswordHash, @PasswordSalt, @HashAlgorithm, @Role, @BfPasswordEncrypted, SYSUTCDATETIME(), SYSUTCDATETIME())`);

        res.json({ ok:true, userId: nextId, username, role: finalRole });
    } catch (e) { res.status(500).json({ ok:false, error:'server_error', message: e.message }); }
}

module.exports = { setupRequired, signup };