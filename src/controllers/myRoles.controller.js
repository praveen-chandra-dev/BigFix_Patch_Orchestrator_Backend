// src/controllers/myRoles.controller.js
const axios = require('axios');
const { getCtx } = require('../env');
const { joinUrl } = require('../utils/http');
const { getSessionData } = require('../middlewares/auth.middleware');

async function getMyRoles(req, res) {
    const session = getSessionData(req);
    if (!session) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    try {
        const ctx = getCtx();
        const { BIGFIX_BASE_URL, BIGFIX_USER, BIGFIX_PASS, httpsAgent } = ctx.bigfix;
        
        const actualRole = session.dbRole || session.role;
        const isAdminUser = actualRole && actualRole.toLowerCase() === 'admin';

        if (!BIGFIX_BASE_URL) {
            return res.json({ ok: true, isMO: isAdminUser, roles: isAdminUser ? ['Admin'] : [] });
        }

        const auth = { username: BIGFIX_USER, password: BIGFIX_PASS };
        
        let isMO = false;
        let roles = [];

        // 1. Check if user is a Master Operator
        const opUrl = joinUrl(BIGFIX_BASE_URL, `/api/operator/${encodeURIComponent(session.username)}`);
        const opResp = await axios.get(opUrl, { httpsAgent, auth, headers: { Accept: "application/xml" }, validateStatus: () => true });
        
        if (opResp.status === 200) {
            const xml = String(opResp.data || "");
            const moMatch = xml.match(/<MasterOperator>(.*?)<\/MasterOperator>/i);
            if (moMatch) isMO = moMatch[1].trim().toLowerCase() === "true" || moMatch[1].trim() === "1";
        }
        
        // 2. Fetch their roles
        const rolesUrl = joinUrl(BIGFIX_BASE_URL, `/api/operator/${encodeURIComponent(session.username)}/roles`);
        const rolesResp = await axios.get(rolesUrl, { httpsAgent, auth, headers: { Accept: "application/xml" }, validateStatus: () => true });

        if (rolesResp.status === 200) {
            const xml = String(rolesResp.data || "");
            const roleBlocks = xml.split("</Role>");
            for (const block of roleBlocks) {
                const match = block.match(/<Name>(.*?)<\/Name>/i);
                if (match) roles.push(match[1].trim());
            }
        }

        // 3. Format and return
        if (isAdminUser) {
            roles = ['Admin']; 
        } else {
            roles = [...new Set(roles)]; 
        }

        res.json({ ok: true, isMO, roles });
    } catch (e) { 
        res.status(500).json({ ok: false, error: e.message }); 
    }
}

module.exports = { getMyRoles };