const axios = require('axios');
const { getCtx } = require('../../env'); 
const { joinUrl } = require('../../utils/http');

async function getAllRoles(req, res) {
    try {
        const ctx = getCtx();
        const { BIGFIX_BASE_URL, BIGFIX_USER, BIGFIX_PASS, httpsAgent } = ctx.bigfix;
        
        if (!BIGFIX_BASE_URL) return res.json({ ok: true, roles: [] });

        const auth = { username: BIGFIX_USER, password: BIGFIX_PASS };
        const rolesUrl = joinUrl(BIGFIX_BASE_URL, `/api/roles`);
        const rolesResp = await axios.get(rolesUrl, { httpsAgent, auth, headers: { Accept: "application/xml" }, validateStatus: () => true });
        
        let allRoles = [];
        if (rolesResp.status === 200) {
            const xmlData = String(rolesResp.data || "");
            const roleBlocks = xmlData.split("</Role>");
            for (const block of roleBlocks) {
                const nameMatch = block.match(/<Name>(.*?)<\/Name>/i);
                if (nameMatch) allRoles.push(nameMatch[1].trim());
            }
        }
        res.json({ ok: true, roles: allRoles });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
}

module.exports = getAllRoles;