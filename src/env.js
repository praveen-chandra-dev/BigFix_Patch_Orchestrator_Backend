// src/env.js
const fs = require("fs");
const path = require("path");
const https = require("https");
const os = require("os");

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
const PERSIST_KEYS = [
  "PORT",
  "BIGFIX_ALLOW_SELF_SIGNED","BIGFIX_BASE_URL","BIGFIX_USER","BIGFIX_PASS",
  "SN_ALLOW_SELF_SIGNED","SN_URL","SN_USER","SN_PASSWORD",
  "SMTP_ALLOW_SELF_SIGNED","SMTP_HOST","SMTP_PORT","SMTP_SECURE",
  "SMTP_FROM","SMTP_TO","SMTP_CC","SMTP_BCC",
  "DEBUG_LOG",
];

/* ---------------- atomic writer (write FULL dict, no .bak) ---------------- */
function writeEnvFull(fullDict) {
  const p   = envPath();
  const tmp = p + ".tmp";
  const existing = readEnvFile();
  const order = existing.map(i => i.key);

  // Only persist known keys; keep values as strings
  const dict = {};
  for (const k of PERSIST_KEYS) {
    if (k in fullDict) dict[k] = String(fullDict[k] ?? "");
  }

  const data = toEnvContent(dict, order);
  fs.writeFileSync(tmp, data, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, p);
  return { path: p };
}

/* ---------------- runtime cfg + ctx (with base64 decoding) ---------------- */
const SECRET_KEYS = new Set(["BIGFIX_PASS", "SN_PASSWORD"]); // (add "SMTP_PASS" if you later add it)

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
    SMTP_ALLOW_SELF_SIGNED: bool(decoded.SMTP_ALLOW_SELF_SIGNED, false),

    DEBUG_LOG: decoded.DEBUG_LOG || "0",
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
      SMTP_ALLOW_SELF_SIGNED: cfg.SMTP_ALLOW_SELF_SIGNED,
    },
    DEBUG_LOG: cfg.DEBUG_LOG, // legacy 0/1
  };
  return { cfg, ctx };
}

let CURRENT = buildCfg(loadFromFileDict());
function getCtx() { return CURRENT.ctx; }
function getCfg() { return CURRENT.cfg; }

/** Always merge current cfg + incoming updates, then write FULL env (secrets stay BASE64 in file, decoded in memory) */
function saveEnvAndReload(updates) {
  // Base from disk + current memory (disk wins for unknowns)
  const base = { ...CURRENT.cfg, ...loadFromFileDict() };

  // Merge updates (strings only)
  const merged = { ...base };
  Object.entries(updates || {}).forEach(([k, v]) => { merged[k] = String(v ?? ""); });

  // Persist full set to .env
  writeEnvFull(merged);

  // Refresh in-memory copy from file so secrets get decoded again
  CURRENT = buildCfg(loadFromFileDict());
  // Also refresh process.env for non-code consumers
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

module.exports = {
  readEnvFile,          // returns raw (base64) pairs
  saveEnvAndReload,     // writes raw (base64) to .env, reloads decoded runtime
  getCtx,
  getCfg,
  status,
};
