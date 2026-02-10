// bigfix-backend/src/services/ldap.js
const { Client } = require('ldapts');
const { getCfg } = require('../env');
const { logger } = require('./logger');

/**
 * Attempts to authenticate the user against the configured LDAP server.
 */
async function authenticateLDAP(username, password) {
  const cfg = getCfg();
  
  // 1. Check if Enabled
  if (!cfg.LDAP_ENABLED) return false; 

  // 2. Validate Config
  const url = (cfg.LDAP_URL || "").trim();
  const domain = (cfg.LDAP_DOMAIN || "").trim();

  if (!url || !domain) {
      logger.warn("[LDAP] Enabled but missing URL or Domain configuration.");
      return false;
  }
  if (!username || !password) return false;

  const isStrict = !cfg.LDAP_ALLOW_SELF_SIGNED;
  const upn = `${username}@${domain}`;

  // Configure Client
  const client = new Client({
    url: url,
    tlsOptions: { 
        rejectUnauthorized: isStrict,
        // If allowing self-signed, also disable hostname validation to prevent resets
        checkServerIdentity: isStrict ? undefined : () => undefined 
    },
    strictDN: false, // <--- CRITICAL: Active Directory DNs often violate strict standards
    timeout: 10000,
    connectTimeout: 10000
  });

  try {
    logger.info(`[LDAP] Attempting auth for ${upn} at ${url} (SSL Strict: ${isStrict})`);
    
    await client.bind(upn, password);
    
    logger.info(`[LDAP] Auth success for ${username}`);
    return true;
  } catch (ex) {
    logger.warn(`[LDAP] Auth failed for ${username}: ${ex.message}`);
    
    if (ex.code === 'ECONNRESET') {
        logger.warn("[LDAP] Hint: Verify protocol matches port (ldaps:// for 636, ldap:// for 389) and 'Allow Self-Signed' is set correctly.");
    }
    return false;
  } finally {
    try { await client.unbind(); } catch (e) {}
  }
}

module.exports = { authenticateLDAP };