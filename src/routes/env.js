// src/routes/env.js
const express = require("express");
const router = express.Router();
const { readEnvFile, saveEnvAndReload } = require("../env");
const { updateConsoleLogLevel } = require('../services/logger');

const UI_TO_ENV = {
  "BIGFIX BASE URL": "BIGFIX_BASE_URL",
  "BIGFIX API USERNAME": "BIGFIX_USER",
  "BIGFIX API PASSWORD": "BIGFIX_PASS",
  "BIGFIX ALLOW SELF SIGNED": "BIGFIX_ALLOW_SELF_SIGNED",

  "SMTP HOST": "SMTP_HOST",
  "EMAIL FROM": "SMTP_FROM",
  "EMAIL TO": "SMTP_TO",
  "EMAIL CC": "SMTP_CC",
  "EMAIL BCC": "SMTP_BCC",
  "SMTP PORT": "SMTP_PORT",
  "SMTP SECURE": "SMTP_SECURE",
  "SMTP USERNAME": "SMTP_USER",
  "SMTP PASSWORD": "SMTP_PASSWORD",
  "SMTP ALLOW SELF SIGNED": "SMTP_ALLOW_SELF_SIGNED",

  "SERVICENOW URL": "SN_URL",
  "SERVICENOW USERNAME": "SN_USER",
  "SERVICENOW PASSWORD": "SN_PASSWORD",
  "SERVICENOW ALLOW SELF SIGNED": "SN_ALLOW_SELF_SIGNED",

  "VCENTER URL": "VCENTER_URL",
  "VCENTER USERNAME": "VCENTER_USER",
  "VCENTER PASSWORD": "VCENTER_PASSWORD",
  "VCENTER ALLOW SELF SIGNED": "VCENTER_ALLOW_SELF_SIGNED",
  
  // --- LDAP ---
  "LDAP ENABLED": "LDAP_ENABLED",
  "LDAP URL": "LDAP_URL",
  "LDAP DOMAIN": "LDAP_DOMAIN",
  "LDAP ALLOW SELF SIGNED": "LDAP_ALLOW_SELF_SIGNED",

  "DEBUG LEVEL": "DEBUG_LOG",
};

const SECRET_KEYS = new Set(["BIGFIX_PASS", "SN_PASSWORD", "SMTP_PASSWORD", "VCENTER_PASSWORD"]);
const b64e = (s) => Buffer.from(String(s ?? ""), "utf8").toString("base64");
const normalizeDebugLevel = (v) => (String(v || 'info').toLowerCase() === '1' || String(v).toLowerCase() === 'debug') ? '1' : '0';

function envDictRaw() {
  const items = readEnvFile();
  const dict = {};
  for (const { key, value } of items) dict[key] = value;
  return dict;
}

router.get("/env", (req, res) => {
  try {
    const dict = envDictRaw();
    res.json({ ok: true, configured: Boolean(dict.BIGFIX_BASE_URL), values: dict });
  } catch (e) {
    res.status(500).json({ ok: false, error: "read_failed", detail: String(e.message || e) });
  }
});

router.post("/env", express.json({ limit: "1mb" }), async (req, res) => {
  try {
    const body = req.body || {};
    const raw = body.updates || body;
    if (!raw || typeof raw !== "object") return res.status(400).json({ ok: false, error: "invalid_payload" });

    const updates = {};
    for (const [uiKey, val] of Object.entries(raw)) {
      const envKey = UI_TO_ENV[uiKey] || uiKey; 
      let outVal = val;
      if (envKey === "DEBUG_LOG") outVal = normalizeDebugLevel(val);
      if (typeof outVal === "boolean") outVal = outVal ? "true" : "false";
      if (SECRET_KEYS.has(envKey) && outVal != null && outVal !== "") outVal = b64e(outVal);
      updates[envKey] = String(outVal ?? "");
    }

    saveEnvAndReload(updates);
    updateConsoleLogLevel();
    res.json({ ok: true, values: envDictRaw() });
  } catch (e) {
    res.status(500).json({ ok: false, error: "save_failed", detail: String(e.message || e) });
  }
});

router.get("/env/status", (req, res) => {
  try {
    const dict = envDictRaw();
    res.json({ ok: true, configured: Boolean(dict.BIGFIX_BASE_URL) });
  } catch {
    res.status(500).json({ ok: false, configured: false, error: "read_failed" });
  }
});

module.exports = router;