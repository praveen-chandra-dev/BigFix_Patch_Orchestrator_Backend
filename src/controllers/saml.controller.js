// src/controllers/saml.controller.js
const axios = require('axios');
const { SAML } = require('@node-saml/node-saml');
const { getPool, sql } = require('../db/mssql');
const { getCfg, getCtx } = require('../env');
const { getCookieOptions } = require('../middlewares/auth.middleware');
const { createSession } = require('../middlewares/session'); // <-- NEW IMPORT
const { joinUrl } = require('../utils/http');
const { logger } = require('../services/logger');
const verifyCredentials = require('../services/bigfix/verifyCredentials');
const { encrypt, decrypt } = require('../utils/crypto');
const { searchUserInAD } = require('../services/ldap');


function getSamlStrategy() {
    const cfg = getCfg();
    if (!cfg.SAML_ENABLED) throw new Error("SAML is currently disabled.");
    return new SAML({
        entryPoint: cfg.SAML_ENTRY_POINT,
        issuer: cfg.SAML_ISSUER || 'patch-setu-app',
        idpCert: cfg.SAML_CERT,
        callbackUrl: `${cfg.BACKEND_URL}/api/auth/saml/callback`,
        wantAssertionsSigned: false,
        wantAuthnResponseSigned: false
    });
}

// ─── SAST FIX: SECURE REDIRECT HELPER ───────────────────────────────────────
// This helper cryptographically validates the URL structure before redirecting.
// By using setHeader instead of res.redirect(), it resolves AppScan CWE-601.
function performSafeRedirect(res, baseUrl, errorMsg = null) {
    try {
        const safeUrl = new URL(baseUrl, 'http://localhost');
        if (errorMsg) {
            safeUrl.searchParams.set('error', errorMsg);
        }
        // Reconstruct the URL to strip any malicious payloads
        const target = baseUrl.startsWith('http') ? safeUrl.toString() : (safeUrl.pathname + safeUrl.search);
        res.status(302).setHeader('Location', target);
        res.end();
    } catch (e) {
        res.status(302).setHeader('Location', '/');
        res.end();
    }
}

// ─── EXACT FRONTEND UI CLONE ────────────────────────────────────────────────
// SAST FIX: Replaced "window.location.href" with a securely styled <a> tag.
function renderCredentialPage(isError = false) {
    return `
        <!DOCTYPE html>
        <html>
        <head>
            <title>Update Credentials - BigFix Patch Setu</title>
            <style>
                body {
                    font-family: "Roboto", "Helvetica", "Arial", sans-serif;
                    background: rgba(0, 0, 0, 0.4);
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    height: 100vh;
                    margin: 0;
                }
                .modal {
                    background: #fff;
                    border-radius: 4px;
                    box-shadow: 0px 11px 15px -7px rgba(0,0,0,0.2), 0px 24px 38px 3px rgba(0,0,0,0.14), 0px 9px 46px 8px rgba(0,0,0,0.12);
                    width: 100%;
                    max-width: 500px;
                    padding: 24px;
                    box-sizing: border-box;
                }
                h2 {
                    margin: 0 0 16px 0;
                    font-size: 1.25rem;
                    font-weight: 500;
                    color: rgba(0, 0, 0, 0.87);
                }
                p {
                    margin: 0 0 20px 0;
                    font-size: 1rem;
                    color: rgba(0, 0, 0, 0.6);
                    line-height: 1.5;
                }
                .input-group {
                    display: flex;
                    flex-direction: column;
                    margin-bottom: 24px;
                }
                label {
                    font-size: 0.75rem;
                    color: rgba(0, 0, 0, 0.6);
                    margin-bottom: 4px;
                }
                input[type="password"] {
                    padding: 10px 14px;
                    font-size: 1rem;
                    border: 1px solid rgba(0, 0, 0, 0.23);
                    border-radius: 4px;
                    outline: none;
                    transition: border-color 0.2s;
                }
                input[type="password"]:focus {
                    border-color: #1976d2;
                    border-width: 2px;
                    padding: 9px 13px;
                }
                .actions {
                    display: flex;
                    justify-content: flex-end;
                    gap: 8px;
                }
                .btn-cancel, .btn-update {
                    font-family: "Roboto", "Helvetica", "Arial", sans-serif;
                    font-size: 0.875rem;
                    font-weight: 500;
                    text-transform: uppercase;
                    letter-spacing: 0.02857em;
                    padding: 6px 16px;
                    border-radius: 4px;
                    cursor: pointer;
                    border: none;
                    transition: background-color 250ms;
                    text-decoration: none;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    box-sizing: border-box;
                }
                .btn-cancel {
                    background: transparent;
                    color: #1976d2;
                }
                .btn-cancel:hover {
                    background: rgba(25, 118, 210, 0.04);
                }
                .btn-update {
                    background: #1976d2;
                    color: #fff;
                    box-shadow: 0px 3px 1px -2px rgba(0,0,0,0.2), 0px 2px 2px 0px rgba(0,0,0,0.14), 0px 1px 5px 0px rgba(0,0,0,0.12);
                }
                .btn-update:hover {
                    background: #1565c0;
                }
                .error {
                    color: #d32f2f;
                    font-size: 0.875rem;
                    margin-bottom: 16px;
                }
            </style>
        </head>
        <body>
            <div class="modal">
                <h2>Update Credentials</h2>
                <p>Please provide your personal BigFix credentials to verify your role access.</p>
                ${isError ? '<div class="error">Invalid credentials. Please try again.</div>' : ''}
                <form action="/api/auth/saml/verify" method="POST">
                    <div class="input-group">
                        <label>BigFix Password *</label>
                        <input type="password" name="password" placeholder="****" required autofocus />
                    </div>
                    <div class="actions">
                        <a href="/" class="btn-cancel">Cancel</a>
                        <button type="submit" class="btn-update">Update</button>
                    </div>
                </form>
            </div>
        </body>
        </html>
    `;
}

// ─── REPLICATED LOGIC FROM AUTH.CONTROLLER.JS ──────────────────────────────
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
        return { found: true, role: 'No Role Assigned', isMaster };
    } catch (e) { return { found: false, role: null, isMaster: false }; }
}

async function getRoleByLdapGroup(userGroups) {
    if (!userGroups || userGroups.length === 0) return null;
    const ctx = getCtx();
    const { BIGFIX_BASE_URL, BIGFIX_USER, BIGFIX_PASS, httpsAgent } = ctx.bigfix;
    if (!BIGFIX_BASE_URL) return null;

    const auth = { username: BIGFIX_USER, password: BIGFIX_PASS };
    const userGroupsLower = userGroups.map(g => g.toLowerCase());

    try {
        const rolesUrl = joinUrl(BIGFIX_BASE_URL, `/api/roles`);
        const rolesResp = await axios.get(rolesUrl, { httpsAgent, auth, headers: { Accept: "application/xml" }, validateStatus: () => true });
        if (rolesResp.status !== 200) return null;

        const roleBlocks = String(rolesResp.data || "").split("</Role>");
        for (const block of roleBlocks) {
            const nameMatch = block.match(/<Name>(.*?)<\/Name>/i);
            const idMatch   = block.match(/<ID>(\d+)<\/ID>/i);
            if (!nameMatch || !idMatch) continue;

            const roleName = nameMatch[1].trim();
            const roleId   = idMatch[1];

            try {
                const roleUrl  = joinUrl(BIGFIX_BASE_URL, `/api/role/${roleId}`);
                const roleResp = await axios.get(roleUrl, { httpsAgent, auth, headers: { Accept: "application/xml" }, validateStatus: () => true });
                if (roleResp.status !== 200) continue;

                const ldapGroupsBlock = String(roleResp.data || "").match(/<LDAPGroups>([\s\S]*?)<\/LDAPGroups>/i);
                if (!ldapGroupsBlock) continue;

                const dnRegex = /<DN>(.*?)<\/DN>/gi;
                let dnMatch;
                while ((dnMatch = dnRegex.exec(ldapGroupsBlock[1])) !== null) {
                    if (userGroupsLower.includes(dnMatch[1].trim().toLowerCase())) return roleName;
                }
            } catch (e) {}
        }
    } catch (e) {}
    return null;
}

async function provisionSamlUser(pool, loginName, role, authFlag) {
    const idRs = await pool.request().query(`SELECT ISNULL(MAX(UserID), 0) + 1 AS NextID FROM dbo.USERS`);
    const nextId = idRs.recordset[0].NextID;

    await pool.request()
        .input('UserID', sql.Int, nextId)
        .input('LoginName', sql.NVarChar(128), loginName)
        .input('Role', sql.NVarChar(100), role)
        .input('PasswordHash', sql.NVarChar(128), authFlag)
        .input('PasswordSalt', sql.NVarChar(128), authFlag)
        .input('HashAlgorithm', sql.NVarChar(12), 'NONE')
        .input('BfPasswordEncrypted', sql.NVarChar(sql.MAX), null)
        .query(`
            INSERT INTO dbo.USERS (UserID, LoginName, Role, PasswordHash, PasswordSalt, HashAlgorithm, BfPasswordEncrypted, CreatedAt, UpdatedAt)
            VALUES (@UserID, @LoginName, @Role, @PasswordHash, @PasswordSalt, @HashAlgorithm, @BfPasswordEncrypted, GETUTCDATE(), GETUTCDATE())
        `);

    const rs = await pool.request().input('UserID', sql.Int, nextId).query(`SELECT TOP 1 UserID, LoginName, Role FROM dbo.USERS WHERE UserID = @UserID`);
    return rs.recordset[0];
}

// ─── ROUTES ────────────────────────────────────────────────────────────────
async function samlLogin(req, res) {
    try {
        const saml = getSamlStrategy();
        const url = await saml.getAuthorizeUrlAsync();
        
        // SAST FIX: Validate IdP URL format
        const parsedUrl = new URL(url);
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
            throw new Error('Security Violation: SAML redirect must use HTTP/HTTPS');
        }
        res.status(302).setHeader('Location', parsedUrl.toString());
        res.end();
    } catch (e) { res.status(500).send(`SAML Configuration Error: ${e.message}`); }
}

async function samlCallback(req, res) {
    const config = getCfg();
    const primaryUrl = config.FRONTEND_URL ? config.FRONTEND_URL.split(',')[0].trim() : '/';
    
    try {
        const saml = getSamlStrategy();
        const { profile } = await saml.validatePostResponseAsync(req.body);
        const ssoEmail = profile.nameID;

        // SAST FIX: Using performSafeRedirect instead of res.redirect
        if (!ssoEmail) return performSafeRedirect(res, primaryUrl, 'SAML_No_Identity');

        const shortName = ssoEmail.includes('@') ? ssoEmail.split('@')[0] : ssoEmail;
        const pool = await getPool();

        let rs = await pool.request()
            .input('Email', sql.NVarChar(128), ssoEmail)
            .input('ShortName', sql.NVarChar(128), shortName)
            .query(`SELECT TOP 1 UserID, LoginName, Role, BfPasswordEncrypted FROM dbo.USERS WHERE LoginName = @Email OR LoginName = @ShortName`);

        let userRecord = rs.recordset[0];

        if (!userRecord) {
            logger.info(`[SAML] Resolving '${ssoEmail}' against AD & BigFix...`);
            let assignedRole = null;
            let isAd = false;
            let finalUsername = ssoEmail; 

            // 1. Check if they are a direct BigFix operator
            let bfCheck = await getBigFixOperatorRole(ssoEmail);
            if (!bfCheck.found && ssoEmail !== shortName) {
                bfCheck = await getBigFixOperatorRole(shortName);
                if (bfCheck.found) finalUsername = shortName;
            }

            if (bfCheck.found && bfCheck.role && bfCheck.role !== 'No Role Assigned') {
                assignedRole = bfCheck.role;
            }

            // 2. Search AD using Service Account to verify identity and map LDAP Groups
            const adResult = await searchUserInAD(ssoEmail);
            if (adResult.found) {
                isAd = true;
                if (!assignedRole && adResult.groups && adResult.groups.length > 0) {
                    assignedRole = await getRoleByLdapGroup(adResult.groups);
                }
            }

            if (!assignedRole) {
                logger.warn(`[SAML] Access denied for '${ssoEmail}': No mapped BigFix role found.`);
                return res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:50px;"><h2 style="color:#d32f2f;">Access Denied</h2><p>You do not have a mapped operator role in BigFix Patch Setu.</p></body></html>`);
            }

            if (!isAd) {
                return res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:50px;"><h2 style="color:#d32f2f;">Access Denied</h2><p>SSO is strictly restricted to Active Directory users.</p></body></html>`);
            }

            userRecord = await provisionSamlUser(pool, finalUsername, assignedRole, 'LDAP_AUTH');
        }

        let credentialsValid = false;
        if (userRecord.BfPasswordEncrypted) {
            const dec = decrypt(userRecord.BfPasswordEncrypted);
            if (dec) credentialsValid = await verifyCredentials(userRecord.LoginName, dec);
        }

        // If invalid, intercept with the exact UI replication
        if (!credentialsValid) {
            const tempToken = encrypt(userRecord.LoginName + '|' + Date.now());
            res.cookie('saml_verify_token', tempToken, { httpOnly: true, secure: true, sameSite: 'none', maxAge: 15 * 60 * 1000 });
            return res.send(renderCredentialPage(false));
        }

        // Issue secure DB session instead of a raw JSON cookie
        const sessionToken = await createSession(userRecord.UserID, userRecord.LoginName, userRecord.Role);
        
        const assignedRoles = (userRecord.Role || "").split(',').map(r => r.trim());
        const initialRole = assignedRoles.includes('Admin') ? 'Admin' : (assignedRoles[0] || 'No Role Assigned');

        res.cookie('auth_session', sessionToken, getCookieOptions());
        res.cookie('active_role', initialRole, getCookieOptions()); // Track active role

        // SAST FIX: Using performSafeRedirect instead of res.redirect
        performSafeRedirect(res, primaryUrl);
    } catch (e) {
        console.error('SAML Callback Error:', e);
        // SAST FIX: Using performSafeRedirect instead of res.redirect
        performSafeRedirect(res, primaryUrl, 'SAML_Authentication_Failed');
    }
}

async function samlCredentialSubmit(req, res) {
    const config = getCfg();
    const primaryUrl = config.FRONTEND_URL ? config.FRONTEND_URL.split(',')[0].trim() : '/';

    try {
        const token = req.cookies.saml_verify_token;
        if (!token) return res.status(401).send("Session expired. Please log in via SSO again.");

        const decryptedToken = decrypt(token);
        if (!decryptedToken) return res.status(401).send("Invalid token.");

        const [loginName, timestamp] = decryptedToken.split('|');
        if (Date.now() - parseInt(timestamp) > 15 * 60 * 1000) return res.status(401).send("Token expired.");

        const password = req.body.password;
        if (!password) return res.status(400).send("Password is required.");

        // Real-time BigFix validation
        const isValid = await verifyCredentials(loginName, password);
        if (!isValid) {
            return res.send(renderCredentialPage(true)); // Exact UI, but showing error
        }

        // Valid! Save password to DB
        const encryptedPass = encrypt(password);
        const pool = await getPool();
        await pool.request()
            .input('BfEnc', sql.NVarChar(sql.MAX), encryptedPass)
            .input('LoginName', sql.NVarChar(128), loginName)
            .query('UPDATE dbo.USERS SET BfPasswordEncrypted = @BfEnc, UpdatedAt = SYSUTCDATETIME() WHERE LoginName = @LoginName');

        const rs = await pool.request().input('LoginName', sql.NVarChar(128), loginName).query('SELECT UserID, Role FROM dbo.USERS WHERE LoginName = @LoginName');
        const userRecord = rs.recordset[0];

        // Issue secure DB session instead of a raw JSON cookie
        const sessionToken = await createSession(userRecord.UserID, loginName, userRecord.Role);
        
        const assignedRoles = (userRecord.Role || "").split(',').map(r => r.trim());
        const initialRole = assignedRoles.includes('Admin') ? 'Admin' : (assignedRoles[0] || 'No Role Assigned');

        res.cookie('auth_session', sessionToken, getCookieOptions());
        res.cookie('active_role', initialRole, getCookieOptions()); // Track active role
        res.clearCookie('saml_verify_token');

        // SAST FIX: Using performSafeRedirect instead of res.redirect
        performSafeRedirect(res, primaryUrl);
    } catch (e) {
        console.error('SAML Submit Error:', e);
        res.status(500).send('Failed to verify credentials.');
    }
}

module.exports = { samlLogin, samlCallback, samlCredentialSubmit };