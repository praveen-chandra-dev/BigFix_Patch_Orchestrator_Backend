// src/routes/health.js
const { parseTupleRows } = require("../utils/query");
const { joinUrl } = require("../utils/http");
const { actionStore, CONFIG } = require("../state/store");
const { logFactory } = require("../utils/log");

function attachHealthRoutes(app, ctx) {
  const log = logFactory(ctx.DEBUG_LOG);
  const { BIGFIX_BASE_URL, BIGFIX_USER, BIGFIX_PASS, httpsAgent } = ctx.bigfix;
  const axios = require("axios");

  app.get("/health", (req, res) => {
    log(req, "GET /health");
    res.json({ ok: true, ts: new Date().toISOString() });
  });

  app.get("/api/infra/total-computers", async (req, res) => {
    req._logStart = Date.now();
    try {
      log(req, "GET /api/infra/total-computers");
      const relevance = "number of bes computers";
      const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
      log(req, "BF GET →", url);

      const resp = await axios.get(url, {
        httpsAgent,
        auth: BIGFIX_USER && BIGFIX_PASS ? { username: BIGFIX_USER, password: BIGFIX_PASS } : undefined,
        headers: { Accept: "application/json" },
        responseType: "json",
        timeout: 60_000,
        validateStatus: () => true,
      });

      log(req, "BF GET ←", resp.status);
      if (resp.status < 200 || resp.status >= 300) return res.status(resp.status).send(resp.data);

      let total = 0;
      const data = resp.data;
      if (data && data.result && Array.isArray(data.result) && data.result[0]) {
        const tuple = data.result[0].Tuple || data.result[0].tuple || data.result[0];
        const v = Array.isArray(tuple) ? tuple[0] : tuple;
        const m = String(v).match(/\d+/);
        if (m) total = Number(m[0]);
      }
      if (!total) {
        const m = JSON.stringify(resp.data).match(/\b\d+\b/);
        if (m) total = Number(m[0]);
      }

      res.json({ ok: true, total });
    } catch (err) {
      log(req, "total-computers error:", err?.message || err);
      res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  app.get("/api/health/critical", async (req, res) => {
    req._logStart = Date.now();
    try {
      log(req, "GET /api/health/critical");

      const relevance =
        '((value of result (it, bes property "Patch_Orchestrator_Server_Name") | "N/A") ,' +
        ' (value of result (it, bes property "Patch_Orchestrator_RAM_Utilization") | "N/A"),' +
        ' (value of result (it, bes property "Patch_Orchestrator_CPU_Utilization") | "N/A") ,' +
        ' (value of result (it, bes property "Patch_Orchestrator_Disk_Space") | "N/A"),' +
        ' (value of result (it, bes property "Patch_Orchestrator_IP_Address") | "N/A")) of bes computers';

      const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
      log(req, "BF GET →", url);

      const resp = await axios.get(url, {
        httpsAgent,
        auth: BIGFIX_USER && BIGFIX_PASS ? { username: BIGFIX_USER, password: BIGFIX_PASS } : undefined,
        headers: { Accept: "application/json" },
        responseType: "json",
        timeout: 60_000,
        validateStatus: () => true,
      });

      log(req, "BF GET ←", resp.status);
      if (resp.status < 200 || resp.status >= 300) {
        log(req, "BF GET error payload (first 300):", String(resp.data).slice(0, 300));
        return res.status(resp.status).send(resp.data);
      }

      const tuples = parseTupleRows(resp.data);

      const afterEq = (s) => {
        const str = String(s || "").trim();
        const idx = str.indexOf("=");
        return idx >= 0 ? str.slice(idx + 1).trim() : str;
      };
      const numOrNull = (s) => {
        const m = String(s || "").match(/-?\d+(\.\d+)?/);
        return m ? Number(m[0]) : null;
      };
      const parseDiskGB = (s) => {
        const m = String(s || "").match(/(\d+(?:\.\d+)?)\s*GB/i);
        return m ? Number(m[1]) : null;
      };

      const parsed = tuples.map((parts) => {
        const [serverStr, ramStr, cpuStr, diskStr, ipStr] = parts;
        const diskPretty = afterEq(diskStr) || "N/A";
        return {
          server: afterEq(serverStr) || "N/A",
          ramPct: numOrNull(ramStr),
          cpuPct: numOrNull(cpuStr),
          disk: diskPretty,
          diskGB: parseDiskGB(diskPretty),
          ip: afterEq(ipStr) || "N/A",
          raw: parts,
        };
      });

      const RAM_T = Number(CONFIG.ramThresholdPct);
      const CPU_T = Number(CONFIG.cpuThresholdPct);
      const DSK_T = Number(CONFIG.diskThresholdGB);

      const rows = parsed.filter((r) => {
        const ramBad  = r.ramPct  != null && r.ramPct  >= RAM_T;
        const cpuBad  = r.cpuPct  != null && r.cpuPct  >= CPU_T;
        const diskBad = r.diskGB  != null && r.diskGB  <= DSK_T;
        return ramBad || cpuBad || diskBad;
      });

      res.json({ ok: true, count: rows.length, rows });
    } catch (err) {
      log(req, "Critical health error:", err?.message || err);
      res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });
}

module.exports = { attachHealthRoutes };
