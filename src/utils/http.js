// src/utils/http.js
const { sql, getPool } = require('../db/mssql');
const { decrypt } = require('./crypto');

function joinUrl(base, path) {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
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
    if (req && req.cookies && req.cookies.auth_session) {
        try { return JSON.parse(req.cookies.auth_session).username; } catch(e){}
    }
    return (req && req.headers) ? req.headers['x-active-user'] || "unknown" : "unknown";
}

function getSessionRole(req) {
    if (req && req.cookies && req.cookies.auth_session) {
        try { return JSON.parse(req.cookies.auth_session).role; } catch(e){}
    }
    return null;
}

async function getBfAuthContext(req, ctx) {
    const { BIGFIX_USER, BIGFIX_PASS, httpsAgent } = ctx.bigfix;

    if (!req) {
        return { httpsAgent, auth: { username: BIGFIX_USER, password: BIGFIX_PASS } };
    }

    let requestUser = null;
    if (req.cookies && req.cookies.auth_session) {
        try { requestUser = JSON.parse(req.cookies.auth_session).username; } catch (err) {}
    }
    if (!requestUser && req.headers['x-active-user']) {
        requestUser = req.headers['x-active-user'];
    }

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
                throw new Error("401_UNAUTHORIZED: Unable to decrypt your stored BigFix credentials. Please re‑enter them in the vault.");
            }
        }
    } catch (e) {
        console.error("[Auth Context] Failed to resolve DB credentials:", e.message);
        throw e; // Re-throw the same error so the caller knows it's a 401
    }

    if (!finalUser || !finalPass) {
        throw new Error("401_UNAUTHORIZED: Missing personal BigFix API Credentials.");
    }

    return { httpsAgent, auth: { username: finalUser, password: finalPass } };
}

module.exports = { joinUrl, toLowerSafe, splitEmails, escapeHtml, escapeXML, getSessionUser, getSessionRole, getBfAuthContext };