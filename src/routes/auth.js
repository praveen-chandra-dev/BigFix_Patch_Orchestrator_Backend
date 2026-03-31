// // src/routes/auth.js
// const express = require('express');
// const router  = express.Router();
// const axios = require('axios');

// const { sql, getPool } = require('../db/mssql');
// const { hashPassword, verifyPassword } = require('../utils/password');
// const { authenticateLDAP } = require('../services/ldap'); 
// const { encrypt, decrypt } = require('../utils/crypto'); 
// const { getCtx, getCfg } = require('../env'); 
// const { joinUrl } = require('../utils/http');
// const { logger } = require('../services/logger');

// const HASH_ALGORITHM = 'PBKDF2';

// router.use(express.json({ limit: '1mb' }));

// function getSessionData(req) {
//     if (!req.cookies || !req.cookies.auth_session) return null;
//     try { return JSON.parse(req.cookies.auth_session); } catch { return null; }
// }

// function isAdmin(req) {
//   if (!req.cookies.auth_session) return false;
//   try {
//     const session = JSON.parse(req.cookies.auth_session);
//     // Check permanent dbRole first, fallback to role, making it case-insensitive
//     const role = session.dbRole || session.role;
//     return role && role.toLowerCase() === 'admin';
//   } catch { return false; }
// }

// function getCookieOptions() {
//     const timeoutMins = Number(getCfg().SESSION_TIMEOUT) || 15;
//     return {
//         maxAge: timeoutMins * 60 * 1000, // Converts minutes to milliseconds
//         httpOnly: true,
//         secure: process.env.NODE_ENV === 'production',
//         sameSite: 'lax'
//     };
// }

// function isValidLDAPUser(username) {
//     if (!username) return false;
//     const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
//     return emailRegex.test(username);
// }

// async function createBigFixOperator(username, isLdap, plainPassword = null, ldapDN = null, isMaster = false) {
//     const ctx = getCtx();
//     const { BIGFIX_BASE_URL, BIGFIX_USER, BIGFIX_PASS, httpsAgent } = ctx.bigfix;
    
//     if (!BIGFIX_BASE_URL) return false;

//     const postUrl = joinUrl(BIGFIX_BASE_URL, "/api/operators");
//     let xml = "";

//     if (!isLdap) {
//         xml = `<?xml version="1.0" encoding="UTF-8"?><BESAPI xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="BESAPI.xsd"><Operator><Name>${username}</Name><Password>${plainPassword}</Password><MasterOperator>${isMaster ? 'true' : 'false'}</MasterOperator></Operator></BESAPI>`;
//     } else {
//         if (!ldapDN) {
//             logger.warn(`[RBAC] LDAP DN missing for ${username}. Cannot create BigFix operator.`);
//             return false;
//         }

//         const dirUrl = joinUrl(BIGFIX_BASE_URL, "/api/ldapdirectories");
//         let dirResp;
//         try {
//             dirResp = await axios.get(dirUrl, {
//                 httpsAgent, auth: { username: BIGFIX_USER, password: BIGFIX_PASS }, headers: { Accept: "application/xml" }
//             });
//         } catch (e) {
//             logger.warn(`[RBAC] Failed to query BigFix LDAP Directories. Ensure AD is integrated in BigFix.`);
//             return false; 
//         }
        
//         let serverId = null;
//         if (dirResp.data) {
//             const resData = String(dirResp.data);
//             const idMatch = resData.match(/<ID>(\d+)<\/ID>/i);
//             if (idMatch) serverId = idMatch[1];
//         }

//         if (!serverId) {
//             logger.warn(`[RBAC] Could not locate LDAP Server ID in BigFix. Cannot create LDAP user.`);
//             return false;
//         }
        
//         xml = `<?xml version="1.0" encoding="UTF-8"?><BESAPI xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="BESAPI.xsd"><Operator><Name>${username}</Name><LDAPServerID>${serverId}</LDAPServerID><LDAPDN>${ldapDN}</LDAPDN><MasterOperator>${isMaster ? 'true' : 'false'}</MasterOperator></Operator></BESAPI>`;
//     }

//     try {
//         const resp = await axios.post(postUrl, xml, {
//             httpsAgent, auth: { username: BIGFIX_USER, password: BIGFIX_PASS }, headers: { "Content-Type": "application/xml" }
//         });
//         return resp.status === 200;
//     } catch (e) {
//         const errBody = e.response?.data ? String(e.response.data) : e.message;
//         if (errBody.includes("already exists") || errBody.includes("unique constraint")) return true; 
//         logger.warn(`[RBAC] BigFix rejected operator creation: ${errBody.substring(0, 150)}`);
//         return false;
//     }
// }

// async function assignUserToRole(username, roleName) {
//     if (!roleName || roleName === 'Admin') return true; 

//     const ctx = getCtx();
//     const { BIGFIX_BASE_URL, BIGFIX_USER, BIGFIX_PASS, httpsAgent } = ctx.bigfix;
    
//     if (!BIGFIX_BASE_URL) return false;

//     const auth = { username: BIGFIX_USER, password: BIGFIX_PASS };

//     try {
//         const rolesUrl = joinUrl(BIGFIX_BASE_URL, `/api/roles`);
//         const rolesResp = await axios.get(rolesUrl, { httpsAgent, auth, headers: { Accept: "application/xml" }, validateStatus: () => true });
        
//         let roleId = null;
//         if (rolesResp.status === 200) {
//             const xmlData = String(rolesResp.data || "");
//             const roleBlocks = xmlData.split("</Role>");
//             for (const block of roleBlocks) {
//                 if (block.includes(`<Name>${roleName}</Name>`) || block.includes(`>${roleName}<`)) {
//                     const idMatch = block.match(/<ID>(\d+)<\/ID>/i);
//                     if (idMatch) { roleId = idMatch[1]; break; }
//                 }
//             }
//         }

//         if (!roleId) return false;

//         const roleUrl = joinUrl(BIGFIX_BASE_URL, `/api/role/${roleId}`);
//         const roleResp = await axios.get(roleUrl, { httpsAgent, auth, headers: { Accept: "application/xml" }, validateStatus: () => true });

//         if (roleResp.status === 200) {
//             let roleXml = String(roleResp.data);
//             const explicitTag = `<Explicit>${username}</Explicit>`;
            
//             if (roleXml.includes(explicitTag)) return true;

//             roleXml = roleXml.replace(/<Operators\s*\/>/gi, '');

//             if (roleXml.includes('<Operators>')) {
//                 roleXml = roleXml.replace('<Operators>', `<Operators>\n<Explicit>${username}</Explicit>`);
//             } else {
//                 roleXml = roleXml.replace('</Role>', `<Operators>\n<Explicit>${username}</Explicit>\n</Operators>\n</Role>`);
//             }

//             await axios.put(roleUrl, roleXml, { httpsAgent, auth, headers: { "Content-Type": "application/xml" } });
//             return true;
//         }
//     } catch (err) {
//         if (err.response && err.response.status === 400) return false; 
//         logger.warn(`[RBAC] Failed to assign user to role in BigFix: ${err.message}`);
//         return false;
//     }
//     return false;
// }

// async function unassignUserFromRole(username, roleName) {
//     if (!roleName || roleName === 'Admin') return true;

//     const ctx = getCtx();
//     const { BIGFIX_BASE_URL, BIGFIX_USER, BIGFIX_PASS, httpsAgent } = ctx.bigfix;
//     if (!BIGFIX_BASE_URL) return false;

//     const auth = { username: BIGFIX_USER, password: BIGFIX_PASS };

//     try {
//         const rolesUrl = joinUrl(BIGFIX_BASE_URL, `/api/roles`);
//         const rolesResp = await axios.get(rolesUrl, { httpsAgent, auth, headers: { Accept: "application/xml" }, validateStatus: () => true });
        
//         let roleId = null;
//         if (rolesResp.status === 200) {
//             const xmlData = String(rolesResp.data || "");
//             const roleBlocks = xmlData.split("</Role>");
//             for (const block of roleBlocks) {
//                 if (block.includes(`<Name>${roleName}</Name>`) || block.includes(`>${roleName}<`)) {
//                     const idMatch = block.match(/<ID>(\d+)<\/ID>/i);
//                     if (idMatch) { roleId = idMatch[1]; break; }
//                 }
//             }
//         }

//         if (!roleId) return false;

//         const roleUrl = joinUrl(BIGFIX_BASE_URL, `/api/role/${roleId}`);
//         const roleResp = await axios.get(roleUrl, { httpsAgent, auth, headers: { Accept: "application/xml" }, validateStatus: () => true });

//         if (roleResp.status === 200) {
//             let roleXml = String(roleResp.data);
            
//             // SAFER REGEX: Matches `<Explicit>username</Explicit>` ignoring all surrounding whitespace/newlines
//             const explicitRegex = new RegExp(`<Explicit>\\s*${username}\\s*</Explicit>`, 'gi');
            
//             if (!explicitRegex.test(roleXml)) {
//                 return true; // User is already not in this role
//             }

//             // Remove the user
//             roleXml = roleXml.replace(explicitRegex, '');
            
//             // Clean up empty operator blocks (removes <Operators></Operators> if nothing is left inside)
//             roleXml = roleXml.replace(/<Operators>\s*<\/Operators>/g, '<Operators/>');

//             await axios.put(roleUrl, roleXml, { httpsAgent, auth, headers: { "Content-Type": "application/xml" } });
//             return true;
//         }
//     } catch (err) {
//         logger.warn(`[RBAC] Failed to unassign user from old role in BigFix: ${err.message}`);
//         return false;
//     }
//     return false;
// }

// async function verifyBigFixCredentials(username, password) {
//     const ctx = getCtx();
//     const { BIGFIX_BASE_URL, httpsAgent } = ctx.bigfix;
    
//     if (!BIGFIX_BASE_URL) {
//         logger.error(`[BigFix Auth] FAILED: BIGFIX_BASE_URL is not configured yet.`);
//         return false;
//     }

//     try {
//         logger.info(`[BigFix Auth] Verifying BigFix credentials for operator: '${username}'...`);
//         const url = joinUrl(BIGFIX_BASE_URL, '/api/login');
//         await axios.get(url, { httpsAgent, auth: { username, password } });
//         logger.info(`[BigFix Auth] SUCCESS! Credentials accepted for '${username}'.`);
//         return true; 
//     } catch (e) { 
//         const status = e.response ? e.response.status : 'Network Error';
//         logger.error(`[BigFix Auth] FAILED for operator '${username}'. API returned Status: ${status}`);
//         return false; 
//     }
// }

// router.get('/api/auth/all-roles', async (req, res) => {
//     try {
//         if (!isAdmin(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
//         const ctx = getCtx();
//         const { BIGFIX_BASE_URL, BIGFIX_USER, BIGFIX_PASS, httpsAgent } = ctx.bigfix;
        
//         if (!BIGFIX_BASE_URL) return res.json({ ok: true, roles: [] });

//         const auth = { username: BIGFIX_USER, password: BIGFIX_PASS };
        
//         const rolesUrl = joinUrl(BIGFIX_BASE_URL, `/api/roles`);
//         const rolesResp = await axios.get(rolesUrl, { httpsAgent, auth, headers: { Accept: "application/xml" }, validateStatus: () => true });
        
//         let allRoles = [];
//         if (rolesResp.status === 200) {
//             const xmlData = String(rolesResp.data || "");
//             const roleBlocks = xmlData.split("</Role>");
//             for (const block of roleBlocks) {
//                 const nameMatch = block.match(/<Name>(.*?)<\/Name>/i);
//                 if (nameMatch) allRoles.push(nameMatch[1].trim());
//             }
//         }
//         res.json({ ok: true, roles: allRoles });
//     } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
// });

// router.get('/api/auth/roles', async (req, res) => {
//     const session = getSessionData(req);
//     if (!session) return res.status(401).json({ ok: false, error: 'Unauthorized' });

//     try {
//         const ctx = getCtx();
//         const { BIGFIX_BASE_URL, BIGFIX_USER, BIGFIX_PASS, httpsAgent } = ctx.bigfix;
        
//         const actualRole = session.dbRole || session.role;
//         const isAdminUser = actualRole && actualRole.toLowerCase() === 'admin';

//         if (!BIGFIX_BASE_URL) {
//             return res.json({ ok: true, isMO: isAdminUser, roles: isAdminUser ? ['Admin'] : [] });
//         }

//         const auth = { username: BIGFIX_USER, password: BIGFIX_PASS };
        
//         let isMO = false;
//         let roles = [];

//         const opUrl = joinUrl(BIGFIX_BASE_URL, `/api/operator/${encodeURIComponent(session.username)}`);
//         const opResp = await axios.get(opUrl, { httpsAgent, auth, headers: { Accept: "application/xml" }, validateStatus: () => true });
        
//         if (opResp.status === 200) {
//             const xml = String(opResp.data || "");
//             const moMatch = xml.match(/<MasterOperator>(.*?)<\/MasterOperator>/i);
//             if (moMatch) isMO = moMatch[1].trim().toLowerCase() === "true" || moMatch[1].trim() === "1";
//         }
        
//         const rolesUrl = joinUrl(BIGFIX_BASE_URL, `/api/operator/${encodeURIComponent(session.username)}/roles`);
//         const rolesResp = await axios.get(rolesUrl, { httpsAgent, auth, headers: { Accept: "application/xml" }, validateStatus: () => true });

//         if (rolesResp.status === 200) {
//             const xml = String(rolesResp.data || "");
//             const roleBlocks = xml.split("</Role>");
//             for (const block of roleBlocks) {
//                 const match = block.match(/<Name>(.*?)<\/Name>/i);
//                 if (match) roles.push(match[1].trim());
//             }
//         }

//         if (isAdminUser) {
//             roles = ['Admin']; 
//         } else {
//             roles = [...new Set(roles)]; 
//         }

//         res.json({ ok: true, isMO, roles });
//     } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
// });

// router.get('/api/auth/team-state', async (req, res) => {
//     const session = getSessionData(req);
//     if (!session) return res.status(401).json({ ok: false, error: 'Unauthorized' });

//     let activeRole = req.query.role || req.headers['x-user-role'] || session.role;
//     if (!activeRole) return res.status(400).json({ ok: false, error: 'No active role provided' });

//     const primaryRole = session.dbRole || session.role;
//     if (primaryRole && primaryRole.toLowerCase() === 'admin') {
//         session.role = 'Admin';
//         activeRole = 'Admin'; 
//     } else {
//         session.role = activeRole;
//     }
//     res.cookie('auth_session', JSON.stringify(session), getCookieOptions());

//     try {
//         const pool = await getPool();
//         const roleBucket = `Role_${activeRole}`;
        
//         const stateRes = await pool.request().input('RoleKey', sql.NVarChar(50), roleBucket).query("SELECT StateValue FROM dbo.SystemState WHERE StateKey = @RoleKey");

//         let rawState = "{}";
//         if (stateRes.recordset.length > 0) rawState = stateRes.recordset[0].StateValue || "{}";
//         else await pool.request().input('RoleKey', sql.NVarChar(50), roleBucket).query("INSERT INTO dbo.SystemState (StateKey, StateValue) VALUES (@RoleKey, '{}')");
        
//         res.json({ ok: true, role: activeRole, state: JSON.parse(rawState) });
//     } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
// });

// router.post('/api/auth/team-state', async (req, res) => {
//     const session = getSessionData(req);
//     if (!session) return res.status(401).json({ ok: false, error: 'Unauthorized' });

//     let activeRole = req.query.role || req.headers['x-user-role'] || session.role;
//     if (!activeRole) return res.status(400).json({ ok: false, error: 'No active role provided' });

//     const primaryRole = session.dbRole || session.role;
//     if (primaryRole && primaryRole.toLowerCase() === 'admin') {
//         session.role = 'Admin';
//         activeRole = 'Admin';
//     } else {
//         session.role = activeRole;
//     }
//     res.cookie('auth_session', JSON.stringify(session), getCookieOptions());

//     try {
//         const stateStr = JSON.stringify(req.body);
//         const pool = await getPool();
//         const roleBucket = `Role_${activeRole}`;

//         const updateRes = await pool.request().input('Val', sql.NVarChar(sql.MAX), stateStr).input('RoleKey', sql.NVarChar(50), roleBucket).query("UPDATE dbo.SystemState SET StateValue = @Val WHERE StateKey = @RoleKey");
//         if (updateRes.rowsAffected[0] === 0) await pool.request().input('Val', sql.NVarChar(sql.MAX), stateStr).input('RoleKey', sql.NVarChar(50), roleBucket).query("INSERT INTO dbo.SystemState (StateKey, StateValue) VALUES (@RoleKey, @Val)");
        
//         res.json({ ok: true, saved: true, role: activeRole });
//     } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
// });

// function getSessionUserLocal(req) {
//     if (!req.cookies || !req.cookies.auth_session) return null;
//     try { return JSON.parse(req.cookies.auth_session).username; } catch { return null; }
// }

// router.post('/api/auth/reset-password', async (req, res) => {
//     try {
//         const { username, newPassword } = req.body;
//         if (!username || !newPassword) return res.status(400).json({ ok: false, error: 'bad_request', message: 'Username and new password required.' });

//         const pool = await getPool();
//         const rs = await pool.request()
//             .input('LoginName', sql.NVarChar(128), username)
//             .query('SELECT UserID, PasswordHash FROM dbo.USERS WHERE LoginName=@LoginName');
        
//         const userRecord = rs.recordset[0];
//         if (!userRecord) return res.status(404).json({ ok: false, error: 'not_found', message: 'User account does not exist.' });
        
//         if (userRecord.PasswordHash === 'LDAP_AUTH') {
//             return res.status(400).json({ ok: false, error: 'ldap_user', message: 'LDAP Active Directory users cannot reset passwords here. Please reset via Windows.' });
//         }

//         const hp = hashPassword(newPassword);
//         const encPass = encrypt(newPassword);

//         await pool.request()
//             .input('Hash', sql.NVarChar(128), hp.hash)
//             .input('Salt', sql.NVarChar(128), hp.salt)
//             .input('BfEnc', sql.NVarChar(sql.MAX), encPass)
//             .input('UID', sql.Int, userRecord.UserID)
//             .query('UPDATE dbo.USERS SET PasswordHash=@Hash, PasswordSalt=@Salt, BfPasswordEncrypted=@BfEnc, UpdatedAt=SYSUTCDATETIME() WHERE UserID=@UID');

//         res.json({ ok: true, message: 'Password reset successfully. You can now log in.' });
//     } catch (e) {
//         res.status(500).json({ ok: false, error: 'server_error', message: e.message });
//     }
// });

// router.post('/api/auth/change-password', async (req, res) => {
//     const username = getSessionUserLocal(req);
//     if (!username) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    
//     const { currentPassword, newPassword } = req.body;
//     if (!currentPassword || !newPassword) return res.status(400).json({ ok: false, error: 'Missing fields' });

//     try {
//         const pool = await getPool();
//         const rs = await pool.request().input('LoginName', sql.NVarChar(128), username).query('SELECT UserID, PasswordHash, PasswordSalt FROM dbo.USERS WHERE LoginName=@LoginName');
//         const userRecord = rs.recordset[0];
        
//         if (!userRecord) return res.status(404).json({ ok: false, error: 'User not found' });
//         if (userRecord.PasswordHash === 'LDAP_AUTH') return res.status(400).json({ ok: false, error: 'LDAP users must change their password in Active Directory.' });
//         if (userRecord.PasswordHash === 'SYSTEM_USER') return res.status(400).json({ ok: false, error: 'System users cannot change passwords.' });

//         if (!verifyPassword(currentPassword, userRecord.PasswordSalt, userRecord.PasswordHash)) return res.status(400).json({ ok: false, error: 'Invalid current password.' });

//         const hp = hashPassword(newPassword);
//         await pool.request().input('Hash', sql.NVarChar(128), hp.hash).input('Salt', sql.NVarChar(128), hp.salt).input('UID', sql.Int, userRecord.UserID)
//             .query('UPDATE dbo.USERS SET PasswordHash=@Hash, PasswordSalt=@Salt, UpdatedAt=SYSUTCDATETIME() WHERE UserID=@UID');

//         res.json({ ok: true, message: 'Password updated successfully.' });
//     } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
// });

// router.get('/api/auth/my-bigfix-creds', async (req, res) => {
//     const username = getSessionUserLocal(req);
//     if (!username) return res.status(401).json({ ok: false, error: 'Unauthorized' });

//     try {
//         const pool = await getPool();
//         const rs = await pool.request()
//             .input('LoginName', sql.NVarChar(128), username)
//             .query('SELECT BfPasswordEncrypted FROM dbo.USERS WHERE LoginName = @LoginName');

//         if (rs.recordset.length > 0 && rs.recordset[0].BfPasswordEncrypted) {
//             const decPass = decrypt(rs.recordset[0].BfPasswordEncrypted);
//             if (decPass) {
//                 // We don't actually need the password, just that it decrypts
//                 return res.json({ ok: true, username, hasCreds: true });
//             }
//         }
//         res.json({ ok: true, username, hasCreds: false });
//     } catch (e) {
//         res.status(500).json({ ok: false, error: 'db_error', message: e.message });
//     }
// });

// router.post('/api/auth/my-bigfix-creds', async (req, res) => {
//     const username = getSessionUserLocal(req);
//     const { bfPassword } = req.body;

//     if (!username) return res.status(401).json({ ok: false, error: 'Unauthorized' });
//     if (!bfPassword) return res.status(400).json({ ok: false, error: 'Password required' });

//     try {
//         // Verify credentials against BigFix
//         const isValid = await verifyBigFixCredentials(username, bfPassword);
//         if (!isValid) {
//             return res.status(401).json({ ok: false, error: 'BigFix API rejected the credentials. Check backend terminal logs for exact reason.' });
//         }

//         // Encrypt and verify
//         const encryptedPass = encrypt(bfPassword);
//         if (!encryptedPass) {
//             return res.status(500).json({ ok: false, error: 'Encryption failed' });
//         }

//         const testDecrypt = decrypt(encryptedPass);
//         if (testDecrypt !== bfPassword) {
//             console.error(`[Auth] Encryption verification failed for user ${username}`);
//             return res.status(500).json({ ok: false, error: 'Encryption verification failed' });
//         }

//         const pool = await getPool();
//         await pool.request()
//             .input('LoginName', sql.NVarChar(128), username)
//             .input('BfEncrypted', sql.NVarChar(sql.MAX), encryptedPass)
//             .query('UPDATE dbo.USERS SET BfPasswordEncrypted = @BfEncrypted, UpdatedAt = SYSUTCDATETIME() WHERE LoginName = @LoginName');

//         res.json({ ok: true, message: 'Personal BigFix credentials verified and saved successfully.' });
//     } catch (e) {
//         res.status(500).json({ ok: false, error: 'db_error', message: e.message });
//     }
// });

// router.get('/api/auth/setup-required', async (req, res) => {
//   try {
//     const pool = await getPool();
//     const rs = await pool.request().query("SELECT COUNT(*) as Count FROM dbo.USERS WHERE Role = 'Admin'");
//     res.json({ ok: true, requiresSetup: rs.recordset[0].Count === 0 });
//   } catch (e) { res.status(500).json({ ok: false, error: 'server_error' }); }
// });

// router.post('/api/auth/signup', async (req, res) => {
//   try {
//     const { username, password, role, createBfOp } = req.body || {};
//     if (!username || !password) return res.status(400).json({ ok:false, error:'bad_request' });

//     const pool = await getPool();
//     const adminCheck = await pool.request().query("SELECT COUNT(*) as Count FROM dbo.USERS WHERE Role = 'Admin'");
//     const isFirstSetup = adminCheck.recordset[0].Count === 0;
    
//     let finalRole = 'Windows';

//     if (isFirstSetup) {
//         const ctx = getCtx();
//         const { BIGFIX_BASE_URL, httpsAgent } = ctx.bigfix;
        
//         try {
//             const loginUrl = joinUrl(BIGFIX_BASE_URL, '/api/login');
//             await axios.get(loginUrl, { httpsAgent, auth: { username, password } });

//             const opUrl = joinUrl(BIGFIX_BASE_URL, `/api/operator/${encodeURIComponent(username)}`);
//             const opResp = await axios.get(opUrl, { 
//                 httpsAgent, 
//                 auth: { username, password }, 
//                 headers: { Accept: "application/xml" },
//                 validateStatus: () => true
//             });

//             if (opResp.status === 403 || opResp.status === 401) {
//                 return res.status(403).json({ ok: false, error: 'forbidden', message: 'The first user MUST be a Master Operator in BigFix. Your account does not have sufficient privileges.' });
//             }

//             if (opResp.status !== 200) throw new Error("Operator fetch failed.");

//             const xml = String(opResp.data || "");
//             const moMatch = xml.match(/<MasterOperator>(.*?)<\/MasterOperator>/i);
//             const isMO = moMatch && (moMatch[1].trim().toLowerCase() === "true" || moMatch[1].trim() === "1");

//             if (!isMO) {
//                 return res.status(403).json({ ok: false, error: 'forbidden', message: 'The first user MUST be a Master Operator in BigFix.' });
//             }

//             const { saveEnvAndReload } = require('../env');
//             await saveEnvAndReload({
//                 BIGFIX_USER: username,
//                 BIGFIX_PASS: password
//             });

//             finalRole = 'Admin';
//             logger.info(`[Setup] First user '${username}' verified as MO and saved as Global System Account.`);

//         } catch (err) {
//             return res.status(401).json({ ok: false, error: 'invalid_credentials', message: 'Invalid BigFix credentials or unable to connect to BigFix.' });
//         }
//     } else {
//         if (!isAdmin(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
//         finalRole = role || 'Windows';
//     }
    
//     const exists = await pool.request().input('LoginName', sql.NVarChar(128), username).query('SELECT 1 FROM dbo.USERS WHERE LoginName=@LoginName');
//     if (exists.recordset.length) return res.status(409).json({ ok:false, error:'user_exists' });

//     if (createBfOp && !isFirstSetup) await createBigFixOperator(username, false, password, null, true);

//     const gapRes = await pool.request().query(`SELECT MIN(t1.UserID + 1) AS NextID FROM dbo.USERS t1 LEFT JOIN dbo.USERS t2 ON t1.UserID + 1 = t2.UserID WHERE t2.UserID IS NULL AND t1.UserID < 9000`);
//     let nextId = gapRes.recordset[0].NextID;
//     if (!nextId) {
//         const maxRes = await pool.request().query('SELECT MAX(UserID) as MaxID FROM dbo.USERS WHERE UserID < 9000');
//         nextId = (maxRes.recordset[0].MaxID || 0) + 1;
//     }

//     if (finalRole !== 'Admin') await assignUserToRole(username, finalRole);

//     const hp = hashPassword(password);
//     const encPass = encrypt(password); 

//     await pool.request()
//       .input('UserID', sql.Int, nextId)
//       .input('LoginName', sql.NVarChar(128), username)
//       .input('PasswordHash', sql.NVarChar(128), hp.hash)
//       .input('PasswordSalt', sql.NVarChar(128), hp.salt)
//       .input('BfPasswordEncrypted', sql.NVarChar(sql.MAX), encPass)
//       .input('HashAlgorithm', sql.NVarChar(12), HASH_ALGORITHM)
//       .input('Role', sql.NVarChar(100), finalRole) 
//       .query(`INSERT INTO dbo.USERS (UserID, LoginName, PasswordHash, PasswordSalt, HashAlgorithm, Role, BfPasswordEncrypted, CreatedAt, UpdatedAt) VALUES (@UserID, @LoginName, @PasswordHash, @PasswordSalt, @HashAlgorithm, @Role, @BfPasswordEncrypted, SYSUTCDATETIME(), SYSUTCDATETIME())`);

//     res.json({ ok:true, userId: nextId, username, role: finalRole });
//   } catch (e) { res.status(500).json({ ok:false, error:'server_error', message: e.message }); }
// });

// router.post('/api/auth/login', async (req, res) => {
//   try {
//     const { username, password } = req.body || {};
//     if (!username || !password) return res.status(400).json({ ok:false, error:'bad_request', message: 'Username and password required.' });

//     const pool = await getPool();
//     const ldapResult = await authenticateLDAP(username, password);
//     const isLdapOk = ldapResult && ldapResult.authenticated;

//     const rs = await pool.request().input('LoginName', sql.NVarChar(128), username).query('SELECT TOP 1 UserID, LoginName, PasswordHash, PasswordSalt, Role, BfPasswordEncrypted FROM dbo.USERS WHERE LoginName=@LoginName');
//     let userRecord = rs.recordset[0];
//     let authenticated = false;

//     if (isLdapOk) {
//         if (userRecord) authenticated = true;
//         else return res.status(403).json({ ok: false, error: 'access_denied', message: 'Account not authorized.' });
//     } else {
//         if (userRecord && userRecord.PasswordHash && userRecord.PasswordHash !== 'LDAP_AUTH' && userRecord.PasswordHash !== 'SYSTEM_USER') {
//              try { if (verifyPassword(password, userRecord.PasswordSalt, userRecord.PasswordHash)) authenticated = true; } catch (err) {}
//         }
        
//         if (!authenticated && userRecord) {
//             const isBigFixAuthOk = await verifyBigFixCredentials(username, password);
//             if (isBigFixAuthOk) {
//                 authenticated = true;
//                 if (!userRecord.BfPasswordEncrypted) {
//                     const encPass = encrypt(password);
//                     if (encPass) await pool.request().input('Bf', sql.NVarChar(sql.MAX), encPass).input('UID', sql.Int, userRecord.UserID).query('UPDATE dbo.USERS SET BfPasswordEncrypted = @Bf WHERE UserID = @UID');
//                 }
//             }
//         }
//     }

//     if (!authenticated) return res.status(401).json({ ok:false, error:'invalid', message: 'Invalid username or password.' });

//     if (isLdapOk && !userRecord.BfPasswordEncrypted && ldapResult.dn) {
//         try { await createBigFixOperator(username, true, null, ldapResult.dn, userRecord.Role === 'Admin'); } catch (e) { }
//         const encPass = encrypt(password);
//         if (encPass) await pool.request().input('Bf', sql.NVarChar(sql.MAX), encPass).input('UID', sql.Int, userRecord.UserID).query('UPDATE dbo.USERS SET BfPasswordEncrypted = @Bf WHERE UserID = @UID');
//     } 

//     if (userRecord && userRecord.Role && userRecord.Role !== 'Admin') {
//         await assignUserToRole(username, userRecord.Role);
//     }

//     const sessionData = { 
//         userId: userRecord.UserID, 
//         username: userRecord.LoginName, 
//         role: userRecord.Role,
//         dbRole: userRecord.Role 
//     };
    
//     const timeoutMins = Number(getCfg().SESSION_TIMEOUT) || 15;
    
//     res.cookie('auth_session', JSON.stringify(sessionData), getCookieOptions());
//     res.json({ ok:true, userId: userRecord.UserID, username: userRecord.LoginName, role: userRecord.Role, timeoutMins });
//   } catch (e) { res.status(500).json({ ok:false, error:'server_error', message: e.message }); }
// });

// router.post('/api/auth/logout', (req, res) => {
//   res.clearCookie('auth_session', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' });
//   res.json({ ok: true, message: 'Logged out' });
// });

// router.get('/api/auth/status', (req, res) => {
//   const timeoutMins = Number(getCfg().SESSION_TIMEOUT) || 15;

//   if (req.cookies?.auth_session) {
//     try {
//       const sessionData = JSON.parse(req.cookies.auth_session);
//       if (sessionData.userId && sessionData.username) {
//           return res.json({ ok: true, authed: true, userData: sessionData, timeoutMins });
//       }
//     } catch (e) { return res.json({ ok: false, authed: false, timeoutMins }); }
//   }
//   return res.json({ ok: false, authed: false, timeoutMins });
// });

// router.post('/api/auth/admin/add-user', async (req, res) => {
//     try {
//         if (!isAdmin(req)) return res.status(403).json({ ok: false, error: 'forbidden' });

//         const { username, role, password } = req.body;
//         if (!username || !role) return res.status(400).json({ ok: false, error: 'bad_request' });

//         const isLdap = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(username);
        
//         if (!isLdap && !password) return res.status(400).json({ ok: false, error: 'Password required for local users. If LDAP, ensure full format: user@domain.com' });

//         const pool = await getPool();
//         const exists = await pool.request().input('LoginName', sql.NVarChar(128), username).query('SELECT 1 FROM dbo.USERS WHERE LoginName=@LoginName');
//         if (exists.recordset.length) return res.status(409).json({ ok:false, error:'user_exists', message: 'User already exists' });

//         const gapRes = await pool.request().query(`SELECT MIN(t1.UserID + 1) AS NextID FROM dbo.USERS t1 LEFT JOIN dbo.USERS t2 ON t1.UserID + 1 = t2.UserID WHERE t2.UserID IS NULL AND t1.UserID < 9000`);
//         let nextId = gapRes.recordset[0].NextID;
//         if (!nextId) {
//              const maxRes = await pool.request().query('SELECT MAX(UserID) as MaxID FROM dbo.USERS WHERE UserID < 9000');
//              nextId = (maxRes.recordset[0].MaxID || 0) + 1;
//         }

//         const isMaster = role === 'Admin';

//         if (!isLdap) {
//             try {
//                 await createBigFixOperator(username, false, password, null, isMaster);
//                 if (!isMaster) await assignUserToRole(username, role);
//             } catch (bfErr) {
//                 logger.warn(`[RBAC] Local BigFix operator creation threw an error: ${bfErr.message}`);
//             }
//         } else {
//             logger.info(`[RBAC] LDAP User '${username}' detected. Bypassing proactive BigFix creation. Will JIT provision upon their first login.`);
//         }

//         let finalHash = 'LDAP_AUTH';
//         let finalSalt = 'LDAP_AUTH';
//         let finalAlgo = 'NONE';
//         let finalBfEnc = null;

//         if (!isLdap) {
//             const hp = hashPassword(password);
//             finalHash = hp.hash;
//             finalSalt = hp.salt;
//             finalAlgo = HASH_ALGORITHM;
//             finalBfEnc = encrypt(password);
//         }

//         await pool.request()
//             .input('UserID', sql.Int, nextId)
//             .input('LoginName', sql.NVarChar(128), username)
//             .input('Role', sql.NVarChar(100), role)
//             .input('PasswordHash', sql.NVarChar(128), finalHash)
//             .input('PasswordSalt', sql.NVarChar(128), finalSalt)
//             .input('HashAlgorithm', sql.NVarChar(12), finalAlgo)
//             .input('BfPasswordEncrypted', sql.NVarChar(sql.MAX), finalBfEnc)
//             .query(`INSERT INTO dbo.USERS (UserID, LoginName, Role, PasswordHash, PasswordSalt, HashAlgorithm, BfPasswordEncrypted, CreatedAt, UpdatedAt) VALUES (@UserID, @LoginName, @Role, @PasswordHash, @PasswordSalt, @HashAlgorithm, @BfPasswordEncrypted, SYSUTCDATETIME(), SYSUTCDATETIME())`);

//         res.json({ ok: true, message: `User saved successfully. ${isLdap ? 'BigFix Role will be automatically provisioned dynamically on their first login.' : 'Local BigFix Operator created.'}` });
//     } catch (e) { res.status(500).json({ ok: false, error: 'server_error', message: e.message }); }
// });

// // router.get('/api/auth/users', async (req, res) => {
// //   try {
// //     if (!isAdmin(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
// //     const pool = await getPool();
// //     const rs = await pool.request().query('SELECT UserID, LoginName, Role, CreatedAt FROM dbo.USERS ORDER BY LoginName');
// //     res.json({ ok: true, users: rs.recordset });
// //   } catch (e) { res.status(500).json({ ok:false, error: e.message }); }
// // });

// router.get('/api/auth/users', async (req, res) => {
//   try {
//     if (!isAdmin(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
    
//     const pool = await getPool();
//     const rs = await pool.request().query('SELECT UserID, LoginName, Role, CreatedAt FROM dbo.USERS ORDER BY LoginName');
//     let users = rs.recordset;

//     // Fetch live roles directly from BigFix for every user
//     const ctx = getCtx();
//     const { BIGFIX_BASE_URL, BIGFIX_USER, BIGFIX_PASS, httpsAgent } = ctx.bigfix;

//     if (BIGFIX_BASE_URL) {
//         const auth = { username: BIGFIX_USER, password: BIGFIX_PASS };
        
//         // Use Promise.all to fetch them all simultaneously for speed
//         await Promise.all(users.map(async (u) => {
//             if (u.Role === 'Admin') return; // Skip the main admin
//             try {
//                 const rolesUrl = joinUrl(BIGFIX_BASE_URL, `/api/operator/${encodeURIComponent(u.LoginName)}/roles`);
//                 const rolesResp = await axios.get(rolesUrl, { httpsAgent, auth, headers: { Accept: "application/xml" }, validateStatus: () => true });

//                 if (rolesResp.status === 200) {
//                     const xml = String(rolesResp.data || "");
//                     const roleBlocks = xml.split("</Role>");
//                     let bfRoles = [];
//                     for (const block of roleBlocks) {
//                         const match = block.match(/<Name>(.*?)<\/Name>/i);
//                         if (match) bfRoles.push(match[1].trim());
//                     }
//                     u.Role = bfRoles.length > 0 ? bfRoles.join(', ') : 'No Role Assigned';
//                 }
//             } catch (err) {
//                 logger.warn(`Failed to fetch roles for ${u.LoginName}: ${err.message}`);
//             }
//         }));
//     }

//     res.json({ ok: true, users });
//   } catch (e) { res.status(500).json({ ok:false, error: e.message }); }
// });

// router.delete('/api/auth/users/:id', async (req, res) => {
//   try {
//     const { id } = req.params;
//     const { currentUserId } = req.body;
//     if (!isAdmin(req)) return res.status(403).json({ ok: false, error: 'forbidden 404' });
//     if ([9002, 9003, 9004].includes(Number(id))) return res.status(403).json({ ok: false, error: 'forbidden' });
//     if (Number(id) === Number(currentUserId)) return res.status(403).json({ ok: false, error: 'cannot_delete_self' });
//     const pool = await getPool();
//     await pool.request().input('UserID', sql.Int, id).query('DELETE FROM dbo.USERS WHERE UserID = @UserID');
//     res.json({ ok: true, deleted: true });
//   } catch (e) { res.status(500).json({ ok:false, error: e.message }); }
// });

// router.put('/api/auth/users/:id/role', async (req, res) => {
//   try {
//     if (!isAdmin(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
    
//     const { id } = req.params;
//     const { roles } = req.body; // Array of selected roles from frontend

//     if (!Array.isArray(roles)) {
//         return res.status(400).json({ ok: false, error: 'Roles must be an array' });
//     }

//     if ([9002, 9003, 9004].includes(Number(id))) {
//         return res.status(403).json({ ok: false, error: 'Cannot modify system users' });
//     }

//     const pool = await getPool();

//     // 1. Get the username
//     const userRes = await pool.request()
//         .input('UserID', sql.Int, id)
//         .query('SELECT LoginName FROM dbo.USERS WHERE UserID = @UserID');

//     if (userRes.recordset.length === 0) {
//         return res.status(404).json({ ok: false, error: 'User not found' });
//     }

//     const username = userRes.recordset[0].LoginName;

//     // 2. Fetch their TRUE current roles directly from BigFix (Source of Truth)
//     const ctx = getCtx();
//     const { BIGFIX_BASE_URL, BIGFIX_USER, BIGFIX_PASS, httpsAgent } = ctx.bigfix;
//     const auth = { username: BIGFIX_USER, password: BIGFIX_PASS };
    
//     let oldRoles = [];
//     if (BIGFIX_BASE_URL) {
//         try {
//             const rolesUrl = joinUrl(BIGFIX_BASE_URL, `/api/operator/${encodeURIComponent(username)}/roles`);
//             const rolesResp = await axios.get(rolesUrl, { httpsAgent, auth, headers: { Accept: "application/xml" }, validateStatus: () => true });

//             if (rolesResp.status === 200) {
//                 const xml = String(rolesResp.data || "");
//                 const roleBlocks = xml.split("</Role>");
//                 for (const block of roleBlocks) {
//                     const match = block.match(/<Name>(.*?)<\/Name>/i);
//                     if (match) oldRoles.push(match[1].trim());
//                 }
//             }
//         } catch (err) {
//             logger.warn(`Failed to fetch current roles for ${username} during update: ${err.message}`);
//         }
//     }

//     // 3. Calculate exactly what to add and what to remove
//     const rolesToAdd = roles.filter(r => !oldRoles.includes(r) && r !== 'Admin');
//     const rolesToRemove = oldRoles.filter(r => !roles.includes(r) && r !== 'Admin');

//     // 4. Sync removals with BigFix
//     for (const roleToRemove of rolesToRemove) {
//         try {
//             await unassignUserFromRole(username, roleToRemove);
//         } catch (bfErr) {
//             logger.warn(`[RBAC] Failed to remove ${username} from ${roleToRemove} in BigFix: ${bfErr.message}`);
//         }
//     }

//     // 5. Sync additions with BigFix
//     for (const roleToAdd of rolesToAdd) {
//         try {
//             await assignUserToRole(username, roleToAdd);
//         } catch (bfErr) {
//             logger.warn(`[RBAC] Failed to add ${username} to ${roleToAdd} in BigFix: ${bfErr.message}`);
//         }
//     }

//     // 6. Update local database so it matches BigFix
//     const newRoleString = roles.join(', ');
//     await pool.request()
//         .input('Role', sql.NVarChar(4000), newRoleString) 
//         .input('UserID', sql.Int, id)
//         .query('UPDATE dbo.USERS SET Role = @Role, UpdatedAt = SYSUTCDATETIME() WHERE UserID = @UserID');

//     res.json({ ok: true, message: `Roles updated successfully.` });
//   } catch (e) { 
//     res.status(500).json({ ok: false, error: e.message }); 
//   }
// });

// module.exports = router;


// src/routes/auth.js
const express = require('express');
const router = express.Router();

// 1. Import Middlewares
const { requireAdmin } = require('../middlewares/auth.middleware');

// 2. Import Standard Controllers
const authController = require('../controllers/auth.controller');
const setupController = require('../controllers/setup.controller');
const passwordController = require('../controllers/password.controller');
const credentialController = require('../controllers/credential.controller');
const teamController = require('../controllers/team.controller');

// 3. Import our newly modularized User Controllers (resolves to src/controllers/user/index.js)
const userController = require('../controllers/user');
const myRolesController = require('../controllers/myRoles.controller');

// Set payload limit
router.use(express.json({ limit: '1mb' }));

// ==========================================
// CORE AUTHENTICATION & SETUP ROUTES
// ==========================================
router.post('/api/auth/login', authController.login);
router.post('/api/auth/logout', authController.logout);
router.get('/api/auth/status', authController.status);

router.get('/api/auth/roles', myRolesController.getMyRoles);

router.get('/api/auth/setup-required', setupController.setupRequired);
router.post('/api/auth/signup', setupController.signup);

// ==========================================
// PASSWORD MANAGEMENT
// ==========================================
router.post('/api/auth/reset-password', requireAdmin, passwordController.resetPassword);
router.post('/api/auth/change-password', passwordController.changePassword);

// ==========================================
// PERSONAL BIGFIX CREDENTIAL
// ==========================================
router.get('/api/auth/my-bigfix-creds', credentialController.getMyBigFixCreds);
router.post('/api/auth/my-bigfix-creds', credentialController.updateMyBigFixCreds);

// ==========================================
// TEAM STATE (UI PREFERENCES)
// ==========================================
router.get('/api/auth/team-state', teamController.getTeamState);
router.post('/api/auth/team-state', teamController.updateTeamState);

// ==========================================
// ADMIN USER MANAGEMENT (PROTECTED)
// ==========================================
// The `requireAdmin` middleware automatically blocks unauthorized users!
router.get('/api/auth/all-roles', requireAdmin, userController.getAllRoles);
router.get('/api/auth/users', requireAdmin, userController.getUsers);
router.post('/api/auth/admin/add-user', requireAdmin, userController.addUser);
router.delete('/api/auth/users/:id', requireAdmin, userController.deleteUser);
router.put('/api/auth/users/:id/role', requireAdmin, userController.updateUserRole);

module.exports = router;