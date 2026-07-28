// src/utils/http.js
const { sql, getPool } = require('../db/mssql');
const { decrypt } = require('./crypto');

function joinUrl(base, path) {
  return `${base.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

function toLowerSafe(x) { return String(x || "").toLowerCase(); }

function splitEmails(s) {
  return String(s || "").split(/[;,]/).map(v => v.trim()).filter(Boolean);
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeXML(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function getSessionUser(req) {
    // Vulnerability 8 partial fix: ONLY read from the server-side validated session.
    // Never fall back to client-supplied x-active-user headers.
    if (req && req.session && req.session.Username) {
        return req.session.Username;
    }
    return 'unknown';
}

// function getSessionRole(req) {
//     if (req && req.session && req.session.Role) {
//         return req.session.Role;
//     }
//     return null;
// }

function getSessionRole(req) {
    if (req && req.session && req.session.Role) {
        const assignedRoles = req.session.Role.split(',').map(r => r.trim());
        let requestedRole = req.headers['x-user-role'] || (req.cookies && req.cookies.active_role);

        if (requestedRole) {
            if (requestedRole.includes(',')) requestedRole = requestedRole.split(',')[0].trim();
            if (assignedRoles.includes('Admin') || assignedRoles.includes(requestedRole)) {
                return requestedRole;
            }
        }
        return assignedRoles[0];
    }
    return null;
}
async function getBfAuthContext(req, ctx) {
    const { BIGFIX_USER, BIGFIX_PASS, httpsAgent } = ctx.bigfix;

    if (!req) {
        return { httpsAgent, auth: { username: BIGFIX_USER, password: BIGFIX_PASS } };
    }

    let requestUser = null;
    // Use the server-validated session instead of parsing the cookie directly
    if (req.session && req.session.Username) {
        requestUser = req.session.Username;
    }
    // Vulnerability 8 fix: do NOT fall back to x-active-user header.
    // The header is client-controlled and must not be trusted for auth context.

    if (!requestUser) throw new Error("401_UNAUTHORIZED: No active user session found.");

    let finalUser = null;
    let finalPass = null;

    try {
        const pool = await getPool();
        const rs = await pool.request()
            .input('LoginName', sql.NVarChar(128), requestUser)
            .query('SELECT BfPasswordEncrypted FROM dbo.USERS WHERE LoginName = @LoginName');

        if (rs.recordset.length > 0 && rs.recordset[0].BfPasswordEncrypted) {
            const decrypted = decrypt(rs.recordset[0].BfPasswordEncrypted);
            if (decrypted) {
                finalUser = requestUser;
                finalPass = decrypted;
            } else {
                throw new Error("401 UNAUTHORIZED: Unable to validate your stored BigFix tokens. Please re‑enter them in the vault.");
            }
        }
    } catch (e) {
        console.error("[Auth Context] Failed to resolve DB tokens. Aborting request.");
        throw e; 
    }

    if (!finalUser || !finalPass) {
        throw new Error("401 UNAUTHORIZED: Missing personal BigFix API Tokens.");
    }

    return { httpsAgent, auth: { username: finalUser, password: finalPass } };
}

module.exports = { joinUrl, toLowerSafe, splitEmails, escapeHtml, escapeXML, getSessionUser, getSessionRole, getBfAuthContext };