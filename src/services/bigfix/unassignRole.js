// src/services/bigfix/unassignRole.js
const axios = require('axios');
const { getCtx } = require('../../env');
const { joinUrl } = require('../../utils/http');
const { logger } = require('../logger');

// Returns { ok:boolean, reason:string } (backward-compatible: callers ignore it).
async function unassignRole(username, roleName) {
    if (!roleName || roleName === 'Admin') return { ok: true, reason: 'admin/no-op' };

    const ctx = getCtx();
    const { BIGFIX_BASE_URL, BIGFIX_USER, BIGFIX_PASS, httpsAgent } = ctx.bigfix;
    if (!BIGFIX_BASE_URL) return { ok: false, reason: 'BigFix not configured' };

    const auth = { username: BIGFIX_USER, password: BIGFIX_PASS };

    try {
        const rolesUrl = joinUrl(BIGFIX_BASE_URL, `/api/roles`);
        const rolesResp = await axios.get(rolesUrl, { httpsAgent, auth, headers: { Accept: "application/xml" }, validateStatus: () => true });

        let roleId = null;
        if (rolesResp.status === 200) {
            const xmlData = String(rolesResp.data || "");
            const roleBlocks = xmlData.split("</Role>");
            for (const block of roleBlocks) {
                if (block.includes(`<Name>${roleName}</Name>`) || block.includes(`>${roleName}<`)) {
                    const idMatch = block.match(/<ID>(\d+)<\/ID>/i);
                    if (idMatch) { roleId = idMatch[1]; break; }
                }
            }
        }
        if (!roleId) return { ok: false, reason: `Role '${roleName}' not found in BigFix (/api/roles -> HTTP ${rolesResp.status})` };

        const roleUrl = joinUrl(BIGFIX_BASE_URL, `/api/role/${roleId}`);
        const roleResp = await axios.get(roleUrl, { httpsAgent, auth, headers: { Accept: "application/xml" }, validateStatus: () => true });
        if (roleResp.status !== 200) {
            return { ok: false, reason: `Could not read role '${roleName}' (GET /api/role/${roleId} -> HTTP ${roleResp.status})` };
        }

        let roleXml = String(roleResp.data);
        const explicitRegex = new RegExp(`<Explicit>\\s*${username}\\s*</Explicit>`, 'gi');
        if (!explicitRegex.test(roleXml)) {
            return { ok: true, reason: 'was not a member' };
        }

        roleXml = roleXml.replace(explicitRegex, '');
        roleXml = roleXml.replace(/<Operators>\s*<\/Operators>/g, '<Operators/>');

        const putResp = await axios.put(roleUrl, roleXml, { httpsAgent, auth, headers: { "Content-Type": "application/xml" }, validateStatus: () => true });
        if (putResp.status < 200 || putResp.status >= 300) {
            logger.warn(`[RBAC] PUT /api/role/${roleId} ('${roleName}') during unassign -> HTTP ${putResp.status}: ${String(putResp.data || '').slice(0, 300)}`);
            return { ok: false, reason: `BigFix rejected the role update (HTTP ${putResp.status})` };
        }
        return { ok: true, reason: 'unassigned' };
    } catch (err) {
        logger.warn(`[RBAC] Failed to unassign '${username}' from '${roleName}': ${err.message}`);
        return { ok: false, reason: err.message };
    }
}

module.exports = unassignRole;