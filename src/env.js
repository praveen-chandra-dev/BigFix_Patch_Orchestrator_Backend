// src/env.js
const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https"); 
const os = require("node:os");

/* ---------------- project-root path helpers ---------------- */
function projectRoot() {
  const mainFile = (require.main && require.main.filename) ? require.main.filename : process.argv[1];
  return path.dirname(mainFile);
}
function envPath() { return path.resolve(projectRoot(), ".env"); }

/* ---------------- .env read / format helpers ---------------- */
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
  
  // Add any new keys that weren't in the original order
  Object.keys(dict).sort().forEach(k => { if (!seen.has(k)) keys.push(k); });
  
  const lines = keys.map(k => {
    let v = dict[k] ?? "";
    // quote if any non-trivial chars
    if (/[^\w@%+:/.,\-]/.test(v)) v = JSON.stringify(String(v));
    return `${k}=${v}`;
  });
  lines.push("");
  return lines.join(os.EOL);
}

/* ---------------- keys we persist to .env ---------------- */
// Yeh list UI se aane wali keys ko pehchanne ke liye hai
const UI_KEYS = new Set([
  "PORT",
  "BIGFIX_ALLOW_SELF_SIGNED","BIGFIX_BASE_URL","BIGFIX_USER","BIGFIX_PASS",
  "SN_ALLOW_SELF_SIGNED","SN_URL","SN_USER","SN_PASSWORD",
  "SMTP_ALLOW_SELF_SIGNED","SMTP_HOST","SMTP_PORT","SMTP_SECURE",
  "SMTP_FROM","SMTP_TO","SMTP_CC","SMTP_BCC",
  "SMTP_USER","SMTP_PASSWORD",
  "DEBUG_LOG",
]);

/* ---------------- writer ---------------- */
/**
 * FIX: 'writeEnvFull' ko update kiya gaya hai taaki yeh 'fullDict'
 * ko seedha save kare, bina 'PERSIST_KEYS' se filter kiye.
 * Yeh file ko overwrite karne ke bajaye merge karega.
 * Saath hi, Windows permission issue se bachne ke liye direct write ka istemal kiya gaya hai.
 */
function writeEnvFull(fullDict) {
  const p = envPath();
  
  // Pehle se maujood keys aur unka order load karein
  const existing = readEnvFile();
  const order = existing.map(i => i.key);

  // fullDict (jisme pehle se old + new keys merged hain) se
  // har key ko string mein convert karein.
  const dictToSave = {};
  for (const k in fullDict) {
    dictToSave[k] = String(fullDict[k] ?? "");
  }

  const data = toEnvContent(dictToSave, order);
  
  // FIX: File ko directly write karein (rename ki jagah)
  // Yeh Windows permission errors ko fix karta hai.
  fs.writeFileSync(p, data, { encoding: "utf8", mode: 0o600 });
  
  return { path: p };
}

/* ---------------- runtime cfg + ctx (with base64 decoding) ---------------- */
// FIX: SQL password ko secret list mein add karein
const SECRET_KEYS = new Set([
    "BIGFIX_PASS", 
    "SN_PASSWORD", 
    "SMTP_PASSWORD", 
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

const REQUIRED = [
  "BIGFIX_BASE_URL", "BIGFIX_USER", "BIGFIX_PASS",
  "SMTP_HOST", "SMTP_FROM", "SMTP_TO", "SMTP_PORT",
];

function loadFromFileDict() {
  const pairs = readEnvFile();
  const dict = {};
  pairs.forEach(({ key, value }) => (dict[key] = value));
  return dict;
}

function computeMissing(dict) {
  const miss = [];
  for (const k of REQUIRED) if (!String(dict[k] || "").trim()) miss.push(k);
  const port = String(dict.SMTP_PORT || "").trim();
  if (port && !["25","465","587"].includes(port)) if (!miss.includes("SMTP_PORT")) miss.push("SMTP_PORT");
  return miss;
}

function buildCfg(dictRaw) {
  // decode secrets for runtime use
  const decoded = { ...dictRaw };
  for (const k of SECRET_KEYS) if (k in decoded) decoded[k] = b64d(decoded[k]);

  const cfg = {
    PORT: decoded.PORT || process.env.PORT || 5174,

    BIGFIX_BASE_URL: decoded.BIGFIX_BASE_URL || "",
    BIGFIX_USER: decoded.BIGFIX_USER || "",
    BIGFIX_PASS: decoded.BIGFIX_PASS || "",                  // <-- DECODED here
    BIGFIX_ALLOW_SELF_SIGNED: bool(decoded.BIGFIX_ALLOW_SELF_SIGNED, false),

    SN_URL: decoded.SN_URL || "",
    SN_USER: decoded.SN_USER || "",
    SN_PASSWORD: decoded.SN_PASSWORD || "",                  // <-- DECODED
    SN_ALLOW_SELF_SIGNED: bool(decoded.SN_ALLOW_SELF_SIGNED, false),

    SMTP_HOST: decoded.SMTP_HOST || "",
    SMTP_PORT: decoded.SMTP_PORT || "",
    SMTP_SECURE: bool(decoded.SMTP_SECURE, false),
    SMTP_FROM: decoded.SMTP_FROM || "",
    SMTP_TO: decoded.SMTP_TO || "",
    SMTP_CC: decoded.SMTP_CC || "",
    SMTP_BCC: decoded.SMTP_BCC || "",
    SMTP_USER: decoded.SMTP_USER || "",
    SMTP_PASSWORD: decoded.SMTP_PASSWORD || "",             // <-- DECODED
    SMTP_ALLOW_SELF_SIGNED: bool(decoded.SMTP_ALLOW_SELF_SIGNED, false),

    DEBUG_LOG: decoded.DEBUG_LOG || "0",
    
    // SQL keys ko bhi load karein taaki runtime mein available ho
    SQL_SERVER_AUTHENTICATION_USERNAME: decoded.SQL_SERVER_AUTHENTICATION_USERNAME || "",
    SQL_SERVER_AUTHENTICATION_PASSWORD: decoded.SQL_SERVER_AUTHENTICATION_PASSWORD || "", // <-- DECODED
    SQL_SERVER: decoded.SQL_SERVER || "",
    SQL_PORT: decoded.SQL_PORT || "1433",
    DATABASENAME: decoded.DATABASENAME || "",
  };

  const ctx = {
    bigfix: {
      BIGFIX_BASE_URL: cfg.BIGFIX_BASE_URL,
      BIGFIX_USER: cfg.BIGFIX_USER,
      BIGFIX_PASS: cfg.BIGFIX_PASS, // plain for auth
      httpsAgent: new https.Agent({ rejectUnauthorized: !cfg.BIGFIX_ALLOW_SELF_SIGNED }),
    },
    servicenow: {
      SN_URL: cfg.SN_URL, SN_USER: cfg.SN_USER, SN_PASSWORD: cfg.SN_PASSWORD,
      SN_ALLOW_SELF_SIGNED: cfg.SN_ALLOW_SELF_SIGNED,
    },
    smtp: {
      SMTP_HOST: cfg.SMTP_HOST, SMTP_PORT: cfg.SMTP_PORT, SMTP_SECURE: cfg.SMTP_SECURE,
      SMTP_FROM: cfg.SMTP_FROM, SMTP_TO: cfg.SMTP_TO, SMTP_CC: cfg.SMTP_CC, SMTP_BCC: cfg.SMTP_BCC, 
      SMTP_USER: cfg.SMTP_USER, SMTP_PASSWORD: cfg.SMTP_PASSWORD,
      SMTP_ALLOW_SELF_SIGNED: cfg.SMTP_ALLOW_SELF_SIGNED,
    },
    DEBUG_LOG: cfg.DEBUG_LOG, // legacy 0/1
  };
  return { cfg, ctx };
}

let CURRENT = buildCfg(loadFromFileDict());
function getCtx() { return CURRENT.ctx; }
function getCfg() { return CURRENT.cfg; }

/** * FIX: Is function ko update kiya gaya hai taaki yeh
 * 'updates' (UI se) ko 'base' (file se) ke saath merge kare.
 */
function saveEnvAndReload(updates) {
  // 1. File se *sabhi* purani keys load karein (jaise SQL_...)
  const base = loadFromFileDict();

  // 2. UI se aayi hui 'updates' ko unke upar merge karein
  const merged = { ...base };
  Object.entries(updates || {}).forEach(([k, v]) => {
    // Sirf UI se manage hone wali keys ko hi update karein
    if (UI_KEYS.has(k)) {
      merged[k] = String(v ?? "");
    }
  });


  // 3. Poore merged dictionary ko file mein save karein
  writeEnvFull(merged);

  // 4. Runtime config ko naye data se reload karein
  CURRENT = buildCfg(loadFromFileDict());
  
  // 5. process.env ko bhi update karein
  Object.entries(loadFromFileDict()).forEach(([k, v]) => {
    // SQL keys aur baaki sab ko bhi process.env mein daalein
    process.env[k] = SECRET_KEYS.has(k) ? b64d(v) : String(v ?? "");
  });

  return CURRENT;
}

function status() {
  const dict = { ...CURRENT.cfg, ...loadFromFileDict() };
  const missing = computeMissing(dict);
  return { configured: missing.length === 0, missing };
}

module.exports = {
  readEnvFile,          // returns raw (base64) pairs
  saveEnvAndReload,     // writes raw (base64) to .env, reloads decoded runtime
  getCtx,
  getCfg,
  status,
};