// src/routes/health.js
const axios = require("axios");
const { parseTupleRows } = require("../utils/query");
const { joinUrl, getBfAuthContext, getSessionUser, getSessionRole } = require("../utils/http");
const { CONFIG } = require("../state/store");
const { logFactory } = require("../utils/log");
const { getRoleAssets, isMasterOperator, bigfixClient } = require("../services/bigfix");

const CACHE_TTL = 5 * 60 * 1000; 

let globalHealthCache = {
    totalComputers: { data: [], lastFetch: 0 },
    critical: { data: [], lastFetch: 0 },
    reboot: { data: [], lastFetch: 0 }
};

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
    return (Date.now() - lastReportTime) > thresholdMs;
  } catch { return true; }
}

function attachHealthRoutes(app, ctx) {
  const log = logFactory(ctx.DEBUG_LOG);
  const { BIGFIX_BASE_URL } = ctx.bigfix;

  app.get("/health", (req, res) => { res.json({ ok: true, ts: new Date().toISOString() }); });

  app.get("/api/infra/total-computers", async (req, res) => {
    try {
      const activeRole = req.headers['x-user-role'] || getSessionRole(req);
      const activeUser = getSessionUser(req);
      const isMO = await isMasterOperator(req, ctx, activeUser);
      const now = Date.now();

      if (now - globalHealthCache.totalComputers.lastFetch > CACHE_TTL) {
          const masterAuthOpts = await getBfAuthContext(null, ctx); 
          const relevance = `(id of it as string & "||" & name of it as string) of bes computers`;
          const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
          const resp = await axios.get(url, { ...masterAuthOpts, headers: { Accept: "application/json" }, validateStatus: () => true });

          if (resp.status === 200 && resp.data?.result) {
              const raw = Array.isArray(resp.data.result) ? resp.data.result : [resp.data.result];
              globalHealthCache.totalComputers.data = raw.map(r => String(r).split("||")[1].toLowerCase().trim());
              globalHealthCache.totalComputers.lastFetch = now;
          }
      }

      let compList = globalHealthCache.totalComputers.data || [];

      // if (!isMO && activeRole && activeRole !== "Admin" && activeRole !== "No Role Assigned") {
      //     const roleAssets = await getRoleAssets(req, ctx, activeRole);
      //     const allowedSet = new Set(roleAssets.found ? roleAssets.compNames : []);
      //     compList = compList.filter(c => allowedSet.has(c));
      // }

      if (!isMO) {
          if (!activeRole || activeRole === "No Role Assigned") {
              compList = []; // 🚀 explicitly block all data (use rows = [] for the other two routes)
          } else if (activeRole !== "Admin") {
              const roleAssets = await getRoleAssets(req, ctx, activeRole);
              const allowedSet = new Set(roleAssets.found ? roleAssets.compNames : []);
              compList = compList.filter(c => allowedSet.has(c));
          }
      }

      if (req.query.group) {
          const client = bigfixClient(req, ctx);
          const members = await client.getGroupMembers(req.query.group);
          const groupSet = new Set(members.map(m => m.name.toLowerCase()));
          compList = compList.filter(c => groupSet.has(c));
      }

      res.json({ ok: true, total: compList.length });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.get("/api/health/critical", async (req, res) => {
    try {
      const activeRole = req.headers['x-user-role'] || getSessionRole(req);
      const activeUser = getSessionUser(req);
      const isMO = await isMasterOperator(req, ctx, activeUser);
      const now = Date.now();

      if (now - globalHealthCache.critical.lastFetch > CACHE_TTL || req.query.refresh === 'true') {
          const masterAuthOpts = await getBfAuthContext(null, ctx);
          const relevance = '((name of it | "N/A") ,' + 
            ' (value of result (it, bes property "Patch_Setu_Disk_Space") | "N/A"),' +
            ' (value of result (it, bes property "Patch_Setu_IP_Address") | "N/A"),' +
            ' (last report time of it as string | "N/A"),' + 
            ' (value of result (it, bes property "Patch_Setu_Window_Update_Service") | "N/A"),' +
            ' (operating system of it | "N/A")) of bes computers';
            
          const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
          const resp = await axios.get(url, { ...masterAuthOpts, headers: { Accept: "application/json" }, validateStatus: () => true });

          if (resp.status === 200) {
              const tuples = parseTupleRows(resp.data);
              const afterEq = (s) => { const str = String(s || "").trim(); const idx = str.indexOf("="); return idx >= 0 ? str.slice(idx + 1).trim() : str; };
              const parseDiskGB = (s) => { const m = String(s || "").match(/(\d+(?:\.\d+)?)\s*GB/i); return m ? Number(m[1]) : null; };

              const parsed = tuples.map((parts) => {
                const diskPretty = afterEq(parts[1]) || "N/A";
                return { server: afterEq(parts[0]) || "N/A", disk: diskPretty, diskGB: parseDiskGB(diskPretty), ip: afterEq(parts[2]) || "N/A", lastReportTime: parts[3] || "N/A", serviceStatus: parts[4] || "N/A", os: parts[5] || "N/A", raw: parts };
              });

              globalHealthCache.critical.data = parsed;
              globalHealthCache.critical.lastFetch = now;
          }
      }

      let rows = globalHealthCache.critical.data || [];

      const DSK_T = Number(CONFIG.diskThresholdGB);
      const thresholdMs = getThresholdMilliseconds(CONFIG.lastReportValue, CONFIG.lastReportUnit);

      rows = rows.map((r) => {
        const issues = [];
        if (r.diskGB != null && r.diskGB <= DSK_T) issues.push(`Low Disk (${r.diskGB}GB)`);
        if (isTimeUnhealthy(r.lastReportTime, thresholdMs)) issues.push("Not Reporting");
        if (CONFIG.checkServiceStatus && String(r.os).toLowerCase().includes("win") && r.serviceStatus.toLowerCase() !== "running") issues.push(`Service ${r.serviceStatus}`);
        return issues.length > 0 ? { ...r, issues } : null;
      }).filter(Boolean);

      // if (!isMO && activeRole && activeRole !== "Admin" && activeRole !== "No Role Assigned") {
      //     const roleAssets = await getRoleAssets(req, ctx, activeRole);
      //     const allowedSet = new Set(roleAssets.found ? roleAssets.compNames : []);
      //     rows = rows.filter(r => allowedSet.has(String(r.server).toLowerCase().trim()));
      // }
      if (!isMO) {
          if (!activeRole || activeRole === "No Role Assigned") {
              rows = []; // 🚀 explicitly block all data (use rows = [] for the other two routes)
          } else if (activeRole !== "Admin") {
              const roleAssets = await getRoleAssets(req, ctx, activeRole);
              const allowedSet = new Set(roleAssets.found ? roleAssets.compNames : []);
              rows = rows.filter(r => allowedSet.has(String(r.server).toLowerCase().trim()));
          }
      }
      
      if (req.query.group) {
         const client = bigfixClient(req, ctx);
         const members = await client.getGroupMembers(req.query.group);
         const groupSet = new Set(members.map(m => m.name.toLowerCase()));
         rows = rows.filter(r => groupSet.has(String(r.server).toLowerCase().trim()));
      }

      res.json({ ok: true, count: rows.length, rows });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.get("/api/health/reboot-pending", async (req, res) => {
    try {
      const activeRole = req.headers['x-user-role'] || getSessionRole(req);
      const activeUser = getSessionUser(req);
      const isMO = await isMasterOperator(req, ctx, activeUser); 
      const now = Date.now();
      
      if (now - globalHealthCache.reboot.lastFetch > CACHE_TTL || req.query.refresh === 'true') {
          const masterAuthOpts = await getBfAuthContext(null, ctx);
          const relevance = '((name of it | "N/A"), ' +
            '(value of result (it, bes property "Patch_Setu_Pending_Restart") | "N/A"), ' +
            '(last report time of it as string | "N/A"), ' +
            '(value of result (it, bes property "Patch_Setu_Disk_Space") | "N/A"), ' +
            '(value of result (it, bes property "Patch_Setu_IP_Address") | "N/A"), ' +
            '(value of result (it, bes property "Patch_Setu_UpTime") | "N/A"), ' +
            '(value of result (it, bes property "BES Relay Service Installed") | "N/A")) of bes computers';
            
          const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
          const resp = await axios.get(url, { ...masterAuthOpts, headers: { Accept: "application/json" } });
          
          if (resp.status === 200) {
              const tuples = parseTupleRows(resp.data);
              globalHealthCache.reboot.data = tuples.map((parts) => {
                  if (!Array.isArray(parts) || parts.length < 7) return null;
                  const [server, pendingStr, lastReportTime, diskStr, ipStr, uptime, besRelay] = parts;
                  return { server: server || "N/A", pendingRestart: /^true$/i.test(String(pendingStr).trim()), lastReportTime: lastReportTime || "N/A", disk: String(diskStr || "").trim() || "N/A", ip: String(ipStr || "").replace(/^IP Address\s*=\s*/i, "").split(",")[0].trim() || "N/A", uptime: uptime || "N/A", besRelay: besRelay || "N/A", raw: parts };
              }).filter(r => r && r.pendingRestart === true);
              
              globalHealthCache.reboot.lastFetch = now;
          }
      }

      let rows = globalHealthCache.reboot.data || [];

      // if (!isMO && activeRole && activeRole !== "Admin" && activeRole !== "No Role Assigned") {
      //     const roleAssets = await getRoleAssets(req, ctx, activeRole);
      //     const allowedSet = new Set(roleAssets.found ? roleAssets.compNames : []);
      //     rows = rows.filter(r => allowedSet.has(String(r.server).toLowerCase().trim()));
      // }
        if (!isMO) {
            if (!activeRole || activeRole === "No Role Assigned") {
                rows = []; // 🚀 explicitly block all data (use rows = [] for the other two routes)
            } else if (activeRole !== "Admin") {
                const roleAssets = await getRoleAssets(req, ctx, activeRole);
                const allowedSet = new Set(roleAssets.found ? roleAssets.compNames : []);
                rows = rows.filter(r => allowedSet.has(String(r.server).toLowerCase().trim()));
            }
        }

      if (req.query.group) {
         const client = bigfixClient(req, ctx);
         const members = await client.getGroupMembers(req.query.group);
         const groupSet = new Set(members.map(m => m.name.toLowerCase()));
         rows = rows.filter(r => groupSet.has(String(r.server).toLowerCase().trim()));
      }

      res.json({ ok: true, count: rows.length, rows });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });
}

module.exports = { attachHealthRoutes };