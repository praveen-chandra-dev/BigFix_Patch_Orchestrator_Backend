const { sql, getPool } = require('../db/mssql');
const { encrypt, decrypt } = require('../utils/crypto'); 
const { getSessionUserLocal } = require('../middlewares/auth.middleware');
const verifyCredentials = require('../services/bigfix/verifyCredentials');

async function getMyBigFixCreds(req, res) {
    const username = getSessionUserLocal(req);
    try {
        const pool = await getPool();
        const rs = await pool.request().input('LoginName', sql.NVarChar(128), username).query('SELECT BfPasswordEncrypted FROM dbo.USERS WHERE LoginName = @LoginName');

        if (rs.recordset.length > 0 && rs.recordset[0].BfPasswordEncrypted) {
            const decPass = decrypt(rs.recordset[0].BfPasswordEncrypted);
            if (decPass) return res.json({ ok: true, username, hasCreds: true });
        }
        res.json({ ok: true, username, hasCreds: false });
    } catch (e) { res.status(500).json({ ok: false, error: 'db_error', message: e.message }); }
}

async function updateMyBigFixCreds(req, res) {
    const username = getSessionUserLocal(req);
    const { bfPassword } = req.body;

    if (!bfPassword) return res.status(400).json({ ok: false, error: 'Password required' });

    try {
        const isValid = await verifyCredentials(username, bfPassword);
        if (!isValid) return res.status(401).json({ ok: false, error: 'BigFix API rejected the credentials.' });

        const encryptedPass = encrypt(bfPassword);
        if (!encryptedPass) return res.status(500).json({ ok: false, error: 'Encryption failed' });

        const pool = await getPool();
        await pool.request()
            .input('LoginName', sql.NVarChar(128), username)
            .input('BfEncrypted', sql.NVarChar(sql.MAX), encryptedPass)
            .query('UPDATE dbo.USERS SET BfPasswordEncrypted = @BfEncrypted, UpdatedAt = SYSUTCDATETIME() WHERE LoginName = @LoginName');

        res.json({ ok: true, message: 'Personal BigFix credentials verified and saved successfully.' });
    } catch (e) { res.status(500).json({ ok: false, error: 'db_error', message: e.message }); }
}

module.exports = { getMyBigFixCreds, updateMyBigFixCreds };