const { sql, getPool } = require('../db/mssql');
const { verifyPassword } = require('../utils/password');
const { authenticateLDAP } = require('../services/ldap'); 
const { encrypt } = require('../utils/crypto'); 
const { getCfg, getCtx } = require('../env'); 
const { logger } = require('../services/logger');
const { joinUrl } = require('../utils/http');
const axios = require('axios');

const createOperator = require('../services/bigfix/createOperator');
const assignRole = require('../services/bigfix/assignRole');
const verifyCredentials = require('../services/bigfix/verifyCredentials');

/**
 * Looks up the user in BigFix as a direct operator and returns their assigned role(s).
 * Returns { found: boolean, role: string|null, isMaster: boolean }
 */
async function getBigFixOperatorRole(username) {
    const ctx = getCtx();
    const { BIGFIX_BASE_URL, BIGFIX_USER, BIGFIX_PASS, httpsAgent } = ctx.bigfix;
    if (!BIGFIX_BASE_URL) return { found: false, role: null, isMaster: false };

    const auth = { username: BIGFIX_USER, password: BIGFIX_PASS };

    try {
        const opUrl = joinUrl(BIGFIX_BASE_URL, `/api/operator/${encodeURIComponent(username)}`);
        const opResp = await axios.get(opUrl, { httpsAgent, auth, headers: { Accept: "application/xml" }, validateStatus: () => true });

        if (opResp.status !== 200) return { found: false, role: null, isMaster: false };

        const xml = String(opResp.data || "");
        const moMatch = xml.match(/<MasterOperator>(.*?)<\/MasterOperator>/i);
        const isMaster = moMatch && (moMatch[1].trim().toLowerCase() === "true" || moMatch[1].trim() === "1");

        // 🚀 FIX: Removed the early return for isMaster. 
        // The system will now always fetch explicitly assigned roles rather than forcing 'Admin'.
        
        // Fetch explicitly assigned roles
        const rolesUrl = joinUrl(BIGFIX_BASE_URL, `/api/operator/${encodeURIComponent(username)}/roles`);
        const rolesResp = await axios.get(rolesUrl, { httpsAgent, auth, headers: { Accept: "application/xml" }, validateStatus: () => true });

        if (rolesResp.status === 200) {
            const rolesXml = String(rolesResp.data || "");
            const bfRoles = [];
            const roleBlocks = rolesXml.split("</Role>");
            for (const block of roleBlocks) {
                const match = block.match(/<Name>(.*?)<\/Name>/i);
                if (match) bfRoles.push(match[1].trim());
            }
            if (bfRoles.length > 0) return { found: true, role: bfRoles.join(', '), isMaster };
        }

        // Operator exists in BigFix but has no role assigned yet
        return { found: true, role: 'No Role Assigned', isMaster };
    } catch (e) {
        logger.warn(`[Auth] BigFix operator lookup failed for '${username}': ${e.message}`);
        return { found: false, role: null, isMaster: false };
    }
}

/**
 * Checks all BigFix roles for an LDAP group match against the user's AD group memberships.
 * Returns the first matching role name, or null if none found.
 * @param {string[]} userGroups - Array of group DNs from memberOf attribute
 */
async function getRoleByLdapGroup(userGroups) {
    if (!userGroups || userGroups.length === 0) return null;

    const ctx = getCtx();
    const { BIGFIX_BASE_URL, BIGFIX_USER, BIGFIX_PASS, httpsAgent } = ctx.bigfix;
    if (!BIGFIX_BASE_URL) return null;

    const auth = { username: BIGFIX_USER, password: BIGFIX_PASS };
    const userGroupsLower = userGroups.map(g => g.toLowerCase());

    try {
        // Get all roles
        const rolesUrl = joinUrl(BIGFIX_BASE_URL, `/api/roles`);
        const rolesResp = await axios.get(rolesUrl, { httpsAgent, auth, headers: { Accept: "application/xml" }, validateStatus: () => true });
        if (rolesResp.status !== 200) return null;

        const rolesXml = String(rolesResp.data || "");
        const roleBlocks = rolesXml.split("</Role>");

        for (const block of roleBlocks) {
            const nameMatch = block.match(/<Name>(.*?)<\/Name>/i);
            const idMatch   = block.match(/<ID>(\d+)<\/ID>/i);
            if (!nameMatch || !idMatch) continue;

            const roleName = nameMatch[1].trim();
            const roleId   = idMatch[1];

            // Fetch full role definition to inspect <LDAPGroups>
            try {
                const roleUrl  = joinUrl(BIGFIX_BASE_URL, `/api/role/${roleId}`);
                const roleResp = await axios.get(roleUrl, { httpsAgent, auth, headers: { Accept: "application/xml" }, validateStatus: () => true });
                if (roleResp.status !== 200) continue;

                const roleXml = String(roleResp.data || "");

                // Extract all <DN> values inside <LDAPGroups>
                const ldapGroupsBlock = roleXml.match(/<LDAPGroups>([\s\S]*?)<\/LDAPGroups>/i);
                if (!ldapGroupsBlock) continue;

                const dnRegex = /<DN>(.*?)<\/DN>/gi;
                let dnMatch;
                while ((dnMatch = dnRegex.exec(ldapGroupsBlock[1])) !== null) {
                    const dn = dnMatch[1].trim().toLowerCase();
                    if (userGroupsLower.includes(dn)) {
                        logger.info(`[Auth] LDAP group match found. Role '${roleName}' DN: ${dn}`);
                        return roleName;
                    }
                }
            } catch (e) {
                logger.warn(`[Auth] Failed to fetch role ${roleId} for LDAP group check: ${e.message}`);
            }
        }
    } catch (e) {
        logger.warn(`[Auth] LDAP group-to-role check failed: ${e.message}`);
    }
    return null;
}

/**
 * Auto-provisions an AD user in the local DB when they are verified in AD
 * but don't yet have a DB record.
 * Returns the newly created user record, or null on failure.
 */
async function autoProvisionAdUser(pool, username, role) {
    try {
        const gapRes = await pool.request().query(
            `SELECT MIN(t1.UserID + 1) AS NextID FROM dbo.USERS t1
             LEFT JOIN dbo.USERS t2 ON t1.UserID + 1 = t2.UserID
             WHERE t2.UserID IS NULL AND t1.UserID < 9000`
        );
        let nextId = gapRes.recordset[0].NextID;
        if (!nextId) {
            const maxRes = await pool.request().query('SELECT MAX(UserID) as MaxID FROM dbo.USERS WHERE UserID < 9000');
            nextId = (maxRes.recordset[0].MaxID || 0) + 1;
        }

        await pool.request()
            .input('UserID',            sql.Int,                 nextId)
            .input('LoginName',         sql.NVarChar(128),       username)
            .input('Role',              sql.NVarChar(100),       role)
            .input('PasswordHash',      sql.NVarChar(128),       'LDAP_AUTH')
            .input('PasswordSalt',      sql.NVarChar(128),       'LDAP_AUTH')
            .input('HashAlgorithm',     sql.NVarChar(12),        'NONE')
            .input('BfPasswordEncrypted', sql.NVarChar(sql.MAX), null)
            .query(`INSERT INTO dbo.USERS
                        (UserID, LoginName, Role, PasswordHash, PasswordSalt, HashAlgorithm, BfPasswordEncrypted, CreatedAt, UpdatedAt)
                    VALUES
                        (@UserID, @LoginName, @Role, @PasswordHash, @PasswordSalt, @HashAlgorithm, @BfPasswordEncrypted, SYSUTCDATETIME(), SYSUTCDATETIME())`);

        logger.info(`[Auth] Auto-provisioned AD user '${username}' with role '${role}' (UserID: ${nextId})`);

        // Re-fetch so we have the full record for the session
        const newRs = await pool.request()
            .input('LoginName', sql.NVarChar(128), username)
            .query('SELECT TOP 1 UserID, LoginName, PasswordHash, PasswordSalt, Role, BfPasswordEncrypted FROM dbo.USERS WHERE LoginName=@LoginName');
        return newRs.recordset[0] || null;
    } catch (err) {
        logger.error(`[Auth] autoProvisionAdUser failed for '${username}': ${err.message}`);
        return null;
    }
}

async function login(req, res) {
    try {
        const { username, password } = req.body || {};
        if (!username || !password) return res.status(400).json({ ok: false, error: 'bad_request', message: 'Username and password required.' });

        const pool = await getPool();

        // ── 1. Try LDAP authentication first ──────────────────────────────────
        const ldapResult = await authenticateLDAP(username, password);
        const isLdapOk   = ldapResult && ldapResult.authenticated;

        // ── 2. Fetch existing DB record ───────────────────────────────────────
        const rs = await pool.request()
            .input('LoginName', sql.NVarChar(128), username)
            .query('SELECT TOP 1 UserID, LoginName, PasswordHash, PasswordSalt, Role, BfPasswordEncrypted FROM dbo.USERS WHERE LoginName=@LoginName');
        let userRecord    = rs.recordset[0];
        let authenticated = false;

        if (isLdapOk) {
            if (userRecord) {
                // Known AD user — allow in
                authenticated = true;
            } else {
                // ── AD-verified but no DB record: look up BigFix / LDAP group ──
                logger.info(`[Auth] AD user '${username}' authenticated but not in DB. Checking BigFix...`);

                let assignedRole = null;

                // 2a. Check direct BigFix operator
                const bfCheck = await getBigFixOperatorRole(username);
                if (bfCheck.found && bfCheck.role && bfCheck.role !== 'No Role Assigned') {
                    assignedRole = bfCheck.role;
                    logger.info(`[Auth] Found BigFix operator for '${username}' with role '${assignedRole}'`);
                }

                // 2b. Fall back: check user's AD groups against BigFix role LDAP groups
                if (!assignedRole) {
                    const groups = ldapResult.groups || [];
                    if (groups.length > 0) {
                        assignedRole = await getRoleByLdapGroup(groups);
                        if (assignedRole) logger.info(`[Auth] LDAP group mapped '${username}' to role '${assignedRole}'`);
                    }
                }

                if (assignedRole) {
                    userRecord = await autoProvisionAdUser(pool, username, assignedRole);
                    if (userRecord) {
                        authenticated = true;
                    } else {
                        return res.status(500).json({ ok: false, error: 'provision_failed', message: 'AD account verified but auto-provisioning failed. Contact administrator.' });
                    }
                } else {
                    return res.status(403).json({ ok: false, error: 'access_denied', message: 'AD account verified but no BigFix operator or matching role found. Contact administrator.' });
                }
            }
        } else {
            // ── 3. Local Patch Setu password (local hash) is the ONLY non-LDAP auth source.
            // BigFix is intentionally NOT used as an authentication fallback: every wrong-password
            // attempt sent to BigFix gets forwarded to AD for LDAP-bound operators, which counts
            // toward the AD account lockout policy. Auth happens here; BigFix is consulted later
            // (post-auth) only to decide whether to refresh BfPasswordEncrypted.
            if (userRecord && userRecord.PasswordHash && userRecord.PasswordHash !== 'LDAP_AUTH' && userRecord.PasswordHash !== 'SYSTEM_USER') {
                try { if (verifyPassword(password, userRecord.PasswordSalt, userRecord.PasswordHash)) authenticated = true; } catch (err) {}
            }
        }

        if (!authenticated) return res.status(401).json({ ok: false, error: 'invalid', message: 'Invalid username or password.' });

        // ── 4. Post-authentication BigFix sync — runs for BOTH LDAP and local-auth users.
        // The user is already authenticated by this point (LDAP bind succeeded, or local hash
        // matched). Now we ask BigFix's /api/login (HTTP Basic Auth via verifyCredentials)
        // whether it accepts the SAME password the user just typed.
        //
        //   • BigFix returns 200 → operator is LDAP-bound (AD path) or has a local BigFix
        //     password that happens to match what was just typed. Either way, this password
        //     works against BigFix → encrypt and store it as BfPasswordEncrypted. Subsequent
        //     BigFix API calls (deployments, patches, action status, ...) will succeed.
        //
        //   • BigFix returns non-200 → operator is a local BigFix account whose password is
        //     different from the one just typed (common when the operator was provisioned
        //     manually in the BigFix Console before this app existed). PRESERVE the existing
        //     BfPasswordEncrypted; do NOT overwrite. The user keeps any working password they
        //     previously set via the My Account vault. If they have nothing stored yet, they
        //     can set their BigFix-specific password through My Account once.
        //
        // For LDAP users with no DB record yet (just auto-provisioned above), this is also
        // where their BigFix operator gets created JIT — but only if we don't already have
        // a stored credential for them.
        if (userRecord) {
            if (isLdapOk && !userRecord.BfPasswordEncrypted && ldapResult.dn) {
                try { await createOperator(username, true, null, ldapResult.dn, userRecord.Role === 'Admin'); } catch (e) { }
            }

            try {
                const bfAccepts = await verifyCredentials(username, password);
                if (bfAccepts) {
                    const encPass = encrypt(password);
                    if (encPass) {
                        try {
                            await pool.request()
                                .input('Bf', sql.NVarChar(sql.MAX), encPass)
                                .input('UID', sql.Int, userRecord.UserID)
                                .query('UPDATE dbo.USERS SET BfPasswordEncrypted = @Bf WHERE UserID = @UID');
                        } catch (e) { /* don't block login on a refresh failure */ }
                    }
                } else {
                    logger.warn(`[Auth] BigFix rejected the login password for '${username}'. ` +
                                `Operator likely has a separate local BigFix password. ` +
                                `Preserving existing BfPasswordEncrypted; user can set their BigFix password via My Account.`);
                }
            } catch (e) {
                logger.warn(`[Auth] BigFix verify after successful auth failed for '${username}': ${e.message}`);
            }
        }

        if (userRecord && userRecord.Role && userRecord.Role !== 'Admin') await assignRole(username, userRecord.Role);

        // ── Create DB-backed opaque session token (Vuln 2 + 9 fix) ──────────────
        // createSession() enforces single-session-per-user and stores all state
        // server-side. The cookie only holds the opaque token — no user data.
        const { createSession, getCookieOptions } = require('../middlewares/session');
        const sessionToken = await createSession(
            userRecord.UserID,
            userRecord.LoginName,
            userRecord.Role
        );

//         const timeoutMins = Number(getCfg().SESSION_TIMEOUT) || 15;

//         res.cookie('auth_session', sessionToken, getCookieOptions());
//         res.json({ ok: true, userId: userRecord.UserID, username: userRecord.LoginName, role: userRecord.Role, timeoutMins });
//     } catch (e) { res.status(500).json({ ok: false, error: 'server_error', message: e.message }); }
// }
        const timeoutMins = Number(getCfg().SESSION_TIMEOUT) || 15;

        const assignedRoles = (userRecord.Role || "").split(',').map(r => r.trim());
        const initialRole = assignedRoles.includes('Admin') ? 'Admin' : (assignedRoles[0] || 'No Role Assigned');

        res.cookie('auth_session', sessionToken, getCookieOptions());
        res.cookie('active_role', initialRole, getCookieOptions()); // Track active role
        res.json({ ok: true, userId: userRecord.UserID, username: userRecord.LoginName, role: initialRole, timeoutMins });
    } catch (e) { res.status(500).json({ ok: false, error: 'server_error', message: e.message }); }
}

function logout(req, res) {
    const { destroySession } = require('../middlewares/session');
    const token = req.cookies && req.cookies.auth_session;
    if (token) {
        destroySession(token).catch(() => {});   // fire-and-forget; don't block response
    }
    res.clearCookie('auth_session', { httpOnly: true, secure: true, sameSite: 'lax' });
    res.json({ ok: true, message: 'Logged out' });
}

// function status(req, res) {
//     const timeoutMins = Number(getCfg().SESSION_TIMEOUT) || 15;
//     // req.session is populated by sessionMiddleware (mounted in app.js)
//     if (req.session && req.session.Username) {
//         return res.json({
//             ok: true,
//             authed: true,
//             userData: {
//                 userId:   req.session.UserId,
//                 username: req.session.Username,
//                 role:     req.session.Role,
//                 dbRole:   req.session.Role
//             },
//             timeoutMins
//         });
//     }
//     return res.json({ ok: false, authed: false, timeoutMins });
// }

function status(req, res) {
    const timeoutMins = Number(getCfg().SESSION_TIMEOUT) || 15;
    if (req.session && req.session.Username) {
        const assignedRoles = (req.session.Role || "").split(',').map(r => r.trim());
        let requestedRole = req.headers['x-user-role'] || (req.cookies && req.cookies.active_role);
        if (requestedRole && requestedRole.includes(',')) {
            requestedRole = requestedRole.split(',')[0].trim();
        }
        
        let activeRole = assignedRoles[0] || 'No Role Assigned';
        if (assignedRoles.includes('Admin')) {
            activeRole = 'Admin';
        } else if (requestedRole && assignedRoles.includes(requestedRole)) {
            activeRole = requestedRole;
        }

        const { getCookieOptions } = require('../middlewares/session');
        res.cookie('active_role', activeRole, getCookieOptions());

        return res.json({
            ok: true,
            authed: true,
            userData: {
                userId:   req.session.UserId,
                username: req.session.Username,
                role:     activeRole,
                dbRole:   req.session.Role
            },
            timeoutMins
        });
    }
    return res.json({ ok: false, authed: false, timeoutMins });
}

module.exports = { login, logout, status };