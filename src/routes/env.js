// src/routes/env.js
const express = require("express");
const router = express.Router();

const { readEnvFile, saveEnvAndReload } = require("../env");

/* ----------------------------- mapping & helpers ---------------------------- */

const UI_TO_ENV = {
  // BigFix
  "BIGFIX BASE URL": "BIGFIX_BASE_URL",
  "BIGFIX API USERNAME": "BIGFIX_USER",
  "BIGFIX API PASSWORD": "BIGFIX_PASS",
  "BIGFIX ALLOW SELF SIGNED": "BIGFIX_ALLOW_SELF_SIGNED",

  // Mail / SMTP
  "SMTP HOST": "SMTP_HOST",
  "EMAIL FROM": "SMTP_FROM",
  "EMAIL TO": "SMTP_TO",
  "EMAIL CC": "SMTP_CC",
  "EMAIL BCC": "SMTP_BCC",
  "SMTP PORT": "SMTP_PORT",
  "SMTP SECURE": "SMTP_SECURE",
  "SMTP ALLOW SELF SIGNED": "SMTP_ALLOW_SELF_SIGNED",
  "SMTP PASSWORD": "SMTP_PASS", // if/when you start using it

  // ServiceNow
  "SERVICENOW URL": "SN_URL",
  "SERVICENOW USERNAME": "SN_USER",
  "SERVICENOW PASSWORD": "SN_PASSWORD",
  "SERVICENOW ALLOW SELF SIGNED": "SN_ALLOW_SELF_SIGNED",

  // Debug (UI shows Info/Debug, backend historically expects 0/1)
  "DEBUG LEVEL": "DEBUG_LOG",
};

const SECRET_KEYS = new Set(["BIGFIX_PASS", "SN_PASSWORD", "SMTP_PASS"]);
const b64e = (s) => Buffer.from(String(s ?? ""), "utf8").toString("base64");
const normalizeDebugLevel = (v) =>
  (v === 1 || v === "1" || String(v).toLowerCase() === "debug") ? "1" : "0";

function envDictRaw() {
  const items = readEnvFile();
  const dict = {};
  for (const { key, value } of items) dict[key] = value;
  return dict;
}

/* --------------------------------- routes ---------------------------------- */

// GET full env (returns raw values as stored in file; secrets are base64)
router.get("/env", (req, res) => {
  try {
    const dict = envDictRaw();
    res.json({
      ok: true,
      configured: Boolean(dict.BIGFIX_BASE_URL),
      values: dict,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "read_failed", detail: String(e.message || e) });
  }
});

// POST updates from Management UI
router.post("/env", express.json({ limit: "1mb" }), async (req, res) => {
  try {
    const body = req.body || {};
    const raw = body.updates || body;
    if (!raw || typeof raw !== "object") {
      return res.status(400).json({ ok: false, error: "invalid_payload" });
    }

    // Translate UI → env keys and base64 encode secrets for storage
    const updates = {};
    for (const [uiKey, val] of Object.entries(raw)) {
      const envKey = UI_TO_ENV[uiKey] || uiKey; // allow direct env keys too
      let outVal = val;

      if (envKey === "DEBUG_LOG") outVal = normalizeDebugLevel(val);
      if (typeof outVal === "boolean") outVal = outVal ? "true" : "false";
      if (SECRET_KEYS.has(envKey) && outVal != null && outVal !== "") outVal = b64e(outVal);

      updates[envKey] = String(outVal ?? "");
    }

    // Save to .env and hot-reload runtime (decode secrets for process + clients)
    const after = saveEnvAndReload(updates);

    // respond with raw values as stored in .env (still base64 for secrets)
    res.json({ ok: true, values: envDictRaw() });
  } catch (e) {
    res.status(500).json({ ok: false, error: "save_failed", detail: String(e.message || e) });
  }
});

// minimal status (used by shell to decide opening Management)
router.get("/env/status", (req, res) => {
  try {
    const dict = envDictRaw();
    res.json({ ok: true, configured: Boolean(dict.BIGFIX_BASE_URL) });
  } catch {
    res.status(500).json({ ok: false, configured: false, error: "read_failed" });
  }
});

module.exports = router;
