// src/routes/health.js
const { parseTupleRows } = require("../utils/query");
const { joinUrl } = require("../utils/http");
const { actionStore, CONFIG } = require("../state/store");
const { logFactory } = require("../utils/log");

// ----------------- HELPERS -----------------

function getThresholdMilliseconds(value, unit) {
  const v = Math.max(0, Number(value) || 0);
  switch (String(unit).toLowerCase()) {
    case "minutes": return v * 60 * 1000;
    case "hours": return v * 60 * 60 * 1000;
    case "days": default: return v * 24 * 60 * 60 * 1000;
  }
}

function isTimeUnhealthy(timeString, thresholdMs) {
  if (!timeString || timeString === "N/A") return true;
  try {
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

function collectStrings(node, out) {
  if (node == null) return;
  const t = typeof node;
  if (t === "string") {
    const s = node.trim();
    if (s && !s.startsWith("<")) out.push(s);
    return;
  }
  if (t === "number" || t === "boolean") { out.push(String(node)); return; }
  if (Array.isArray(node)) { for (const x of node) collectStrings(x, out); return; }
  if (t === "object") { for (const k of Object.keys(node)) collectStrings(node[k], out); }
}

// ------------------------------- ROUTES ---------------------------------

function attachHealthRoutes(app, ctx) {
  const log = logFactory(ctx.DEBUG_LOG);
  const { BIGFIX_BASE_URL, BIGFIX_USER, BIGFIX_PASS, httpsAgent } = ctx.bigfix;
  const axios = require("axios");

  app.get("/health", (req, res) => {
    log(req, "GET /health");
    res.json({ ok: true, ts: new Date().toISOString() });
  });

  // --- HELPER: Get Role Filter ---
  function getRoleFilter(req) {
    const userRole = req.headers['x-user-role'] || 'Admin';
    
    if (userRole === 'Windows') {
        return ` whose (operating system of it as lowercase contains "win")`;
    } 
    else if (userRole === 'Linux') {
        return ` whose (operating system of it as lowercase does not contain "win")`;
    } 
    else if (userRole === 'EUC') {
        // FIX: EUC Role - Strictly filter out Servers based on OS name
        // This ensures counts aren't inflated by Windows Servers
        return ` whose (operating system of it as lowercase does not contain "server")`;
    }
    return ""; // Admin sees all
  }

  // --- 1. TOTAL COMPUTERS (Filtered) ---
  app.get("/api/infra/total-computers", async (req, res) => {
    req._logStart = Date.now();
    try {
      log(req, "GET /api/infra/total-computers");
      
      const filter = getRoleFilter(req);
      const relevance = `number of bes computers${filter}`;
      
      const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
      
      const resp = await axios.get(url, {
        httpsAgent,
        auth: BIGFIX_USER && BIGFIX_PASS ? { username: BIGFIX_USER, password: BIGFIX_PASS } : undefined,
        headers: { Accept: "application/json" },
        responseType: "json",
        timeout: 60_000,
        validateStatus: () => true,
      });

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

  // ---------------------- CRITICAL HEALTH (Filtered + OS Aware) ----------------------
  app.get("/api/health/critical", async (req, res) => {
    req._logStart = Date.now();
    try {
      log(req, "GET /api/health/critical");

      const filter = getRoleFilter(req);
      const userRole = req.headers['x-user-role'] || 'Admin';
      
      const relevance =
        '((name of it | "N/A") ,' + 
        ' (value of result (it, bes property "Patch_Setu_Disk_Space") | "N/A"),' +
        ' (value of result (it, bes property "Patch_Setu_IP_Address") | "N/A"),' +
        ' (last report time of it as string | "N/A"),' + 
        ' (value of result (it, bes property "Patch_Setu_Window_Update_Service") | "N/A"),' +
        ' (operating system of it | "N/A"))' +
        ` of bes computers${filter}`;

      const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
      
      const resp = await axios.get(url, {
        httpsAgent,
        auth: BIGFIX_USER && BIGFIX_PASS ? { username: BIGFIX_USER, password: BIGFIX_PASS } : undefined,
        headers: { Accept: "application/json" },
        responseType: "json",
        timeout: 60_000,
        validateStatus: () => true,
      });

      if (resp.status < 200 || resp.status >= 300) {
        return res.status(resp.status).send(resp.data);
      }

      const tuples = parseTupleRows(resp.data);

      const afterEq = (s) => {
        const str = String(s || "").trim();
        const idx = str.indexOf("=");
        return idx >= 0 ? str.slice(idx + 1).trim() : str;
      };
      const parseDiskGB = (s) => {
        const m = String(s || "").match(/(\d+(?:\.\d+)?)\s*GB/i);
        return m ? Number(m[1]) : null;
      };

      const parsed = tuples.map((parts) => {
        const [serverStr, diskStr, ipStr, lastReportTime, serviceStatus, osStr] = parts;
        const diskPretty = afterEq(diskStr) || "N/A";
        return {
          server: afterEq(serverStr) || "N/A",
          disk: diskPretty,
          diskGB: parseDiskGB(diskPretty),
          ip: afterEq(ipStr) || "N/A",
          lastReportTime: lastReportTime || "N/A",
          serviceStatus: serviceStatus || "N/A",
          os: osStr || "N/A",
          raw: parts,
        };
      });

      const DSK_T = Number(CONFIG.diskThresholdGB);
      const { lastReportValue, lastReportUnit, checkServiceStatus } = CONFIG;
      const thresholdMs = getThresholdMilliseconds(lastReportValue, lastReportUnit);

      log(req, `Filtering health: Disk < ${DSK_T}GB, Last Report > ${lastReportValue} ${lastReportUnit}, Check Service: ${checkServiceStatus}`);

      const rows = parsed.map((r) => {
        const issues = [];
        const diskBad = r.diskGB != null && r.diskGB <= DSK_T;
        const timeBad = isTimeUnhealthy(r.lastReportTime, thresholdMs);
        
        if (diskBad) issues.push(`Low Disk (${r.diskGB}GB)`);
        if (timeBad) issues.push("Not Reporting");
        
        const isWindows = String(r.os).toLowerCase().includes("win");
        
        // FIX: Disable service status check for EUC users (prevents inflated error counts)
        if (checkServiceStatus && isWindows && userRole !== 'EUC' && r.serviceStatus.toLowerCase() !== "running") {
            issues.push(`Service ${r.serviceStatus} (Window Update)`);
        }
        
        if (issues.length > 0) {
            return { ...r, issues }; 
        }
        return null;
      }).filter(Boolean);

      res.json({ ok: true, count: rows.length, rows });
    } catch (err) {
      log(req, "Critical health error:", err?.message || err);
      res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  // -------------------- REBOOT PENDING (Filtered) --------------------
  app.get("/api/health/reboot-pending", async (req, res) => {
    req._logStart = Date.now();
    try {
      log(req, "GET /api/health/reboot-pending");

      const filter = getRoleFilter(req);
      
      const relevance =
        '((name of it | "N/A"), ' +
        '(value of result (it, bes property "Patch_Setu_Pending_Restart") | "N/A"), ' +
        '(last report time of it as string | "N/A"), ' +
        '(value of result (it, bes property "Patch_Setu_Disk_Space") | "N/A"), ' +
        '(value of result (it, bes property "Patch_Setu_IP_Address") | "N/A"), ' +
        '(value of result (it, bes property "Patch_Setu_UpTime") | "N/A"), ' +
        '(value of result (it, bes property "BES Relay Service Installed") | "N/A")) ' +
        `of bes computers${filter}`;

      const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
      
      const resp = await axios.get(url, {
        httpsAgent,
        auth: BIGFIX_USER && BIGFIX_PASS ? { username: BIGFIX_USER, password: BIGFIX_PASS } : undefined,
        headers: { Accept: "application/json" },
        responseType: "json",
        timeout: 60_000,
        validateStatus: () => true,
      });

      if (resp.status < 200 || resp.status >= 300) return res.status(resp.status).send(resp.data);

      const tuples = parseTupleRows(resp.data);

      const rowsAll = tuples.map((parts) => {
          if (!Array.isArray(parts) || parts.length < 7) return null;

          const [server, pendingStr, lastReportTime, diskStr, ipStr, uptime, besRelay] = parts;
          
          const ip = String(ipStr || "").replace(/^IP Address\s*=\s*/i, "").split(",")[0].trim() || "N/A";
          const disk = String(diskStr || "").trim() || "N/A";
          const pendingRestart = /^true$/i.test(String(pendingStr).trim());

          return {
            server: server || "N/A",
            pendingRestart,
            lastReportTime: lastReportTime || "N/A",
            disk,
            ip,
            uptime: uptime || "N/A",
            besRelay: besRelay || "N/A",
            raw: parts,
          };
        }).filter(Boolean);

      // Filter only those that actually need a restart
      const rows = rowsAll.filter((r) => r.pendingRestart === true);
      
      res.json({ ok: true, count: rows.length, rows });
    } catch (err) {
      log(req, "Reboot-pending error:", err?.message || err);
      res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });
}

module.exports = { attachHealthRoutes };