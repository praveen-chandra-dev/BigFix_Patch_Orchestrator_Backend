// src/env.js
const fs = require("fs");
const path = require("path");
const https = require("https"); 
const os = require("os");

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

/* ---------------- keys we persist to .env ---------------- */
const UI_KEYS = new Set([
  "PORT",
  "BIGFIX_ALLOW_SELF_SIGNED","BIGFIX_BASE_URL","BIGFIX_USER","BIGFIX_PASS",
  "SN_ALLOW_SELF_SIGNED","SN_URL","SN_USER","SN_PASSWORD",
  "VCENTER_URL", "VCENTER_USER", "VCENTER_PASSWORD", "VCENTER_ALLOW_SELF_SIGNED",
  "SMTP_ALLOW_SELF_SIGNED","SMTP_HOST","SMTP_PORT","SMTP_SECURE",
  "SMTP_FROM","SMTP_TO","SMTP_CC","SMTP_BCC",
  "SMTP_USER","SMTP_PASSWORD",
  "LDAP_ENABLED", "LDAP_URL", "LDAP_DOMAIN", "LDAP_ALLOW_SELF_SIGNED", // <--- LDAP Keys
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

/* ---------------- runtime cfg + ctx ---------------- */
const SECRET_KEYS = new Set([
    "BIGFIX_PASS", "SN_PASSWORD", "SMTP_PASSWORD", "SQL_SERVER_AUTHENTICATION_PASSWORD", "VCENTER_PASSWORD"
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

function computeMissing(dict) {
  const miss = [];
  for (const k of REQUIRED) if (!String(dict[k] || "").trim()) miss.push(k);
  return miss;
}

function buildCfg(dictRaw) {
  const decoded = { ...dictRaw };
  for (const k of SECRET_KEYS) if (k in decoded) decoded[k] = b64d(decoded[k]);

  const defaultFrontEnd = path.resolve(projectRoot(), 'frontend_dist');
  const frontEndDir = decoded.FRONTEND_DIR ? path.resolve(decoded.FRONTEND_DIR) : defaultFrontEnd;

  const port = decoded.PORT || process.env.PORT || 5174;
  const baseUrl = `http://localhost:${port}`;

  const cfg = {
    PORT: port,
    FRONTEND_DIR: frontEndDir, // <--- Config key exists
    FRONTEND_URL: decoded.FRONTEND_URL || baseUrl,
    BACKEND_URL: decoded.BACKEND_URL || baseUrl,

    BIGFIX_BASE_URL: decoded.BIGFIX_BASE_URL || "",
    BIGFIX_USER: decoded.BIGFIX_USER || "",
    BIGFIX_PASS: decoded.BIGFIX_PASS || "",
    BIGFIX_ALLOW_SELF_SIGNED: bool(decoded.BIGFIX_ALLOW_SELF_SIGNED, false),

    SN_URL: decoded.SN_URL || "",
    SN_USER: decoded.SN_USER || "",
    SN_PASSWORD: decoded.SN_PASSWORD || "",
    SN_ALLOW_SELF_SIGNED: bool(decoded.SN_ALLOW_SELF_SIGNED, false),

    VCENTER_URL: decoded.VCENTER_URL || "",
    VCENTER_USER: decoded.VCENTER_USER || "",
    VCENTER_PASSWORD: decoded.VCENTER_PASSWORD || "",
    VCENTER_ALLOW_SELF_SIGNED: bool(decoded.VCENTER_ALLOW_SELF_SIGNED, false),

    // --- LDAP CONFIG ---
    LDAP_ENABLED: bool(decoded.LDAP_ENABLED, false),
    LDAP_URL: decoded.LDAP_URL || "",
    LDAP_DOMAIN: decoded.LDAP_DOMAIN || "",
    LDAP_ALLOW_SELF_SIGNED: bool(decoded.LDAP_ALLOW_SELF_SIGNED, false),

    SMTP_HOST: decoded.SMTP_HOST || "",
    SMTP_PORT: decoded.SMTP_PORT || "",
    SMTP_SECURE: bool(decoded.SMTP_SECURE, false),
    SMTP_FROM: decoded.SMTP_FROM || "",
    SMTP_TO: decoded.SMTP_TO || "",
    SMTP_CC: decoded.SMTP_CC || "",
    SMTP_BCC: decoded.SMTP_BCC || "",
    SMTP_USER: decoded.SMTP_USER || "",
    SMTP_PASSWORD: decoded.SMTP_PASSWORD || "",
    SMTP_ALLOW_SELF_SIGNED: bool(decoded.SMTP_ALLOW_SELF_SIGNED, false),

    DEBUG_LOG: decoded.DEBUG_LOG || "0",
    
    SQL_SERVER_AUTHENTICATION_USERNAME: decoded.SQL_SERVER_AUTHENTICATION_USERNAME || "",
    SQL_SERVER_AUTHENTICATION_PASSWORD: decoded.SQL_SERVER_AUTHENTICATION_PASSWORD || "",
    SQL_SERVER: decoded.SQL_SERVER || "",
    SQL_PORT: decoded.SQL_PORT || "1433",
    DATABASENAME: decoded.DATABASENAME || "",
  };

  const ctx = {
    cfg: cfg,
    frontend: {
      FRONTEND_DIR: cfg.FRONTEND_DIR // <--- CRITICAL FIX: Ensure this object exists
    },
    bigfix: {
      BIGFIX_BASE_URL: cfg.BIGFIX_BASE_URL,
      BIGFIX_USER: cfg.BIGFIX_USER,
      BIGFIX_PASS: cfg.BIGFIX_PASS,
      httpsAgent: new https.Agent({ rejectUnauthorized: !cfg.BIGFIX_ALLOW_SELF_SIGNED }),
    },
    servicenow: {
      SN_URL: cfg.SN_URL, SN_USER: cfg.SN_USER, SN_PASSWORD: cfg.SN_PASSWORD,
      SN_ALLOW_SELF_SIGNED: cfg.SN_ALLOW_SELF_SIGNED,
    },
    vcenter: {
      VCENTER_URL: cfg.VCENTER_URL,
      VCENTER_USER: cfg.VCENTER_USER,
      VCENTER_PASSWORD: cfg.VCENTER_PASSWORD,
      VCENTER_ALLOW_SELF_SIGNED: cfg.VCENTER_ALLOW_SELF_SIGNED,
    },
    ldap: { 
        LDAP_ENABLED: cfg.LDAP_ENABLED,
        LDAP_URL: cfg.LDAP_URL,
        LDAP_DOMAIN: cfg.LDAP_DOMAIN,
        LDAP_ALLOW_SELF_SIGNED: cfg.LDAP_ALLOW_SELF_SIGNED
    },
    smtp: {
      SMTP_HOST: cfg.SMTP_HOST, SMTP_PORT: cfg.SMTP_PORT, SMTP_SECURE: cfg.SMTP_SECURE,
      SMTP_FROM: cfg.SMTP_FROM, SMTP_TO: cfg.SMTP_TO, SMTP_CC: cfg.SMTP_CC, SMTP_BCC: cfg.SMTP_BCC, 
      SMTP_USER: cfg.SMTP_USER, SMTP_PASSWORD: cfg.SMTP_PASSWORD,
      SMTP_ALLOW_SELF_SIGNED: cfg.SMTP_ALLOW_SELF_SIGNED,
    },
    DEBUG_LOG: cfg.DEBUG_LOG,
  };
  return { cfg, ctx };
}

let CURRENT = buildCfg(loadFromFileDict());
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

module.exports = { readEnvFile, saveEnvAndReload, getCtx, getCfg, status };
