const { sql, getPool } = require('../../db/mssql');
const { hashPassword } = require('../../utils/password');
const { encrypt } = require('../../utils/crypto'); 
const { logger } = require('../../services/logger');

const createOperator = require('../../services/bigfix/createOperator');
const assignRole = require('../../services/bigfix/assignRole');

const HASH_ALGORITHM = 'PBKDF2';

async function addUser(req, res) {
    try {
        const { username, role, password } = req.body;
        if (!username || !role) return res.status(400).json({ ok: false, error: 'bad_request' });

        const isLdap = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(username);
        if (!isLdap && !password) return res.status(400).json({ ok: false, error: 'Password required for local users.' });

        const pool = await getPool();
        const exists = await pool.request().input('LoginName', sql.NVarChar(128), username).query('SELECT 1 FROM dbo.USERS WHERE LoginName=@LoginName');
        if (exists.recordset.length) return res.status(409).json({ ok:false, error:'user_exists', message: 'User already exists' });

        const gapRes = await pool.request().query(`SELECT MIN(t1.UserID + 1) AS NextID FROM dbo.USERS t1 LEFT JOIN dbo.USERS t2 ON t1.UserID + 1 = t2.UserID WHERE t2.UserID IS NULL AND t1.UserID < 9000`);
        let nextId = gapRes.recordset[0].NextID;
        if (!nextId) {
             const maxRes = await pool.request().query('SELECT MAX(UserID) as MaxID FROM dbo.USERS WHERE UserID < 9000');
             nextId = (maxRes.recordset[0].MaxID || 0) + 1;
        }

        const isMaster = role === 'Admin';

        if (!isLdap) {
            try {
                await createOperator(username, false, password, null, isMaster);
                if (!isMaster) await assignRole(username, role);
            } catch (bfErr) {
                logger.warn(`[RBAC] Local BigFix operator creation threw an error: ${bfErr.message}`);
            }
        } else {
            logger.info(`[RBAC] LDAP User '${username}' detected. Bypassing proactive BigFix creation.`);
        }

        let finalHash = 'LDAP_AUTH', finalSalt = 'LDAP_AUTH', finalAlgo = 'NONE', finalBfEnc = null;

        if (!isLdap) {
            const hp = hashPassword(password);
            finalHash = hp.hash; finalSalt = hp.salt; finalAlgo = HASH_ALGORITHM; finalBfEnc = encrypt(password);
        }

        await pool.request()
            .input('UserID', sql.Int, nextId)
            .input('LoginName', sql.NVarChar(128), username)
            .input('Role', sql.NVarChar(100), role)
            .input('PasswordHash', sql.NVarChar(128), finalHash)
            .input('PasswordSalt', sql.NVarChar(128), finalSalt)
            .input('HashAlgorithm', sql.NVarChar(12), finalAlgo)
            .input('BfPasswordEncrypted', sql.NVarChar(sql.MAX), finalBfEnc)
            .query(`INSERT INTO dbo.USERS (UserID, LoginName, Role, PasswordHash, PasswordSalt, HashAlgorithm, BfPasswordEncrypted, CreatedAt, UpdatedAt) VALUES (@UserID, @LoginName, @Role, @PasswordHash, @PasswordSalt, @HashAlgorithm, @BfPasswordEncrypted, SYSUTCDATETIME(), SYSUTCDATETIME())`);

        res.json({ ok: true, message: `User saved successfully.` });
    } catch (e) { res.status(500).json({ ok: false, error: 'server_error', message: e.message }); }
}

module.exports = addUser;