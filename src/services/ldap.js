// src/services/ldap.js
const { Client, Control } = require('ldapts');
const { getCfg } = require('../env');
const { logger } = require('./logger');

// Microsoft Domain Scope Control (OID: 1.2.840.113556.1.4.1339)
// Adding `value: ''` patches a bug in the ldapts library so its internal encoder doesn't crash
const domainScopeControl = new Control({
    type: '1.2.840.113556.1.4.1339',
    criticality: false,
    value: '' 
});

/**
 * Standard LDAP Auth for Login, with SSL support and Just-In-Time DN Discovery
 */
async function authenticateLDAP(username, password) {
  const cfg = getCfg();
  
  if (!cfg.LDAP_ENABLED) return { authenticated: false }; 

  let url = (cfg.LDAP_URL || "").trim();
  const domain = (cfg.LDAP_DOMAIN || "").trim();

  if (!url || !domain) {
      logger.warn("[LDAP] Missing URL or Domain configuration.");
      return { authenticated: false };
  }
  if (!username || !password) return { authenticated: false };

  const isStrict = String(cfg.LDAP_ALLOW_SELF_SIGNED).toLowerCase() !== 'true';
  
  let upn = username;
  if (!username.includes('@') && !username.includes('\\')) {
      upn = `${username}@${domain}`;
  }

  const tlsOpts = { rejectUnauthorized: isStrict };
  if (!isStrict) tlsOpts.checkServerIdentity = () => undefined;

  const client = new Client({
    url: url,
    tlsOptions: tlsOpts,
    strictDN: false, 
    timeout: 10000,
    connectTimeout: 10000
  });

  try {
    // 1. Authenticate user over SSL
    await client.bind(upn, password);
    logger.info(`[LDAP] Successful SSL bind for ${upn}`);
    
    let dn = null;
    const searchBase = domain.split('.').map(part => `DC=${part}`).join(',');
    
    // STRATEGY 1: Use the Domain Base with the Patched Domain Scope Control
    try {
        const { searchEntries } = await client.search(searchBase, {
            filter: `(&(objectCategory=person)(objectClass=user)(userPrincipalName=${username}))`,
            scope: 'sub',
            attributes: ['dn', 'distinguishedName']
        }, [domainScopeControl]);
        
        if (searchEntries && searchEntries.length > 0) {
            dn = searchEntries[0].dn || searchEntries[0].distinguishedName;
            logger.info(`[LDAP] Extracted DN via Strategy 1: ${dn}`);
        }
    } catch (err1) {
        logger.warn(`[LDAP] Strategy 1 encountered AD error: ${err1.message}. Attempting Strategy 2...`);
        
        // STRATEGY 2: Fallback to a Forest Root Search (Empty Base)
        // Querying the Global Catalog with an empty base natively bypasses domain referrals
        try {
            const { searchEntries } = await client.search('', {
                filter: `(&(objectCategory=person)(objectClass=user)(userPrincipalName=${username}))`,
                scope: 'sub',
                attributes: ['dn', 'distinguishedName'],
                sizeLimit: 1
            });
            
            if (searchEntries && searchEntries.length > 0) {
                dn = searchEntries[0].dn || searchEntries[0].distinguishedName;
                logger.info(`[LDAP] Extracted DN via Strategy 2: ${dn}`);
            }
        } catch (err2) {
            logger.warn(`[LDAP] Strategy 2 failed: ${err2.message}`);
        }
    }

    if (!dn) {
        logger.warn(`[LDAP] Extraction failed entirely. Could not resolve DN for BigFix.`);
    }

    return { authenticated: true, dn };
  } catch (ex) {
    logger.warn(`[LDAP] SSL Auth failed: ${ex.message}`);
    return { authenticated: false };
  } finally {
    try { await client.unbind(); } catch (e) {}
  }
}

module.exports = { authenticateLDAP };