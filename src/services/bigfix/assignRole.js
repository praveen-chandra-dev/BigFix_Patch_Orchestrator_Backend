// src/services/bigfix/assignRole.js
const axios = require('axios');
const { getCtx } = require('../../env');
const { joinUrl } = require('../../utils/http');
const { logger } = require('../logger');

async function assignRole(username, roleName) {
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
            const explicitTag = `<Explicit>${username}</Explicit>`;
            
            if (roleXml.includes(explicitTag)) return true;

            roleXml = roleXml.replace(/<Operators\s*\/>/gi, '');

            if (roleXml.includes('<Operators>')) {
                roleXml = roleXml.replace('<Operators>', `<Operators>\n<Explicit>${username}</Explicit>`);
            } else {
                roleXml = roleXml.replace('</Role>', `<Operators>\n<Explicit>${username}</Explicit>\n</Operators>\n</Role>`);
            }

            await axios.put(roleUrl, roleXml, { httpsAgent, auth, headers: { "Content-Type": "application/xml" } });
            return true;
        }
    } catch (err) {
        if (err.response && err.response.status === 400) return false; 
        logger.warn(`[RBAC] Failed to assign user to role in BigFix: ${err.message}`);
        return false;
    }
    return false;
}

module.exports = assignRole;