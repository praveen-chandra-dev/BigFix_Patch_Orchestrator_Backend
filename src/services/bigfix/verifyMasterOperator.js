const axios = require('axios');
const { getCtx } = require('../../env');
const { joinUrl } = require('../../utils/http');
const { logger } = require('../logger');

async function verifyMasterOperator(username, password) {
    const ctx = getCtx();
    const { BIGFIX_BASE_URL, httpsAgent } = ctx.bigfix;

    try {
        // 1. Check if the credentials work at all
        const loginUrl = joinUrl(BIGFIX_BASE_URL, '/api/login');
        await axios.get(loginUrl, { httpsAgent, auth: { username, password } });

        // 2. Fetch the operator's details
        const opUrl = joinUrl(BIGFIX_BASE_URL, `/api/operator/${encodeURIComponent(username)}`);
        const opResp = await axios.get(opUrl, { 
            httpsAgent, 
            auth: { username, password }, 
            headers: { Accept: "application/xml" },
            validateStatus: () => true
        });

        if (opResp.status === 403 || opResp.status === 401) return false;
        if (opResp.status !== 200) throw new Error("Operator fetch failed.");

        // 3. Parse XML for Master Operator flag
        const xml = String(opResp.data || "");
        const moMatch = xml.match(/<MasterOperator>(.*?)<\/MasterOperator>/i);
        
        return moMatch && (moMatch[1].trim().toLowerCase() === "true" || moMatch[1].trim() === "1");

    } catch (err) {
        logger.warn(`[Setup] MO Verification failed for ${username}: ${err.message}`);
        return false; // Invalid creds or network error
    }
}

module.exports = verifyMasterOperator;