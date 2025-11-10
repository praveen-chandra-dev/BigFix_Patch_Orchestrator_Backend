// src/routes/health.js
const { parseTupleRows } = require("../utils/query");
const { joinUrl } = require("../utils/http");
const { actionStore, CONFIG } = require("../state/store");
const { logFactory } = require("../utils/log");

//
// ----------------- HELPERS (unchanged + tiny additions) -----------------
//

/**
 * Converts config values (e.g., 10, "days") into milliseconds
 * @returns {number} - Threshold in milliseconds
 */
function getThresholdMilliseconds(value, unit) {
  const v = Math.max(0, Number(value) || 0);
  switch (String(unit).toLowerCase()) {
    case "minutes":
      return v * 60 * 1000;
    case "hours":
      return v * 60 * 60 * 1000;
    case "days":
    default:
      return v * 24 * 60 * 60 * 1000;
  }
}

/**
 * Checks if a BigFix time string is older than the threshold
 * @param {string} timeString - e.g., "Fri, 07 Nov 2025 22:53:56 +0530"
 * @param {number} thresholdMs - The max age in milliseconds
 * @returns {boolean} - true if the time is older than the threshold, false otherwise
 */
function isTimeUnhealthy(timeString, thresholdMs) {
  if (!timeString || timeString === "N/A") {
    return true; // Count as unhealthy if we don't have a report time
  }
  try {
    // "Fri, 07 Nov 2025 22:53:56 +0530" -> drop weekday
    const parsableDate = timeString.substring(timeString.indexOf(", ") + 2);
    const lastReportTime = Date.parse(parsableDate);
    if (isNaN(lastReportTime)) return true;
    const now = Date.now();
    const age = now - lastReportTime;
    return age > thresholdMs;
  } catch {
    return true;
  }
}

/** Grab first/only string answers from /api/query?output=json payloads */
function collectStrings(node, out) {
  if (node == null) return;
  const t = typeof node;
  if (t === "string") {
    const s = node.trim();
    if (s && !s.startsWith("<")) out.push(s);
    return;
  }
  if (t === "number" || t === "boolean") {
    out.push(String(node));
    return;
  }
  if (Array.isArray(node)) {
    for (const x of node) collectStrings(x, out);
    return;
  }
  if (t === "object") {
    for (const k of Object.keys(node)) collectStrings(node[k], out);
  }
}

//
// ------------------------------- ROUTES ---------------------------------
//
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

  // ---------------------- CRITICAL HEALTH (existing) ----------------------
  app.get("/api/health/critical", async (req, res) => {
    req._logStart = Date.now();
    try {
      log(req, "GET /api/health/critical");

      const relevance =
        '((value of result (it, bes property "Patch_Orchestrator_Server_Name") | "N/A") ,' +
        ' (value of result (it, bes property "Patch_Orchestrator_RAM_Utilization") | "N/A"),' +
        ' (value of result (it, bes property "Patch_Orchestrator_CPU_Utilization") | "N/A") ,' +
        ' (value of result (it, bes property "Patch_Orchestrator_Disk_Space") | "N/A"),' +
        ' (value of result (it, bes property "Patch_Orchestrator_IP_Address") | "N/A"),' +
        ' (last report time of it as string | "N/A"))' +
        ' of bes computers';

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
        const [serverStr, ramStr, cpuStr, diskStr, ipStr, lastReportTime] = parts;
        const diskPretty = afterEq(diskStr) || "N/A";
        return {
          server: afterEq(serverStr) || "N/A",
          ramPct: numOrNull(ramStr),
          cpuPct: numOrNull(cpuStr),
          disk: diskPretty,
          diskGB: parseDiskGB(diskPretty),
          ip: afterEq(ipStr) || "N/A",
          lastReportTime: lastReportTime || "N/A",
          raw: parts,
        };
      });

      const RAM_T = Number(CONFIG.ramThresholdPct);
      const CPU_T = Number(CONFIG.cpuThresholdPct);
      const DSK_T = Number(CONFIG.diskThresholdGB);

      const { lastReportValue, lastReportUnit } = CONFIG;
      const thresholdMs = getThresholdMilliseconds(lastReportValue, lastReportUnit);

      log(
        req,
        `Filtering health: CPU > ${CPU_T}%, RAM > ${RAM_T}%, Disk < ${DSK_T}GB, Last Report > ${lastReportValue} ${lastReportUnit}`
      );

      const rows = parsed.filter((r) => {
        const ramBad = r.ramPct != null && r.ramPct >= RAM_T;
        const cpuBad = r.cpuPct != null && r.cpuPct >= CPU_T;
        const diskBad = r.diskGB != null && r.diskGB <= DSK_T;
        const timeBad = isTimeUnhealthy(r.lastReportTime, thresholdMs);
        return ramBad || cpuBad || diskBad || timeBad;
      });

      res.json({ ok: true, count: rows.length, rows });
    } catch (err) {
      log(req, "Critical health error:", err?.message || err);
      res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  // -------------------- NEW: REBOOT PENDING (requested) --------------------
  app.get("/api/health/reboot-pending", async (req, res) => {
    req._logStart = Date.now();
    try {
      log(req, "GET /api/health/reboot-pending");

      // Your provided relevance (string-concat with " | ")
      const relevance =
        '((name of it | "N/A") & " | " & ' +
        '(value of result (it, bes property "Patch_Orchestrator_Pending_Restart") | "N/A") & " | " & ' +
        '(last report time of it as string | "N/A")  & " | " & ' +
        '(value of result (it, bes property "Patch_Orchestrator_Disk_Space") | "N/A")  & " | " &  ' +
        '(value of result (it, bes property "Patch_Orchestrator_IP_Address") | "N/A")) ' +
        "of bes computers";

      const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
      log(req, "BF GET →", url);

      const axios = require("axios");
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

      // Parse concatenated strings like:
      // "SRAWIDBSQLP022 | True | Mon, 10 Nov 2025 14:21:35 +0530 | C: - Size = 78 GB | IP Address = 10.1.162.43"
      const strings = [];
      collectStrings(resp.data?.result, strings);

      const rowsAll = strings
        .map((s) => String(s).split(" | ").map((x) => x.trim()))
        .filter((parts) => parts.length >= 5)
        .map((parts) => {
          const [server, pendingStr, lastReportTime, diskStr, ipStr] = parts;

          const ip = String(ipStr || "")
            .replace(/^IP Address\s*=\s*/i, "")
            .split(",")[0]
            .trim() || "N/A";

          const disk = String(diskStr || "").trim() || "N/A";

          const pendingRestart = /^true$/i.test(String(pendingStr).trim());

          return {
            server: server || "N/A",
            pendingRestart,
            lastReportTime: lastReportTime || "N/A",
            disk,
            ip,
            raw: parts,
          };
        });

      // Keep only True results
      const rows = rowsAll.filter((r) => r.pendingRestart === true);

      res.json({ ok: true, count: rows.length, rows });
    } catch (err) {
      log(req, "Reboot-pending error:", err?.message || err);
      res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });
}

module.exports = { attachHealthRoutes };
