// src/envManage.js
const { getPool, sql } = require("./db/mssql");
const { encrypt } = require("./utils/crypto");

// Keys that must be encrypted before being saved to the database
const SECRET_KEYS = new Set([
  "BIGFIX_PASS", "SANDBOX_BIGFIX_PASS", "PILOT_BIGFIX_PASS", "PRODUCTION_BIGFIX_PASS",
  "SN_PASSWORD", "SMTP_PASSWORD", "VCENTER_PASSWORD", "PRISM_PASS"
]);

function envPath() { return "Database"; }
function readEnvFile() { return []; } 

async function writeEnvAtomicAsync(updates) {
  if (!updates || Object.keys(updates).length === 0) return;
  const pool = await getPool();
  
  for (const [key, value] of Object.entries(updates)) {
    let finalValue = String(value ?? "");
    
    // Intercept and encrypt passwords before saving to DB
    if (SECRET_KEYS.has(key) && finalValue) {
        const encrypted = encrypt(finalValue);
        if (encrypted) finalValue = encrypted;
    }

    // Upsert into AppConfiguration table
    await pool.request()
      .input('Key', sql.NVarChar(128), key)
      .input('Value', sql.NVarChar(sql.MAX), finalValue)
      .query(`
        MERGE dbo.AppConfiguration AS target
        USING (SELECT @Key AS ConfigKey) AS source
        ON (target.ConfigKey = source.ConfigKey)
        WHEN MATCHED THEN 
            UPDATE SET ConfigValue = @Value, UpdatedAt = SYSUTCDATETIME()
        WHEN NOT MATCHED THEN 
            INSERT (ConfigKey, ConfigValue, UpdatedAt) 
            VALUES (@Key, @Value, SYSUTCDATETIME());
      `);
  }
}

// Export a wrapper to maintain compatibility with existing Express routes
function writeEnvAtomic(updates) {
  writeEnvAtomicAsync(updates)
    .then(() => console.log("[EnvManage] Settings securely saved to Database."))
    .catch(err => console.error("[EnvManage] Failed to save settings to DB:", err.message));
  
  // Return dummy path to satisfy caller
  return { path: "db" };
}

module.exports = { readEnvFile, writeEnvAtomic, writeEnvAtomicAsync, envPath };