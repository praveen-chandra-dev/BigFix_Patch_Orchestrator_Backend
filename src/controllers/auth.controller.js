const { sql, getPool } = require('../db/mssql');
const { verifyPassword } = require('../utils/password');
const { authenticateLDAP } = require('../services/ldap'); 
const { encrypt } = require('../utils/crypto'); 
const { getCfg } = require('../env'); 
const { getCookieOptions } = require('../middlewares/auth.middleware');

const createOperator = require('../services/bigfix/createOperator');
const assignRole = require('../services/bigfix/assignRole');
const verifyCredentials = require('../services/bigfix/verifyCredentials');

async function login(req, res) {
    try {
        const { username, password } = req.body || {};
        if (!username || !password) return res.status(400).json({ ok:false, error:'bad_request', message: 'Username and password required.' });

        const pool = await getPool();
        const ldapResult = await authenticateLDAP(username, password);
        const isLdapOk = ldapResult && ldapResult.authenticated;

        const rs = await pool.request().input('LoginName', sql.NVarChar(128), username).query('SELECT TOP 1 UserID, LoginName, PasswordHash, PasswordSalt, Role, BfPasswordEncrypted FROM dbo.USERS WHERE LoginName=@LoginName');
        let userRecord = rs.recordset[0];
        let authenticated = false;

        if (isLdapOk) {
            if (userRecord) authenticated = true;
            else return res.status(403).json({ ok: false, error: 'access_denied', message: 'Account not authorized.' });
        } else {
            if (userRecord && userRecord.PasswordHash && userRecord.PasswordHash !== 'LDAP_AUTH' && userRecord.PasswordHash !== 'SYSTEM_USER') {
                 try { if (verifyPassword(password, userRecord.PasswordSalt, userRecord.PasswordHash)) authenticated = true; } catch (err) {}
            }
            if (!authenticated && userRecord) {
                const isBigFixAuthOk = await verifyCredentials(username, password);
                if (isBigFixAuthOk) {
                    authenticated = true;
                    if (!userRecord.BfPasswordEncrypted) {
                        const encPass = encrypt(password);
                        if (encPass) await pool.request().input('Bf', sql.NVarChar(sql.MAX), encPass).input('UID', sql.Int, userRecord.UserID).query('UPDATE dbo.USERS SET BfPasswordEncrypted = @Bf WHERE UserID = @UID');
                    }
                }
            }
        }

        if (!authenticated) return res.status(401).json({ ok:false, error:'invalid', message: 'Invalid username or password.' });

        if (isLdapOk && !userRecord.BfPasswordEncrypted && ldapResult.dn) {
            try { await createOperator(username, true, null, ldapResult.dn, userRecord.Role === 'Admin'); } catch (e) { }
            const encPass = encrypt(password);
            if (encPass) await pool.request().input('Bf', sql.NVarChar(sql.MAX), encPass).input('UID', sql.Int, userRecord.UserID).query('UPDATE dbo.USERS SET BfPasswordEncrypted = @Bf WHERE UserID = @UID');
        } 

        if (userRecord && userRecord.Role && userRecord.Role !== 'Admin') await assignRole(username, userRecord.Role);

        const sessionData = { userId: userRecord.UserID, username: userRecord.LoginName, role: userRecord.Role, dbRole: userRecord.Role };
        const timeoutMins = Number(getCfg().SESSION_TIMEOUT) || 15;
        
        res.cookie('auth_session', JSON.stringify(sessionData), getCookieOptions());
        res.json({ ok:true, userId: userRecord.UserID, username: userRecord.LoginName, role: userRecord.Role, timeoutMins });
    } catch (e) { res.status(500).json({ ok:false, error:'server_error', message: e.message }); }
}

function logout(req, res) {
    res.clearCookie('auth_session', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' });
    res.json({ ok: true, message: 'Logged out' });
}

function status(req, res) {
    const timeoutMins = Number(getCfg().SESSION_TIMEOUT) || 15;
    if (req.cookies?.auth_session) {
        try {
            const sessionData = JSON.parse(req.cookies.auth_session);
            if (sessionData.userId && sessionData.username) return res.json({ ok: true, authed: true, userData: sessionData, timeoutMins });
        } catch (e) { return res.json({ ok: false, authed: false, timeoutMins }); }
    }
    return res.json({ ok: false, authed: false, timeoutMins });
}

module.exports = { login, logout, status };