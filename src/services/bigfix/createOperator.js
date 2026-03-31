// src/services/bigfix/createOperator.js
const axios = require('axios');
const { getCtx } = require('../../env');
const { joinUrl } = require('../../utils/http');
const { logger } = require('../logger');

async function createOperator(username, isLdap, plainPassword = null, ldapDN = null, isMaster = false) {
    const ctx = getCtx();
    const { BIGFIX_BASE_URL, BIGFIX_USER, BIGFIX_PASS, httpsAgent } = ctx.bigfix;
    
    if (!BIGFIX_BASE_URL) return false;

    const postUrl = joinUrl(BIGFIX_BASE_URL, "/api/operators");
    let xml = "";

    if (!isLdap) {
        xml = `<?xml version="1.0" encoding="UTF-8"?><BESAPI xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="BESAPI.xsd"><Operator><Name>${username}</Name><Password>${plainPassword}</Password><MasterOperator>${isMaster ? 'true' : 'false'}</MasterOperator></Operator></BESAPI>`;
    } else {
        if (!ldapDN) {
            logger.warn(`[RBAC] LDAP DN missing for ${username}. Cannot create BigFix operator.`);
            return false;
        }

        const dirUrl = joinUrl(BIGFIX_BASE_URL, "/api/ldapdirectories");
        let dirResp;
        try {
            dirResp = await axios.get(dirUrl, {
                httpsAgent, auth: { username: BIGFIX_USER, password: BIGFIX_PASS }, headers: { Accept: "application/xml" }
            });
        } catch (e) {
            logger.warn(`[RBAC] Failed to query BigFix LDAP Directories. Ensure AD is integrated in BigFix.`);
            return false; 
        }
        
        let serverId = null;
        if (dirResp.data) {
            const resData = String(dirResp.data);
            const idMatch = resData.match(/<ID>(\d+)<\/ID>/i);
            if (idMatch) serverId = idMatch[1];
        }

        if (!serverId) {
            logger.warn(`[RBAC] Could not locate LDAP Server ID in BigFix. Cannot create LDAP user.`);
            return false;
        }
        
        xml = `<?xml version="1.0" encoding="UTF-8"?><BESAPI xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="BESAPI.xsd"><Operator><Name>${username}</Name><LDAPServerID>${serverId}</LDAPServerID><LDAPDN>${ldapDN}</LDAPDN><MasterOperator>${isMaster ? 'true' : 'false'}</MasterOperator></Operator></BESAPI>`;
    }

    try {
        const resp = await axios.post(postUrl, xml, {
            httpsAgent, auth: { username: BIGFIX_USER, password: BIGFIX_PASS }, headers: { "Content-Type": "application/xml" }
        });
        return resp.status === 200;
    } catch (e) {
        const errBody = e.response?.data ? String(e.response.data) : e.message;
        if (errBody.includes("already exists") || errBody.includes("unique constraint")) return true; 
        logger.warn(`[RBAC] BigFix rejected operator creation: ${errBody.substring(0, 150)}`);
        return false;
    }
}

module.exports = createOperator;