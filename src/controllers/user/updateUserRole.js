const axios = require('axios');
const { sql, getPool } = require('../../db/mssql');
const { getCtx } = require('../../env');
const { joinUrl } = require('../../utils/http');
const { logger } = require('../../services/logger');

const assignRole = require('../../services/bigfix/assignRole');
const unassignRole = require('../../services/bigfix/unassignRole');

// Read the operator's ACTUAL role membership from BigFix (source of truth).
async function readOperatorRoles(username, ctx) {
    const { BIGFIX_BASE_URL, BIGFIX_USER, BIGFIX_PASS, httpsAgent } = ctx.bigfix;
    if (!BIGFIX_BASE_URL) return [];
    const auth = { username: BIGFIX_USER, password: BIGFIX_PASS };
    const rolesUrl = joinUrl(BIGFIX_BASE_URL, `/api/operator/${encodeURIComponent(username)}/roles`);
    const resp = await axios.get(rolesUrl, { httpsAgent, auth, headers: { Accept: "application/xml" }, validateStatus: () => true });
    const out = [];
    if (resp.status === 200) {
        const xml = String(resp.data || "");
        for (const block of xml.split("</Role>")) {
            const m = block.match(/<Name>(.*?)<\/Name>/i);
            if (m) out.push(m[1].trim());
        }
    }
    return out;
}

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
        const bigfixConfigured = !!(ctx.bigfix && ctx.bigfix.BIGFIX_BASE_URL);

        let oldRoles = [];
        if (bigfixConfigured) {
            try { oldRoles = await readOperatorRoles(username, ctx); }
            catch (err) { logger.warn(`Failed to fetch current roles for ${username}: ${err.message}`); }
        }

        const rolesToAdd = roles.filter(r => !oldRoles.includes(r) && r !== 'Admin');
        const rolesToRemove = oldRoles.filter(r => !roles.includes(r) && r !== 'Admin');

        // Honor the result of each BigFix operation instead of assuming success.
        const failures = [];
        for (const roleToRemove of rolesToRemove) {
            const r = await unassignRole(username, roleToRemove);
            if (!r || r.ok !== true) failures.push(`remove '${roleToRemove}': ${r ? r.reason : 'unknown error'}`);
        }
        for (const roleToAdd of rolesToAdd) {
            const r = await assignRole(username, roleToAdd);
            if (!r || r.ok !== true) failures.push(`assign '${roleToAdd}': ${r ? r.reason : 'unknown error'}`);
        }

        // Persist the ACTUAL roles from BigFix so the DB never disagrees with what
        // GET /api/auth/users reads back. This was the source of the
        // "success in the UI but No Role Assigned on refresh" mismatch.
        let effectiveRoles = roles;
        if (bigfixConfigured) {
            try { effectiveRoles = await readOperatorRoles(username, ctx); }
            catch (err) { logger.warn(`Failed to re-read roles for ${username}: ${err.message}`); }
        }
        const roleString = effectiveRoles.length ? effectiveRoles.join(', ') : 'No Role Assigned';
        await pool.request()
            .input('Role', sql.NVarChar(4000), roleString)
            .input('UserID', sql.Int, id)
            .query('UPDATE dbo.USERS SET Role = @Role, UpdatedAt = SYSUTCDATETIME() WHERE UserID = @UserID');

        if (failures.length) {
            return res.status(502).json({
                ok: false,
                error: `Role change did not fully apply in BigFix: ${failures.join('; ')}`,
                effectiveRoles,
            });
        }

        res.json({ ok: true, message: 'Roles updated successfully.', effectiveRoles });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
}

module.exports = updateUserRole;