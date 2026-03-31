// src/services/bigfix/unassignRole.js
const axios = require('axios');
const { getCtx } = require('../../env');
const { joinUrl } = require('../../utils/http');
const { logger } = require('../logger');

async function unassignRole(username, roleName) {
    if (!roleName || roleName === 'Admin') return true;

    const ctx = getCtx();
    const { BIGFIX_BASE_URL, BIGFIX_USER, BIGFIX_PASS, httpsAgent } = ctx.bigfix;
    if (!BIGFIX_BASE_URL) return false;

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

        if (!roleId) return false;

        const roleUrl = joinUrl(BIGFIX_BASE_URL, `/api/role/${roleId}`);
        const roleResp = await axios.get(roleUrl, { httpsAgent, auth, headers: { Accept: "application/xml" }, validateStatus: () => true });

        if (roleResp.status === 200) {
            let roleXml = String(roleResp.data);
            
            const explicitRegex = new RegExp(`<Explicit>\\s*${username}\\s*</Explicit>`, 'gi');
            
            if (!explicitRegex.test(roleXml)) {
                return true; 
            }

            roleXml = roleXml.replace(explicitRegex, '');
            roleXml = roleXml.replace(/<Operators>\s*<\/Operators>/g, '<Operators/>');

            await axios.put(roleUrl, roleXml, { httpsAgent, auth, headers: { "Content-Type": "application/xml" } });
            return true;
        }
    } catch (err) {
        logger.warn(`[RBAC] Failed to unassign user from old role in BigFix: ${err.message}`);
        return false;
    }
    return false;
}

module.exports = unassignRole;