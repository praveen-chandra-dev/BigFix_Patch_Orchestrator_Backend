// src/services/bigfix/verifyCredentials.js
const axios = require('axios');
const { getCtx } = require('../../env');
const { joinUrl } = require('../../utils/http');
const { logger } = require('../logger');

async function verifyCredentials(username, password) {
    const ctx = getCtx();
    const { BIGFIX_BASE_URL, httpsAgent } = ctx.bigfix;
    
    if (!BIGFIX_BASE_URL) {
        logger.error(`[BigFix Auth] FAILED: BIGFIX_BASE_URL is not configured yet.`);
        return false;
    }

    try {
        logger.info(`[BigFix Auth] Verifying BigFix credentials for operator: '${username}'...`);
        const url = joinUrl(BIGFIX_BASE_URL, '/api/login');
        await axios.get(url, { httpsAgent, auth: { username, password } });
        logger.info(`[BigFix Auth] SUCCESS! Credentials accepted for '${username}'.`);
        return true; 
    } catch (e) { 
        const status = e.response ? e.response.status : 'Network Error';
        logger.error(`[BigFix Auth] FAILED for operator '${username}'. API returned Status: ${status}`);
        return false; 
    }
}

module.exports = verifyCredentials;