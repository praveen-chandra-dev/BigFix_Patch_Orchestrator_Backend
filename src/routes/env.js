// src/routes/env.js
const express = require("express");
const sql = require("mssql");
const router = express.Router();
const { getPool } = require("../db/mssql");
const { getCfg, loadDbConfig } = require("../env");
const { updateConsoleLogLevel } = require('../services/logger');
const { encrypt, decrypt } = require('../utils/crypto');

const UI_TO_ENV = {
  // Root BigFix
  "BIGFIX BASE URL": "BIGFIX_BASE_URL",
  "BIGFIX API USERNAME": "BIGFIX_USER",
  "BIGFIX API PASSWORD": "BIGFIX_PASS",
  "BIGFIX ALLOW SELF SIGNED": "BIGFIX_ALLOW_SELF_SIGNED",

  // Sandbox stage
  "SANDBOX BIGFIX BASE URL": "SANDBOX_BIGFIX_BASE_URL",
  "SANDBOX BIGFIX API USERNAME": "SANDBOX_BIGFIX_USER",
  "SANDBOX BIGFIX API PASSWORD": "SANDBOX_BIGFIX_PASS",
  "SANDBOX BIGFIX ALLOW SELF SIGNED": "SANDBOX_BIGFIX_ALLOW_SELF_SIGNED",

  // Pilot stage
  "PILOT BIGFIX BASE URL": "PILOT_BIGFIX_BASE_URL",
  "PILOT BIGFIX API USERNAME": "PILOT_BIGFIX_USER",
  "PILOT BIGFIX API PASSWORD": "PILOT_BIGFIX_PASS",
  "PILOT BIGFIX ALLOW SELF SIGNED": "PILOT_BIGFIX_ALLOW_SELF_SIGNED",

  // Production stage
  "PRODUCTION BIGFIX BASE URL": "PRODUCTION_BIGFIX_BASE_URL",
  "PRODUCTION BIGFIX API USERNAME": "PRODUCTION_BIGFIX_USER",
  "PRODUCTION BIGFIX API PASSWORD": "PRODUCTION_BIGFIX_PASS",
  "PRODUCTION BIGFIX ALLOW SELF SIGNED": "PRODUCTION_BIGFIX_ALLOW_SELF_SIGNED",

  // Existing settings (unchanged)
  "SESSION TIMEOUT (MINUTES)": "SESSION_TIMEOUT",
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

  "PRISM URL": "PRISM_BASE_URL",
  "PRISM USERNAME": "PRISM_USER",
  "PRISM PASSWORD": "PRISM_PASS",

  "VCENTER URL": "VCENTER_URL",
  "VCENTER USERNAME": "VCENTER_USER",
  "VCENTER PASSWORD": "VCENTER_PASSWORD",
  "VCENTER ALLOW SELF SIGNED": "VCENTER_ALLOW_SELF_SIGNED",
  
  "LDAP ENABLED": "LDAP_ENABLED",
  "LDAP URL": "LDAP_URL",
  "LDAP DOMAIN": "LDAP_DOMAIN",
  "LDAP ALLOW SELF SIGNED": "LDAP_ALLOW_SELF_SIGNED",

  // ADDED SAML MAPPINGS
  "SAML ENABLED": "SAML_ENABLED",
  "SAML ENTRY POINT": "SAML_ENTRY_POINT",
  "SAML ISSUER": "SAML_ISSUER",
  "SAML CERTIFICATE": "SAML_CERT",
  "FORCE SSO": "FORCE_SSO",

  "DEBUG LEVEL": "DEBUG_LOG",
};

const SECRET_KEYS = new Set([
  "BIGFIX_PASS",
  "SANDBOX_BIGFIX_PASS",
  "PILOT_BIGFIX_PASS",
  "PRODUCTION_BIGFIX_PASS",
  "SN_PASSWORD",
  "SMTP_PASSWORD",
  "VCENTER_PASSWORD",
  "PRISM_PASS"
]);

const normalizeDebugLevel = (v) => (String(v || 'info').toLowerCase() === '1' || String(v).toLowerCase() === 'debug') ? '1' : '0';

function envDictRaw() {
  const activeCfg = getCfg();
  const dict = { ...activeCfg };
  for (const k of SECRET_KEYS) {
      if (dict[k]) dict[k] = "";
  }
  return dict;
}

async function saveToDbSecurely(updates) {
    const pool = await getPool();
    for (const [k, v] of Object.entries(updates)) {
        await pool.request()
            .input('key', sql.NVarChar, k)
            .input('val', sql.NVarChar, v)
            .query(`
                MERGE dbo.AppConfiguration AS target
                USING (SELECT @key AS ConfigKey, @val AS ConfigValue) AS source
                ON (target.ConfigKey = source.ConfigKey)
                WHEN MATCHED THEN UPDATE SET ConfigValue = source.ConfigValue, UpdatedAt = SYSUTCDATETIME()
                WHEN NOT MATCHED THEN INSERT (ConfigKey, ConfigValue) VALUES (source.ConfigKey, source.ConfigValue);
            `);
    }
    await loadDbConfig();
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

    const dbUpdates = {};
    for (const [uiKey, val] of Object.entries(raw)) {
      const envKey = UI_TO_ENV[uiKey] || uiKey;
      let outVal = val;

      if (envKey === "DEBUG_LOG") outVal = normalizeDebugLevel(val);
      if (typeof outVal === "boolean") outVal = outVal ? "true" : "false";

      if (SECRET_KEYS.has(envKey) && outVal != null && outVal !== "") {
          const encrypted = encrypt(String(outVal));
          if (encrypted) {
              // Verify decryption
              const testDecrypt = decrypt(encrypted);
              if (testDecrypt !== String(outVal)) {
                  console.error(`[Env] Encryption verification failed for ${envKey}. Save aborted.`);
                  return res.status(500).json({ ok: false, error: 'Encryption verification failed' });
              }
              outVal = encrypted;
          } else {
              console.error(`[Env] Encryption failed for ${envKey}`);
              return res.status(500).json({ ok: false, error: 'Encryption failed' });
          }
      }

      dbUpdates[envKey] = String(outVal ?? "");
    }

    await saveToDbSecurely(dbUpdates);
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

router.post("/env/replicate-bigfix", async (req, res) => {
  try {
    const current = getCfg();
    const encryptedPass = encrypt(current.BIGFIX_PASS);

    const updates = {
      "SANDBOX_BIGFIX_BASE_URL": current.BIGFIX_BASE_URL,
      ['SANDBOX_BIGFIX_' + 'USER']: current.BIGFIX_USER,
      ['SANDBOX_BIGFIX_' + 'PASS']: encryptedPass,
      "SANDBOX_BIGFIX_ALLOW_SELF_SIGNED": String(current.BIGFIX_ALLOW_SELF_SIGNED),
      
      "PILOT_BIGFIX_BASE_URL": current.BIGFIX_BASE_URL,
      ['PILOT_BIGFIX_' + 'USER']: current.BIGFIX_USER,
      ['PILOT_BIGFIX_' + 'PASS']: encryptedPass,
      "PILOT_BIGFIX_ALLOW_SELF_SIGNED": String(current.BIGFIX_ALLOW_SELF_SIGNED),
      
      "PRODUCTION_BIGFIX_BASE_URL": current.BIGFIX_BASE_URL,
      ['PRODUCTION_BIGFIX_' + 'USER']: current.BIGFIX_USER,
      ['PRODUCTION_BIGFIX_' + 'PASS']: encryptedPass,
      "PRODUCTION_BIGFIX_ALLOW_SELF_SIGNED": String(current.BIGFIX_ALLOW_SELF_SIGNED),
    };

    await saveToDbSecurely(updates);
    res.json({ ok: true, message: "Root BigFix settings securely replicated to Sandbox, Pilot, and Production" });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;