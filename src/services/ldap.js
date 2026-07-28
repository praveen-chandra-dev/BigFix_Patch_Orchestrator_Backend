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
 * Standard LDAP Auth for Login, with SSL support and Just-In-Time DN Discovery.
 * Now also returns user's AD group memberships (memberOf) for role mapping.
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
    let groups = [];
    const searchBase = domain.split('.').map(part => `DC=${part}`).join(',');
    
    // STRATEGY 1: Use the Domain Base with the Patched Domain Scope Control
    try {
        const { searchEntries } = await client.search(searchBase, {
            filter: `(&(objectCategory=person)(objectClass=user)(userPrincipalName=${upn}))`,
            scope: 'sub',
            attributes: ['dn', 'distinguishedName', 'memberOf']
        }, [domainScopeControl]);
        
        if (searchEntries && searchEntries.length > 0) {
            dn = searchEntries[0].dn || searchEntries[0].distinguishedName;
            const memberOf = searchEntries[0].memberOf;
            groups = Array.isArray(memberOf) ? memberOf : (memberOf ? [memberOf] : []);
            logger.info(`[LDAP] Extracted DN via Strategy 1: ${dn}, Groups: ${groups.length}`);
        }
    } catch (err1) {
        logger.warn(`[LDAP] Strategy 1 encountered AD error: ${err1.message}. Attempting Strategy 2...`);
        
        // STRATEGY 2: Fallback to a Forest Root Search (Empty Base)
        try {
            const { searchEntries } = await client.search('', {
                filter: `(&(objectCategory=person)(objectClass=user)(userPrincipalName=${upn}))`,
                scope: 'sub',
                attributes: ['dn', 'distinguishedName', 'memberOf'],
                sizeLimit: 1
            });
            
            if (searchEntries && searchEntries.length > 0) {
                dn = searchEntries[0].dn || searchEntries[0].distinguishedName;
                const memberOf = searchEntries[0].memberOf;
                groups = Array.isArray(memberOf) ? memberOf : (memberOf ? [memberOf] : []);
                logger.info(`[LDAP] Extracted DN via Strategy 2: ${dn}, Groups: ${groups.length}`);
            }
        } catch (err2) {
            logger.warn(`[LDAP] Strategy 2 failed: ${err2.message}`);
        }
    }

    if (!dn) {
        logger.warn(`[LDAP] Extraction failed entirely. Could not resolve DN for BigFix.`);
    }

    return { authenticated: true, dn, groups };
  } catch (ex) {
    logger.warn(`[LDAP] SSL Auth failed: ${ex.message}`);
    return { authenticated: false };
  } finally {
    try { await client.unbind(); } catch (e) {}
  }
}

/**
 * Search AD for a user using the configured service account (LDAP_BIND_USER / LDAP_BIND_PASS).
 * Does NOT require the user's own password — used for "does this user exist in AD?" checks.
 * Returns: { found: boolean, dn?: string, groups?: string[], error?: string }
 */
async function searchUserInAD(username) {
  const cfg = getCfg();

  if (!cfg.LDAP_ENABLED) return { found: false };

  const url    = (cfg.LDAP_URL          || "").trim();
  const domain = (cfg.LDAP_DOMAIN       || "").trim();
  const bindUser = (cfg.LDAP_BIND_USER  || "").trim();
  const bindPass = (cfg.LDAP_BIND_PASSWORD  || "").trim();

  if (!url || !domain) {
      logger.warn("[LDAP Search] Missing URL or Domain configuration.");
      return { found: false, error: "ldap_not_configured" };
  }

  if (!bindUser || !bindPass) {
      logger.warn("[LDAP Search] LDAP_BIND_USER or LDAP_BIND_PASS not configured. Cannot verify AD user.");
      return { found: false, error: "service_account_not_configured" };
  }

  if (!username) return { found: false };

  const isStrict = String(cfg.LDAP_ALLOW_SELF_SIGNED).toLowerCase() !== 'true';
  const tlsOpts  = { rejectUnauthorized: isStrict };
  if (!isStrict) tlsOpts.checkServerIdentity = () => undefined;

  // Build service-account UPN if not already fully qualified
  let serviceUpn = bindUser;
  if (!bindUser.includes('@') && !bindUser.includes('\\')) {
      serviceUpn = `${bindUser}@${domain}`;
  }

  const client = new Client({
    url,
    tlsOptions: tlsOpts,
    strictDN: false,
    timeout: 10000,
    connectTimeout: 10000
  });

  try {
    await client.bind(serviceUpn, bindPass);
    logger.info(`[LDAP Search] Service account bound successfully: ${serviceUpn}`);

    const searchBase = domain.split('.').map(part => `DC=${part}`).join(',');

    // Normalise input: strip @domain if present to get sAMAccountName, or search by full UPN
    const upnTarget = username.includes('@') ? username : `${username}@${domain}`;

    // Build filter: match by UPN or sAMAccountName
    const samAccount = username.includes('@') ? username.split('@')[0] : username;
    const filter = `(&(objectCategory=person)(objectClass=user)(|(userPrincipalName=${upnTarget})(sAMAccountName=${samAccount})))`;

    let found   = false;
    let dn      = null;
    let groups  = [];

    // Strategy 1: domain scope control
    try {
        const { searchEntries } = await client.search(searchBase, {
            filter,
            scope: 'sub',
            attributes: ['dn', 'distinguishedName', 'memberOf', 'userPrincipalName']
        }, [domainScopeControl]);

        if (searchEntries && searchEntries.length > 0) {
            found  = true;
            dn     = searchEntries[0].dn || searchEntries[0].distinguishedName;
            const memberOf = searchEntries[0].memberOf;
            groups = Array.isArray(memberOf) ? memberOf : (memberOf ? [memberOf] : []);
            logger.info(`[LDAP Search] Found user '${username}' via Strategy 1. DN: ${dn}`);
        }
    } catch (err1) {
        logger.warn(`[LDAP Search] Strategy 1 failed: ${err1.message}. Trying Strategy 2...`);

        // Strategy 2: empty base (Global Catalog)
        try {
            const { searchEntries } = await client.search('', {
                filter,
                scope: 'sub',
                attributes: ['dn', 'distinguishedName', 'memberOf', 'userPrincipalName'],
                sizeLimit: 1
            });

            if (searchEntries && searchEntries.length > 0) {
                found  = true;
                dn     = searchEntries[0].dn || searchEntries[0].distinguishedName;
                const memberOf = searchEntries[0].memberOf;
                groups = Array.isArray(memberOf) ? memberOf : (memberOf ? [memberOf] : []);
                logger.info(`[LDAP Search] Found user '${username}' via Strategy 2. DN: ${dn}`);
            }
        } catch (err2) {
            logger.warn(`[LDAP Search] Strategy 2 failed: ${err2.message}`);
        }
    }

    if (!found) logger.info(`[LDAP Search] User '${username}' not found in AD.`);
    return { found, dn, groups };

  } catch (ex) {
    logger.warn(`[LDAP Search] Service account bind failed: ${ex.message}`);
    return { found: false, error: "bind_failed" };
  } finally {
    try { await client.unbind(); } catch (e) {}
  }
}

module.exports = { authenticateLDAP, searchUserInAD };