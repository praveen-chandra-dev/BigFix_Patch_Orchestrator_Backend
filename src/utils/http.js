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
 * NEW: Generates the Axios auth configuration dynamically based on the logged-in user.
 * If the user has an encrypted password in DB, it decrypts and uses it.
 * Otherwise, it falls back to the Master Service Account.
 */
async function getBfAuthContext(req, ctx) {
    const { BIGFIX_USER, BIGFIX_PASS, httpsAgent } = ctx.bigfix;
    
    let finalUser = BIGFIX_USER;
    let finalPass = BIGFIX_PASS;

    // The frontend must send the logged-in username in the header
    const requestUser = req.headers['x-active-user'];

    if (requestUser) {
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
    }

    return {
        httpsAgent,
        auth: { username: finalUser, password: finalPass }
    };
}

module.exports = { joinUrl, toLowerSafe, splitEmails, escapeHtml, getBfAuthContext };