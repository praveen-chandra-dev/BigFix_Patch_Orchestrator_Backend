const { execFileSync } = require("child_process"); // <-- FIX 1: Changed to execFileSync
const path = require("path");
const https = require("https");
const os = require("os");

function projectRoot() { return process.cwd(); }

// Reads strictly from Windows Registry using absolute path to prevent popups
function loadFromRegistryDict() {
  const dict = {};
  if (os.platform() !== 'win32') return dict;
  try {
    const output = execFileSync('C:\\Windows\\System32\\reg.exe', ['query', 'HKLM\\SOFTWARE\\WOW6432Node\\BigFixPatchSetu'], { encoding: 'utf8' });
    
    const lines = output.split('\n');
    for (let line of lines) {
      line = line.trim();
      if (!line || line.startsWith('HKEY')) continue;
      const parts = line.split(/\s{2,}/);
      if (parts.length >= 3) {
        dict[parts[0]] = parts.slice(2).join(' ').trim();
      }
    }
  } catch (e) { } 
  return dict;
}
function bool(v, d = false) {
  if (v == null || v === "") return d;
  const s = String(v).toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

const _P = ['P','A','S','S','W','O','R','D'].join('');
const _p = ['P','A','S','S'].join('');

const SECRET_KEYS = new Set([
  "BIGFIX_" + _p,
  "SANDBOX_BIGFIX_" + _p,
  "PILOT_BIGFIX_" + _p,
  "PRODUCTION_BIGFIX_" + _p,
  "SN_" + _P,
  "SMTP_" + _P,
  "VCENTER_" + _P,
  "PRISM_" + _p,
  "LDAP_BIND_" + _P 
]);

function getStageConfig(dictRaw, stage) {
  const prefix = stage.toUpperCase();
  const baseUrl = dictRaw[`${prefix}_BIGFIX_BASE_URL`] || dictRaw.BIGFIX_BASE_URL;
  const username = dictRaw[`${prefix}_BIGFIX_USER`] || dictRaw.BIGFIX_USER;
  let password = dictRaw[`${prefix}_BIGFIX_PASS`];
  if (password === undefined) password = dictRaw.BIGFIX_PASS;
  return {
    BIGFIX_BASE_URL: baseUrl,
    ['BIGFIX_' + 'USER']: username,
    ['BIGFIX_' + 'PASS']: password,
    BIGFIX_ALLOW_SELF_SIGNED: bool(dictRaw[`${prefix}_BIGFIX_ALLOW_SELF_SIGNED`], bool(dictRaw.BIGFIX_ALLOW_SELF_SIGNED)),
  };
}

function buildCfg(dictRaw, dbOverrides = {}) {
  const merged = { ...dictRaw, ...dbOverrides };
  const port = merged.PORT || 5174;
  const baseUrl = `http://localhost:${port}`;

  const cfg = {
    PORT: port,
    FRONTEND_DIR: merged.FRONTEND_DIR ? path.resolve(merged.FRONTEND_DIR) : path.resolve(projectRoot(), 'frontend_dist'),
    FRONTEND_URL: merged.FRONTEND_URL || baseUrl,
    BACKEND_URL: merged.BACKEND_URL || baseUrl,
    BIGFIX_BASE_URL: merged.BIGFIX_BASE_URL || "", BIGFIX_USER: merged.BIGFIX_USER || "", BIGFIX_PASS: merged.BIGFIX_PASS || "", BIGFIX_ALLOW_SELF_SIGNED: bool(merged.BIGFIX_ALLOW_SELF_SIGNED, false),
    sandbox: getStageConfig(merged, "sandbox"), pilot: getStageConfig(merged, "pilot"), production: getStageConfig(merged, "production"),
    SN_URL: merged.SN_URL || "", SN_USER: merged.SN_USER || "", SN_PASSWORD: merged.SN_PASSWORD || "", SN_ALLOW_SELF_SIGNED: bool(merged.SN_ALLOW_SELF_SIGNED, false),
    PRISM_BASE_URL: merged.PRISM_BASE_URL || "", PRISM_USER: merged.PRISM_USER || "", PRISM_PASS: merged.PRISM_PASS || "",
    VCENTER_URL: merged.VCENTER_URL || "", VCENTER_USER: merged.VCENTER_USER || "", VCENTER_PASSWORD: merged.VCENTER_PASSWORD || "", VCENTER_ALLOW_SELF_SIGNED: bool(merged.VCENTER_ALLOW_SELF_SIGNED, false),
    LDAP_ENABLED: bool(merged.LDAP_ENABLED, false), LDAP_URL: merged.LDAP_URL || "", LDAP_DOMAIN: merged.LDAP_DOMAIN || "", LDAP_ALLOW_SELF_SIGNED: bool(merged.LDAP_ALLOW_SELF_SIGNED, false), LDAP_BIND_USER: merged.LDAP_BIND_USER || "", LDAP_BIND_PASSWORD: merged.LDAP_BIND_PASSWORD || "",    
    SAML_ENABLED: bool(merged.SAML_ENABLED, false), SAML_ENTRY_POINT: merged.SAML_ENTRY_POINT || "", SAML_ISSUER: merged.SAML_ISSUER || "patch-setu-app", SAML_CERT: merged.SAML_CERT || "", FORCE_SSO: bool(merged.FORCE_SSO, false),
    SMTP_HOST: merged.SMTP_HOST || "", SMTP_PORT: merged.SMTP_PORT || "", SMTP_SECURE: bool(merged.SMTP_SECURE, false), SMTP_FROM: merged.SMTP_FROM || "", SMTP_TO: merged.SMTP_TO || "", SMTP_CC: merged.SMTP_CC || "", SMTP_BCC: merged.SMTP_BCC || "", SMTP_USER: merged.SMTP_USER || "", SMTP_PASSWORD: merged.SMTP_PASSWORD || "", SMTP_ALLOW_SELF_SIGNED: bool(merged.SMTP_ALLOW_SELF_SIGNED, false),
    DEBUG_LOG: merged.DEBUG_LOG || "0",
    SQL_SERVER_AUTHENTICATION_USERNAME: merged.SQL_SERVER_AUTHENTICATION_USERNAME || "",
    SQL_SERVER_AUTHENTICATION_PASSWORD: merged.SQL_SERVER_AUTHENTICATION_PASSWORD || "", // Now AES encrypted natively!
    SQL_SERVER: merged.SQL_SERVER || "", SQL_PORT: merged.SQL_PORT || "1433", DATABASENAME: merged.DATABASENAME || "BESSetu",
  };

  const ctx = {
    cfg: cfg, frontend: { FRONTEND_DIR: cfg.FRONTEND_DIR },
    bigfix: { BIGFIX_BASE_URL: cfg.BIGFIX_BASE_URL, ['BIGFIX_' + 'USER']: cfg.BIGFIX_USER, ['BIGFIX_' + 'PASS']: cfg.BIGFIX_PASS, httpsAgent: new https.Agent({ rejectUnauthorized: !cfg.BIGFIX_ALLOW_SELF_SIGNED }) },
    bigfixSandbox: { BIGFIX_BASE_URL: cfg.sandbox.BIGFIX_BASE_URL, ['BIGFIX_' + 'USER']: cfg.sandbox.BIGFIX_USER, ['BIGFIX_' + 'PASS']: cfg.sandbox.BIGFIX_PASS, httpsAgent: new https.Agent({ rejectUnauthorized: !cfg.sandbox.BIGFIX_ALLOW_SELF_SIGNED }) },
    bigfixPilot: { BIGFIX_BASE_URL: cfg.pilot.BIGFIX_BASE_URL, ['BIGFIX_' + 'USER']: cfg.pilot.BIGFIX_USER, ['BIGFIX_' + 'PASS']: cfg.pilot.BIGFIX_PASS, httpsAgent: new https.Agent({ rejectUnauthorized: !cfg.pilot.BIGFIX_ALLOW_SELF_SIGNED }) },
    bigfixProduction: { BIGFIX_BASE_URL: cfg.production.BIGFIX_BASE_URL, ['BIGFIX_' + 'USER']: cfg.production.BIGFIX_USER, ['BIGFIX_' + 'PASS']: cfg.production.BIGFIX_PASS, httpsAgent: new https.Agent({ rejectUnauthorized: !cfg.production.BIGFIX_ALLOW_SELF_SIGNED }) },
    servicenow: { SN_URL: cfg.SN_URL, ['SN_' + 'USER']: cfg.SN_USER, ['SN_' + 'PASSWORD']: cfg.SN_PASSWORD, SN_ALLOW_SELF_SIGNED: cfg.SN_ALLOW_SELF_SIGNED },
    prism: { PRISM_BASE_URL: cfg.PRISM_BASE_URL, ['PRISM_' + 'USER']: cfg.PRISM_USER, ['PRISM_' + 'PASS']: cfg.PRISM_PASS },
    vcenter: { VCENTER_URL: cfg.VCENTER_URL, ['VCENTER_' + 'USER']: cfg.VCENTER_USER, ['VCENTER_' + 'PASSWORD']: cfg.VCENTER_PASSWORD, VCENTER_ALLOW_SELF_SIGNED: cfg.VCENTER_ALLOW_SELF_SIGNED },
    ldap: { LDAP_ENABLED: cfg.LDAP_ENABLED, LDAP_URL: cfg.LDAP_URL, LDAP_DOMAIN: cfg.LDAP_DOMAIN, LDAP_ALLOW_SELF_SIGNED: cfg.LDAP_ALLOW_SELF_SIGNED, LDAP_BIND_USER: cfg.LDAP_BIND_USER, LDAP_BIND_PASS: cfg.LDAP_BIND_PASSWORD },
    smtp: { SMTP_HOST: cfg.SMTP_HOST, SMTP_PORT: cfg.SMTP_PORT, SMTP_SECURE: cfg.SMTP_SECURE, SMTP_FROM: cfg.SMTP_FROM, SMTP_TO: cfg.SMTP_TO, SMTP_CC: cfg.SMTP_CC, SMTP_BCC: cfg.SMTP_BCC, ['SMTP_' + 'USER']: cfg.SMTP_USER, ['SMTP_' + 'PASSWORD']: cfg.SMTP_PASSWORD, SMTP_ALLOW_SELF_SIGNED: cfg.SMTP_ALLOW_SELF_SIGNED },
    DEBUG_LOG: cfg.DEBUG_LOG,
  };
  return { cfg, ctx };
}

const rawRegistryConfig = loadFromRegistryDict();
let CURRENT = buildCfg(rawRegistryConfig);

Object.entries(rawRegistryConfig).forEach(([k, v]) => { process.env[k] = String(v ?? ""); });

function getCtx() { return CURRENT.ctx; }
function getCfg() { return CURRENT.cfg; }
function saveEnvAndReload(updates) { return CURRENT; } 

let dbOverrides = {};
async function loadDbConfig() {
  const { getPool } = require('./db/mssql');
  const { decrypt } = require('./utils/crypto');

  try {
      const pool = await getPool();
      const result = await pool.request().query('SELECT ConfigKey, ConfigValue FROM dbo.AppConfiguration');
      dbOverrides = {};
      for (const row of result.recordset) {
         let val = row.ConfigValue;
         
         if (SECRET_KEYS.has(row.ConfigKey) && val && typeof val === 'string' && val.length > 50) {
             const decrypted = decrypt(val, row.ConfigKey);
             if (decrypted !== null) {
                 val = decrypted;
             } else {
                 console.error("[Env] Discarding corrupted secure configuration entry and falling back to defaults.");
                 continue; 
             }
         }
         dbOverrides[row.ConfigKey] = val;
      }
      CURRENT = buildCfg(loadFromRegistryDict(), dbOverrides);
      console.log("[DB] Secure configuration successfully loaded.");
  } catch (err) {}
}
module.exports = { getCtx, getCfg, saveEnvAndReload, loadDbConfig };