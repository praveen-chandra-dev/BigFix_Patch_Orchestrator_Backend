const fs = require("fs");
const path = require("path");
const https = require("https");
const os = require("os");
const crypto = require("crypto");

function projectRoot() { return process.cwd(); }
function envPath() { return path.resolve(projectRoot(), ".env"); }

function readEnvFile() {
  const p = envPath();
  if (!fs.existsSync(p)) return [];
  const raw = fs.readFileSync(p, "utf8");
  const lines = raw.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    if (!line || line.trim().startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i === -1) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1);
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out.push({ key: k, value: v });
  }
  return out;
}

function toEnvContent(dict, order = []) {
  const keys = [];
  const seen = new Set();
  order.forEach(k => { if (k in dict) { keys.push(k); seen.add(k); } });
  Object.keys(dict).sort().forEach(k => { if (!seen.has(k)) keys.push(k); });
  const lines = keys.map(k => {
    let v = dict[k] ?? "";
    if (/[^\w@%+:/.,\-]/.test(v)) v = JSON.stringify(String(v));
    return `${k}=${v}`;
  });
  lines.push("");
  return lines.join(os.EOL);
}

const UI_KEYS = new Set([
  "SESSION_TIMEOUT",
  "PORT",
  "BIGFIX_ALLOW_SELF_SIGNED", "BIGFIX_BASE_URL", "BIGFIX_USER", "BIGFIX_PASS",
  "SANDBOX_BIGFIX_ALLOW_SELF_SIGNED", "SANDBOX_BIGFIX_BASE_URL", "SANDBOX_BIGFIX_USER", "SANDBOX_BIGFIX_PASS",
  "PILOT_BIGFIX_ALLOW_SELF_SIGNED", "PILOT_BIGFIX_BASE_URL", "PILOT_BIGFIX_USER", "PILOT_BIGFIX_PASS",
  "PRODUCTION_BIGFIX_ALLOW_SELF_SIGNED", "PRODUCTION_BIGFIX_BASE_URL", "PRODUCTION_BIGFIX_USER", "PRODUCTION_BIGFIX_PASS",
  "SN_ALLOW_SELF_SIGNED", "SN_URL", "SN_USER", "SN_PASSWORD",
  "PRISM_BASE_URL", "PRISM_USER", "PRISM_PASS",
  "VCENTER_URL", "VCENTER_USER", "VCENTER_PASSWORD", "VCENTER_ALLOW_SELF_SIGNED",
  "SMTP_ALLOW_SELF_SIGNED", "SMTP_HOST", "SMTP_PORT", "SMTP_SECURE",
  "SMTP_FROM", "SMTP_TO", "SMTP_CC", "SMTP_BCC",
  "SMTP_USER", "SMTP_PASSWORD",
  "LDAP_ENABLED", "LDAP_URL", "LDAP_DOMAIN", "LDAP_ALLOW_SELF_SIGNED",
  "DEBUG_LOG",
]);

function writeEnvFull(fullDict) {
  const p = envPath();
  const existing = readEnvFile();
  const order = existing.map(i => i.key);
  const dictToSave = {};
  for (const k in fullDict) { dictToSave[k] = String(fullDict[k] ?? ""); }
  const data = toEnvContent(dictToSave, order);
  fs.writeFileSync(p, data, { encoding: "utf8", mode: 0o600 });
  return { path: p };
}

const SECRET_KEYS = new Set([
  "BIGFIX_PASS", "SANDBOX_BIGFIX_PASS", "PILOT_BIGFIX_PASS", "PRODUCTION_BIGFIX_PASS",
  "SN_PASSWORD", "SMTP_PASSWORD", "VCENTER_PASSWORD", "PRISM_PASS",
  "SQL_SERVER_AUTHENTICATION_PASSWORD"
]);

function b64d(val) {
  try { return Buffer.from(String(val ?? ""), "base64").toString("utf8"); }
  catch { return String(val ?? ""); }
}
function bool(v, d = false) {
  if (v == null || v === "") return d;
  const s = String(v).toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

const REQUIRED = ["BIGFIX_BASE_URL", "BIGFIX_USER", "BIGFIX_PASS"];

function loadFromFileDict() {
  const pairs = readEnvFile();
  const dict = {};
  pairs.forEach(({ key, value }) => (dict[key] = value));
  return dict;
}

/*
function ensureEncryptionKey() {
  const dict = loadFromFileDict();
  if (!dict.ENCRYPTION_KEY) {
    const newKey = crypto.randomBytes(32).toString('hex');
    dict.ENCRYPTION_KEY = newKey;
    writeEnvFull(dict);
    process.env.ENCRYPTION_KEY = newKey;
  } else {
    process.env.ENCRYPTION_KEY = dict.ENCRYPTION_KEY;
  }
}

ensureEncryptionKey(); */

// Force crypto to log key fingerprint (optional)
setTimeout(() => {
    try {
        const { getMasterKey } = require('./utils/crypto');
        getMasterKey(); // just to trigger fingerprint log
    } catch (err) {}
}, 100);

function computeMissing(dict) {
  const miss = [];
  for (const k of REQUIRED) if (!String(dict[k] || "").trim()) miss.push(k);
  return miss;
}

function getStageConfig(dictRaw, stage) {
  const prefix = stage.toUpperCase();
  const baseUrl = dictRaw[`${prefix}_BIGFIX_BASE_URL`] || dictRaw.BIGFIX_BASE_URL;
  const username = dictRaw[`${prefix}_BIGFIX_USER`] || dictRaw.BIGFIX_USER;
  let password = dictRaw[`${prefix}_BIGFIX_PASS`];
  if (password === undefined) password = dictRaw.BIGFIX_PASS;
  const allowSelfSigned = bool(dictRaw[`${prefix}_BIGFIX_ALLOW_SELF_SIGNED`], bool(dictRaw.BIGFIX_ALLOW_SELF_SIGNED));

  return {
    BIGFIX_BASE_URL: baseUrl,
    BIGFIX_USER: username,
    BIGFIX_PASS: password,
    BIGFIX_ALLOW_SELF_SIGNED: allowSelfSigned,
  };
}

function buildCfg(dictRaw, dbOverrides = {}) {
  const decodedFile = { ...dictRaw };
  for (const k of SECRET_KEYS) {
      if (k in decodedFile) decodedFile[k] = b64d(decodedFile[k]);
  }

  const merged = { ...decodedFile, ...dbOverrides };

  const defaultFrontEnd = path.resolve(projectRoot(), 'frontend_dist');
  const frontEndDir = merged.FRONTEND_DIR ? path.resolve(merged.FRONTEND_DIR) : defaultFrontEnd;

  const port = merged.PORT || process.env.PORT || 5174;
  const baseUrl = `http://localhost:${port}`;

  const rootBigFix = {
    BIGFIX_BASE_URL: merged.BIGFIX_BASE_URL || "",
    BIGFIX_USER: merged.BIGFIX_USER || "",
    BIGFIX_PASS: merged.BIGFIX_PASS || "",
    BIGFIX_ALLOW_SELF_SIGNED: bool(merged.BIGFIX_ALLOW_SELF_SIGNED, false),
  };

  const sandbox = getStageConfig(merged, "sandbox");
  const pilot = getStageConfig(merged, "pilot");
  const production = getStageConfig(merged, "production");

  const cfg = {
    PORT: port,
    SESSION_TIMEOUT: merged.SESSION_TIMEOUT || "15",
    FRONTEND_DIR: frontEndDir,
    FRONTEND_URL: merged.FRONTEND_URL || baseUrl,
    BACKEND_URL: merged.BACKEND_URL || baseUrl,

    ...rootBigFix,
    sandbox, pilot, production,

    PRISM_BASE_URL: merged.PRISM_BASE_URL || "",
    PRISM_USER: merged.PRISM_USER || "",
    PRISM_PASS: merged.PRISM_PASS || "",

    SN_URL: merged.SN_URL || "",
    SN_USER: merged.SN_USER || "",
    SN_PASSWORD: merged.SN_PASSWORD || "",
    SN_ALLOW_SELF_SIGNED: bool(merged.SN_ALLOW_SELF_SIGNED, false),

    VCENTER_URL: merged.VCENTER_URL || "",
    VCENTER_USER: merged.VCENTER_USER || "",
    VCENTER_PASSWORD: merged.VCENTER_PASSWORD || "",
    VCENTER_ALLOW_SELF_SIGNED: bool(merged.VCENTER_ALLOW_SELF_SIGNED, false),

    LDAP_ENABLED: bool(merged.LDAP_ENABLED, false),
    LDAP_URL: merged.LDAP_URL || "",
    LDAP_DOMAIN: merged.LDAP_DOMAIN || "",
    LDAP_ALLOW_SELF_SIGNED: bool(merged.LDAP_ALLOW_SELF_SIGNED, false),

    SMTP_HOST: merged.SMTP_HOST || "",
    SMTP_PORT: merged.SMTP_PORT || "",
    SMTP_SECURE: bool(merged.SMTP_SECURE, false),
    SMTP_FROM: merged.SMTP_FROM || "",
    SMTP_TO: merged.SMTP_TO || "",
    SMTP_CC: merged.SMTP_CC || "",
    SMTP_BCC: merged.SMTP_BCC || "",
    SMTP_USER: merged.SMTP_USER || "",
    SMTP_PASSWORD: merged.SMTP_PASSWORD || "",
    SMTP_ALLOW_SELF_SIGNED: bool(merged.SMTP_ALLOW_SELF_SIGNED, false),

    DEBUG_LOG: merged.DEBUG_LOG || "0",

    SQL_SERVER_AUTHENTICATION_USERNAME: merged.SQL_SERVER_AUTHENTICATION_USERNAME || "",
    SQL_SERVER_AUTHENTICATION_PASSWORD: merged.SQL_SERVER_AUTHENTICATION_PASSWORD || "",
    SQL_SERVER: merged.SQL_SERVER || "",
    SQL_PORT: merged.SQL_PORT || "1433",
    DATABASENAME: merged.DATABASENAME || "",
  };

  const ctx = {
    cfg: cfg,
    frontend: { FRONTEND_DIR: cfg.FRONTEND_DIR },
    bigfix: {
      BIGFIX_BASE_URL: cfg.BIGFIX_BASE_URL,
      BIGFIX_USER: cfg.BIGFIX_USER,
      BIGFIX_PASS: cfg.BIGFIX_PASS,
      httpsAgent: new https.Agent({ rejectUnauthorized: !cfg.BIGFIX_ALLOW_SELF_SIGNED }),
    },
    bigfixSandbox: {
      BIGFIX_BASE_URL: cfg.sandbox.BIGFIX_BASE_URL,
      BIGFIX_USER: cfg.sandbox.BIGFIX_USER,
      BIGFIX_PASS: cfg.sandbox.BIGFIX_PASS,
      httpsAgent: new https.Agent({ rejectUnauthorized: !cfg.sandbox.BIGFIX_ALLOW_SELF_SIGNED }),
    },
    bigfixPilot: {
      BIGFIX_BASE_URL: cfg.pilot.BIGFIX_BASE_URL,
      BIGFIX_USER: cfg.pilot.BIGFIX_USER,
      BIGFIX_PASS: cfg.pilot.BIGFIX_PASS,
      httpsAgent: new https.Agent({ rejectUnauthorized: !cfg.pilot.BIGFIX_ALLOW_SELF_SIGNED }),
    },
    bigfixProduction: {
      BIGFIX_BASE_URL: cfg.production.BIGFIX_BASE_URL,
      BIGFIX_USER: cfg.production.BIGFIX_USER,
      BIGFIX_PASS: cfg.production.BIGFIX_PASS,
      httpsAgent: new https.Agent({ rejectUnauthorized: !cfg.production.BIGFIX_ALLOW_SELF_SIGNED }),
    },
    servicenow: { SN_URL: cfg.SN_URL, SN_USER: cfg.SN_USER, SN_PASSWORD: cfg.SN_PASSWORD, SN_ALLOW_SELF_SIGNED: cfg.SN_ALLOW_SELF_SIGNED },
    prism: { PRISM_BASE_URL: cfg.PRISM_BASE_URL, PRISM_USER: cfg.PRISM_USER, PRISM_PASS: cfg.PRISM_PASS },
    vcenter: {
        VCENTER_URL: cfg.VCENTER_URL,
        VCENTER_USER: cfg.VCENTER_USER,
        VCENTER_PASSWORD: cfg.VCENTER_PASSWORD,
        VCENTER_ALLOW_SELF_SIGNED: cfg.VCENTER_ALLOW_SELF_SIGNED
    },
    ldap: { LDAP_ENABLED: cfg.LDAP_ENABLED, LDAP_URL: cfg.LDAP_URL, LDAP_DOMAIN: cfg.LDAP_DOMAIN, LDAP_ALLOW_SELF_SIGNED: cfg.LDAP_ALLOW_SELF_SIGNED },
    smtp: { SMTP_HOST: cfg.SMTP_HOST, SMTP_PORT: cfg.SMTP_PORT, SMTP_SECURE: cfg.SMTP_SECURE, SMTP_FROM: cfg.SMTP_FROM, SMTP_TO: cfg.SMTP_TO, SMTP_CC: cfg.SMTP_CC, SMTP_BCC: cfg.SMTP_BCC, SMTP_USER: cfg.SMTP_USER, SMTP_PASSWORD: cfg.SMTP_PASSWORD, SMTP_ALLOW_SELF_SIGNED: cfg.SMTP_ALLOW_SELF_SIGNED },
    DEBUG_LOG: cfg.DEBUG_LOG,
  };
  return { cfg, ctx };
}

let CURRENT = buildCfg(loadFromFileDict());

Object.entries(loadFromFileDict()).forEach(([k, v]) => {
  process.env[k] = SECRET_KEYS.has(k) ? b64d(v) : String(v ?? "");
});

function getCtx() { return CURRENT.ctx; }
function getCfg() { return CURRENT.cfg; }

function saveEnvAndReload(updates) {
  const base = loadFromFileDict();
  const merged = { ...base };
  Object.entries(updates || {}).forEach(([k, v]) => {
    if (UI_KEYS.has(k)) {
      merged[k] = String(v ?? "");
    }
  });

  writeEnvFull(merged);
  CURRENT = buildCfg(loadFromFileDict());
  Object.entries(loadFromFileDict()).forEach(([k, v]) => {
    process.env[k] = SECRET_KEYS.has(k) ? b64d(v) : String(v ?? "");
  });
  return CURRENT;
}

function status() {
  const dict = { ...CURRENT.cfg, ...loadFromFileDict() };
  const missing = computeMissing(dict);
  return { configured: missing.length === 0, missing };
}

let dbOverrides = {};
async function loadDbConfig() {
  const { getPool } = require('./db/mssql');
  const { decrypt } = require('./utils/crypto');

  try {
      const pool = await getPool();
      const result = await pool.request().query('SELECT ConfigKey, ConfigValue FROM dbo.AppConfiguration');

      dbOverrides = {};
      for (const row of result.recordset) {
         const key = row.ConfigKey;
         let val = row.ConfigValue;

         if (SECRET_KEYS.has(key)) {
             const decrypted = decrypt(val);
             if (decrypted !== null) {
                 val = decrypted;
             } else {
                 console.error(`⚠️ Failed to decrypt ${key}. Please re-enter this secret via the UI.`);
                 val = '';
             }
         }
         dbOverrides[key] = val;
      }

      CURRENT = buildCfg(loadFromFileDict(), dbOverrides);
      console.log("✅ Secure configuration successfully loaded from Database.");
  } catch (err) {
      console.error("⚠️ Failed to load DB config (This is normal on first run if table is empty):", err.message);
  }
}

module.exports = { readEnvFile, saveEnvAndReload, getCtx, getCfg, status, loadDbConfig };