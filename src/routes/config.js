// bigfix-backend/src/routes/config.js
const { CONFIG } = require("../state/store");
const { logFactory } = require("../utils/log");
const { sql, getPool } = require("../db/mssql");

// Helper: Merge DB config into memory
async function loadConfigFromDB(log) {
  try {
    const pool = await getPool();
    // Use 'GlobalConfig' key in SystemState table
    const res = await pool.request()
      .input('Key', sql.NVarChar(50), 'GlobalConfig')
      .query("SELECT StateValue FROM dbo.SystemState WHERE StateKey = @Key");
    
    if (res.recordset.length > 0 && res.recordset[0].StateValue) {
      try {
        const saved = JSON.parse(res.recordset[0].StateValue);
        // Merge saved config into global CONFIG object
        Object.assign(CONFIG, saved);
        // FIX: Pass empty object {} as mock request because log() requires req
        if (log) log({}, "Loaded GlobalConfig from DB:", Object.keys(saved));
      } catch (parseErr) {
        if (log) log({}, "Error parsing GlobalConfig JSON:", parseErr.message);
      }
    }
  } catch (e) {
    if (log) log({}, "Failed to load GlobalConfig from DB (first run?):", e.message);
  }
}

// Helper: Save memory config to DB
// FIX: Added 'req' parameter to pass to log function
async function saveConfigToDB(newConfig, req, log) {
  try {
    const pool = await getPool();
    const json = JSON.stringify(newConfig);
    
    // UPSERT Logic (Update if exists, else Insert)
    await pool.request()
      .input('Key', sql.NVarChar(50), 'GlobalConfig')
      .input('Value', sql.NVarChar(sql.MAX), json)
      .query(`
        MERGE dbo.SystemState AS target
        USING (SELECT @Key AS StateKey) AS source
        ON (target.StateKey = source.StateKey)
        WHEN MATCHED THEN
          UPDATE SET StateValue = @Value, UpdatedAt = SYSUTCDATETIME()
        WHEN NOT MATCHED THEN
          INSERT (StateKey, StateValue, UpdatedAt) VALUES (@Key, @Value, SYSUTCDATETIME());
      `);
      
    // FIX: Pass the actual req object (or {} if missing)
    if (log) log(req || {}, "Saved GlobalConfig to DB");
  } catch (e) {
    if (log) log(req || {}, "Failed to save GlobalConfig to DB:", e.message);
    throw e;
  }
}

function attachConfigRoutes(app, ctx) {
  const log = logFactory(ctx.DEBUG_LOG);

  // Load config on startup (fire and forget)
  loadConfigFromDB(log);

  app.get("/api/config", async (req, res) => {
    req._logStart = Date.now();
    
    // Always try to refresh from DB on GET to ensure consistency across restarts/instances
    await loadConfigFromDB(log);
    
    log(req, "GET /api/config");
    res.json({ ok: true, ...CONFIG });
  });

  app.post("/api/config", async (req, res) => {
    req._logStart = Date.now();
    log(req, "POST /api/config body:", req.body);
    try {
      const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : undefined);
      const bool = (v) => {
        if (v === undefined) return undefined;
        const s = String(v).toLowerCase();
        if (["true","1","yes","on"].includes(s)) return true;
        if (["false","0","no","off"].includes(s)) return false;
        return undefined;
      };

      const dsk = num(req.body?.diskThresholdGB) ?? num(req.body?.diskThreshold);

      if (dsk === undefined || dsk < 0)
        return res.status(400).json({ ok:false, message:"diskGB must be >= 0" });

      const requireChgVal   = bool(req.body?.requireChg ?? req.body?.changeRequired ?? req.body?.requireChange);
      const autoMailVal     = bool(req.body?.autoMail ?? req.body?.prePatchMail);
      const postPatchVal    = bool(req.body?.postPatchMail);
      const checkServiceVal = bool(req.body?.checkServiceStatus ?? req.body?.checkService); 
      
      // --- NEW: Handle Snapshot/Clone Flags ---
      const snapshotVal = bool(req.body?.snapshotVM);
      const cloneVal    = bool(req.body?.cloneVM);

      const reportValue = num(req.body?.lastReportValue);
      const reportUnit  = req.body?.lastReportUnit;
      const validUnits  = ["minutes","hours","days"];
      
      if (reportValue !== undefined && (reportValue < 0 || !Number.isInteger(reportValue)))
        return res.status(400).json({ ok:false, message:"lastReportValue must be a positive integer" });
      if (reportUnit !== undefined && !validUnits.includes(reportUnit))
        return res.status(400).json({ ok:false, message:`lastReportUnit must be one of: ${validUnits.join(", ")}` });

      // Update In-Memory
      CONFIG.diskThresholdGB = dsk;

      if (requireChgVal !== undefined) CONFIG.requireChg  = requireChgVal;
      if (autoMailVal   !== undefined) CONFIG.autoMail    = autoMailVal;
      if (postPatchVal  !== undefined) CONFIG.postPatchMail = postPatchVal;
      if (checkServiceVal !== undefined) CONFIG.checkServiceStatus = checkServiceVal;
      
      if (snapshotVal !== undefined) CONFIG.snapshotVM = snapshotVal;
      if (cloneVal !== undefined)    CONFIG.cloneVM = cloneVal;

      if (reportValue !== undefined) CONFIG.lastReportValue = reportValue;
      if (reportUnit  !== undefined) CONFIG.lastReportUnit  = reportUnit;

      // --- PERSIST TO DB (FIXED) ---
      // Pass 'req' so the logger works
      await saveConfigToDB(CONFIG, req, log);

      res.json({ ok: true, config: { ...CONFIG } });
    } catch (e) {
      log(req, "Config Save Error:", e.message); // Log the error properly
      res.status(400).json({ ok:false, message:e?.message || "Bad request" });
    }
  });
}

module.exports = { attachConfigRoutes };