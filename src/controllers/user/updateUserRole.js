const axios = require('axios');
const { sql, getPool } = require('../../db/mssql');
const { getCtx } = require('../../env'); 
const { joinUrl } = require('../../utils/http');
const { logger } = require('../../services/logger');

const assignRole = require('../../services/bigfix/assignRole');
const unassignRole = require('../../services/bigfix/unassignRole');

async function updateUserRole(req, res) {
    try {
        const { id } = req.params;
        const { roles } = req.body;

        if (!Array.isArray(roles)) return res.status(400).json({ ok: false, error: 'Roles must be an array' });
        if ([9002, 9003, 9004].includes(Number(id))) return res.status(403).json({ ok: false, error: 'Cannot modify system users' });

        const pool = await getPool();
        const userRes = await pool.request().input('UserID', sql.Int, id).query('SELECT LoginName FROM dbo.USERS WHERE UserID = @UserID');
        if (userRes.recordset.length === 0) return res.status(404).json({ ok: false, error: 'User not found' });

        const username = userRes.recordset[0].LoginName;
        const ctx = getCtx();
        const { BIGFIX_BASE_URL, BIGFIX_USER, BIGFIX_PASS, httpsAgent } = ctx.bigfix;
        const auth = { username: BIGFIX_USER, password: BIGFIX_PASS };
        
        let oldRoles = [];
        if (BIGFIX_BASE_URL) {
            try {
                const rolesUrl = joinUrl(BIGFIX_BASE_URL, `/api/operator/${encodeURIComponent(username)}/roles`);
                const rolesResp = await axios.get(rolesUrl, { httpsAgent, auth, headers: { Accept: "application/xml" }, validateStatus: () => true });

                if (rolesResp.status === 200) {
                    const xml = String(rolesResp.data || "");
                    const roleBlocks = xml.split("</Role>");
                    for (const block of roleBlocks) {
                        const match = block.match(/<Name>(.*?)<\/Name>/i);
                        if (match) oldRoles.push(match[1].trim());
                    }
                }
            } catch (err) { logger.warn(`Failed to fetch current roles for ${username}: ${err.message}`); }
        }

        const rolesToAdd = roles.filter(r => !oldRoles.includes(r) && r !== 'Admin');
        const rolesToRemove = oldRoles.filter(r => !roles.includes(r) && r !== 'Admin');

        for (const roleToRemove of rolesToRemove) await unassignRole(username, roleToRemove);
        for (const roleToAdd of rolesToAdd) await assignRole(username, roleToAdd);

        const newRoleString = roles.join(', ');
        await pool.request()
            .input('Role', sql.NVarChar(4000), newRoleString) 
            .input('UserID', sql.Int, id)
            .query('UPDATE dbo.USERS SET Role = @Role, UpdatedAt = SYSUTCDATETIME() WHERE UserID = @UserID');

        res.json({ ok: true, message: `Roles updated successfully.` });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
}

module.exports = updateUserRole;