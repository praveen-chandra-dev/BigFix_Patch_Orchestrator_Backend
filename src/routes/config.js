// backend/src/routes/config.js
const { CONFIG } = require("../state/store");
const { logFactory } = require("../utils/log");

function attachConfigRoutes(app, ctx) {
  const log = logFactory(ctx.DEBUG_LOG);

  app.get("/api/config", (req, res) => {
    // ... (this route is unchanged) ...
    req._logStart = Date.now();
    log(req, "GET /api/config");
    // return full CONFIG including postPatchMail
    res.json({ ok: true, ...CONFIG });
  });

  app.post("/api/config", (req, res) => {
    req._logStart = Date.now();
    log(req, "POST /api/config body:", req.body);
    try {
      const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : undefined);
      const bool = (v) => {
        // ... (bool helper is unchanged) ...
        if (v === undefined) return undefined;
        const s = String(v).toLowerCase();
        if (["true","1","yes","on"].includes(s)) return true;
        if (["false","0","no","off"].includes(s)) return false;
        return undefined;
      };

      // - const cpu = num(req.body?.cpuThresholdPct) ?? num(req.body?.cpuThreshold); // REMOVED
      // - const ram = num(req.body?.ramThresholdPct) ?? num(req.body?.ramThreshold); // REMOVED
      const dsk = num(req.body?.diskThresholdGB) ?? num(req.body?.diskThreshold);

      // - if (cpu === undefined || cpu < 0 || cpu > 100) // REMOVED BLOCK
      // -   return res.status(400).json({ ok:false, message:"cpuPct must be 0..100" });
      // - if (ram === undefined || ram < 0 || ram > 100) // REMOVED BLOCK
      // -   return res.status(400).json({ ok:false, message:"ramPct must be 0..100" });
      if (dsk === undefined || dsk < 0)
        return res.status(400).json({ ok:false, message:"diskGB must be >= 0" });

      const requireChgVal   = bool(req.body?.requireChg ?? req.body?.changeRequired ?? req.body?.requireChange);
      const autoMailVal     = bool(req.body?.autoMail ?? req.body?.prePatchMail);
      const postPatchVal    = bool(req.body?.postPatchMail); // <-- ADD

      const reportValue = num(req.body?.lastReportValue);
      const reportUnit  = req.body?.lastReportUnit;
      const validUnits  = ["minutes","hours","days"];
      if (reportValue !== undefined && (reportValue < 0 || !Number.isInteger(reportValue)))
        return res.status(400).json({ ok:false, message:"lastReportValue must be a positive integer" });
      if (reportUnit !== undefined && !validUnits.includes(reportUnit))
        return res.status(400).json({ ok:false, message:`lastReportUnit must be one of: ${validUnits.join(", ")}` });

      // - CONFIG.cpuThresholdPct = cpu; // REMOVED
      // - CONFIG.ramThresholdPct = ram; // REMOVED
      CONFIG.diskThresholdGB = dsk;

      if (requireChgVal !== undefined) CONFIG.requireChg  = requireChgVal;
      if (autoMailVal   !== undefined) CONFIG.autoMail    = autoMailVal;
      if (postPatchVal  !== undefined) CONFIG.postPatchMail = postPatchVal; // <-- ADD

      if (reportValue !== undefined) CONFIG.lastReportValue = reportValue;
      if (reportUnit  !== undefined) CONFIG.lastReportUnit  = reportUnit;

      res.json({ ok: true, config: { ...CONFIG } });
    } catch (e) {
      res.status(400).json({ ok:false, message:e?.message || "Bad request" });
    }
  });
}

module.exports = { attachConfigRoutes };