const axios = require('axios');
const { getPool } = require('../../db/mssql');
const { getCtx } = require('../../env'); 
const { joinUrl } = require('../../utils/http');
const { logger } = require('../../services/logger');

async function getUsers(req, res) {
    try {
        const pool = await getPool();
        const rs = await pool.request().query('SELECT UserID, LoginName, Role, CreatedAt FROM dbo.USERS ORDER BY LoginName');
        let users = rs.recordset;

        const ctx = getCtx();
        const { BIGFIX_BASE_URL, BIGFIX_USER, BIGFIX_PASS, httpsAgent } = ctx.bigfix;

        if (BIGFIX_BASE_URL) {
            const auth = { username: BIGFIX_USER, password: BIGFIX_PASS };
            
            await Promise.all(users.map(async (u) => {
                if (u.Role === 'Admin') return; 
                try {
                    const rolesUrl = joinUrl(BIGFIX_BASE_URL, `/api/operator/${encodeURIComponent(u.LoginName)}/roles`);
                    const rolesResp = await axios.get(rolesUrl, { httpsAgent, auth, headers: { Accept: "application/xml" }, validateStatus: () => true });

                    if (rolesResp.status === 200) {
                        const xml = String(rolesResp.data || "");
                        const roleBlocks = xml.split("</Role>");
                        let bfRoles = [];
                        for (const block of roleBlocks) {
                            const match = block.match(/<Name>(.*?)<\/Name>/i);
                            if (match) bfRoles.push(match[1].trim());
                        }
                        u.Role = bfRoles.length > 0 ? bfRoles.join(', ') : 'No Role Assigned';
                    }
                } catch (err) {
                    logger.warn(`Failed to fetch roles for ${u.LoginName}: ${err.message}`);
                }
            }));
        }

        res.json({ ok: true, users });
    } catch (e) { res.status(500).json({ ok:false, error: e.message }); }
}

module.exports = getUsers;