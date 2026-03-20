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

/**
 * STRICT SECURE CONTEXT:
 * - If `req` is null -> BACKGROUND TASK -> Uses Master Service Account
 * - If `req` exists -> USER TASK -> Strictly requires Personal BigFix Credentials
 */
async function getBfAuthContext(req, ctx) {
    const { BIGFIX_USER, BIGFIX_PASS, httpsAgent } = ctx.bigfix;
    
    // ==========================================
    // 1. BACKGROUND TASKS (No human user involved)
    // ==========================================
    if (!req) {
        return {
            httpsAgent,
            auth: { username: BIGFIX_USER, password: BIGFIX_PASS }
        };
    }

    // ==========================================
    // 2. HUMAN USER TASKS (Strictly personal)
    // ==========================================
    let requestUser = null;
    
    // Extract the exact user from the secure HTTP-Only cookie
    if (req.cookies && req.cookies.auth_session) {
        try {
            const sessionData = JSON.parse(req.cookies.auth_session);
            requestUser = sessionData.username;
        } catch (err) {
            console.error("[Auth Context] Failed to parse auth_session cookie");
        }
    }

    if (!requestUser) {
        throw new Error("Unauthorized: No active user session found.");
    }

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
            }
        }
    } catch (e) {
        console.error("[Auth Context] Failed to resolve DB credentials:", e.message);
    }

    // STRICT BLOCK: If the user hasn't saved a password, DO NOT fall back to Master. Throw error.
    if (!finalUser || !finalPass) {
         throw new Error("Missing personal BigFix API Credentials. Please go to Settings and verify your BigFix password.");
    }

    // Use their personal credentials for this action
    return {
        httpsAgent,
        auth: { username: finalUser, password: finalPass }
    };
}

module.exports = { joinUrl, toLowerSafe, splitEmails, escapeHtml, getBfAuthContext };