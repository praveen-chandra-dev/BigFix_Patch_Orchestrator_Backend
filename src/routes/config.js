// src/routes/config.js
const { CONFIG } = require("../state/store");
const { logFactory } = require("../utils/log");

function attachConfigRoutes(app, ctx) {
  const log = logFactory(ctx.DEBUG_LOG);

  app.get("/api/config", (req, res) => {
    req._logStart = Date.now();
    log(req, "GET /api/config");
    res.json({ ok: true, ...CONFIG });
  });

  app.post("/api/config", (req, res) => {
    req._logStart = Date.now();
    log(req, "POST /api/config body:", req.body);
    try {
      const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : undefined);

      const cpu = num(req.body?.cpuThresholdPct) ?? num(req.body?.cpuThreshold);
      const ram = num(req.body?.ramThresholdPct) ?? num(req.body?.ramThreshold);
      const dsk = num(req.body?.diskThresholdGB) ?? num(req.body?.diskThreshold);

      if (cpu === undefined || cpu < 0 || cpu > 100) {
        return res.status(400).json({ ok: false, message: "cpuPct must be 0..100" });
      }
      if (ram === undefined || ram < 0 || ram > 100) {
        return res.status(400).json({ ok: false, message: "ramPct must be 0..100" });
      }
      if (dsk === undefined || dsk < 0) {
        return res.status(400).json({ ok: false, message: "diskGB must be >= 0" });
      }

      let requireChgRaw = req.body?.requireChg ?? req.body?.changeRequired ?? req.body?.requireChange;
      if (requireChgRaw !== undefined) {
        const truthy = [true, "true", 1, "1"];
        const falsy  = [false, "false", 0, "0"];
        if (truthy.includes(requireChgRaw)) CONFIG.requireChg = true;
        else if (falsy.includes(requireChgRaw)) CONFIG.requireChg = false;
        else return res.status(400).json({ ok: false, message: "requireChg must be boolean (true/false)" });
      }

      CONFIG.cpuThresholdPct = cpu;
      CONFIG.ramThresholdPct = ram;
      CONFIG.diskThresholdGB = dsk;

      res.json({ ok: true, config: { ...CONFIG } });
    } catch (e) {
      res.status(400).json({ ok: false, message: e?.message || "Bad request" });
    }
  });
}

module.exports = { attachConfigRoutes };
