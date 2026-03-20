// src/routes/health.js
const axios = require("axios");
const { parseTupleRows } = require("../utils/query");
const { joinUrl, getBfAuthContext } = require("../utils/http");
const { CONFIG } = require("../state/store");
const { logFactory } = require("../utils/log");
const { getRoleAssets, isMasterOperator } = require("../services/bigfix");

const CACHE_TTL = 60 * 1000; 
let healthCache = {};

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

function getSessionUser(req) {
    if (req && req.cookies && req.cookies.auth_session) {
        try { return JSON.parse(req.cookies.auth_session).username; } catch(e){}
    }
    return "unknown";
}

function getSessionRole(req) {
    if (req && req.cookies && req.cookies.auth_session) {
        try { return JSON.parse(req.cookies.auth_session).role; } catch(e){}
    }
    return null;
}

async function getRoleFilter(req, ctx) {
    const operatorName = getSessionUser(req);
    const isMO = await isMasterOperator(req, ctx, operatorName);
    
    if (isMO) return "";

    const activeRole = req.headers['x-user-role'] || getSessionRole(req);
    if (!activeRole || activeRole === "Admin" || activeRole === "No Role Assigned") return " whose (false)"; 

    const roleAssets = await getRoleAssets(req, ctx, activeRole);
    if (!roleAssets.found || roleAssets.compNames.length === 0) return " whose (false)";

    const setStr = roleAssets.compNames.map(c => `"${c.toLowerCase()}"`).join("; ");
    return ` whose (name of it as lowercase is contained by set of (${setStr}))`;
}

function attachHealthRoutes(app, ctx) {
  const log = logFactory(ctx.DEBUG_LOG);
  const { BIGFIX_BASE_URL } = ctx.bigfix;

  app.get("/health", (req, res) => { res.json({ ok: true, ts: new Date().toISOString() }); });

  function getBaseComputers(groupName) {
      if (groupName) {
          const safeGroup = String(groupName).replace(/"/g, '""').toLowerCase();
          return `members of bes computer groups whose (name of it as lowercase = "${safeGroup}")`;
      }
      return `bes computers`;
  }

  app.get("/api/infra/total-computers", async (req, res) => {
    try {
      const activeRole = req.headers['x-user-role'] || getSessionRole(req);
      const cacheKey = `total_${getSessionUser(req)}_${activeRole}_${req.query.group || 'all'}`;
      const now = Date.now();
      
      if (healthCache[cacheKey] && now - healthCache[cacheKey].lastFetch < CACHE_TTL) {
          return res.json(healthCache[cacheKey].data);
      }

      const baseComp = getBaseComputers(req.query.group);
      const filter = await getRoleFilter(req, ctx);
      
      // FIX: Wrap baseComp in parenthesis to safely evaluate before applying role-based filter
      const relevance = `number of (${baseComp})${filter}`;
      const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
      
      const bfAuthOpts = await getBfAuthContext(req, ctx); 
      const resp = await axios.get(url, { ...bfAuthOpts, headers: { Accept: "application/json" }, validateStatus: () => true });

      if (resp.status < 200 || resp.status >= 300) return res.status(resp.status).send(resp.data);

      let total = 0;
      const data = resp.data;
      if (data && data.result && Array.isArray(data.result) && data.result[0]) {
        const tuple = data.result[0].Tuple || data.result[0].tuple || data.result[0];
        const m = String(Array.isArray(tuple) ? tuple[0] : tuple).match(/\d+/);
        if (m) total = Number(m[0]);
      }
      if (!total) {
        const m = JSON.stringify(resp.data).match(/\b\d+\b/);
        if (m) total = Number(m[0]);
      }
      
      const payload = { ok: true, total };
      healthCache[cacheKey] = { data: payload, lastFetch: now };
      res.json(payload);
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.get("/api/health/critical", async (req, res) => {
    try {
      const activeRole = req.headers['x-user-role'] || getSessionRole(req);
      const cacheKey = `crit_${getSessionUser(req)}_${activeRole}_${req.query.group || 'all'}`;
      const now = Date.now();
      
      if (healthCache[cacheKey] && now - healthCache[cacheKey].lastFetch < CACHE_TTL) {
          return res.json(healthCache[cacheKey].data);
      }

      const baseComp = getBaseComputers(req.query.group);
      const filter = await getRoleFilter(req, ctx);
      
      // FIX: Wrap baseComp in parenthesis to safely evaluate before applying role-based filter
      const relevance = '((name of it | "N/A") ,' + 
        ' (value of result (it, bes property "Patch_Setu_Disk_Space") | "N/A"),' +
        ' (value of result (it, bes property "Patch_Setu_IP_Address") | "N/A"),' +
        ' (last report time of it as string | "N/A"),' + 
        ' (value of result (it, bes property "Patch_Setu_Window_Update_Service") | "N/A"),' +
        ' (operating system of it | "N/A"))' +
        ` of (${baseComp})${filter}`;
        
      const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
      
      const bfAuthOpts = await getBfAuthContext(req, ctx); 
      const resp = await axios.get(url, { ...bfAuthOpts, headers: { Accept: "application/json" }, validateStatus: () => true });

      if (resp.status < 200 || resp.status >= 300) return res.status(resp.status).send(resp.data);

      const tuples = parseTupleRows(resp.data);
      const afterEq = (s) => { const str = String(s || "").trim(); const idx = str.indexOf("="); return idx >= 0 ? str.slice(idx + 1).trim() : str; };
      const parseDiskGB = (s) => { const m = String(s || "").match(/(\d+(?:\.\d+)?)\s*GB/i); return m ? Number(m[1]) : null; };

      const parsed = tuples.map((parts) => {
        const diskPretty = afterEq(parts[1]) || "N/A";
        return { server: afterEq(parts[0]) || "N/A", disk: diskPretty, diskGB: parseDiskGB(diskPretty), ip: afterEq(parts[2]) || "N/A", lastReportTime: parts[3] || "N/A", serviceStatus: parts[4] || "N/A", os: parts[5] || "N/A", raw: parts };
      });

      const DSK_T = Number(CONFIG.diskThresholdGB);
      const thresholdMs = getThresholdMilliseconds(CONFIG.lastReportValue, CONFIG.lastReportUnit);

      const rows = parsed.map((r) => {
        const issues = [];
        if (r.diskGB != null && r.diskGB <= DSK_T) issues.push(`Low Disk (${r.diskGB}GB)`);
        if (isTimeUnhealthy(r.lastReportTime, thresholdMs)) issues.push("Not Reporting");
        if (CONFIG.checkServiceStatus && String(r.os).toLowerCase().includes("win") && r.serviceStatus.toLowerCase() !== "running") issues.push(`Service ${r.serviceStatus}`);
        
        return issues.length > 0 ? { ...r, issues } : null;
      }).filter(Boolean);

      const payload = { ok: true, count: rows.length, rows };
      healthCache[cacheKey] = { data: payload, lastFetch: now };
      res.json(payload);
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.get("/api/health/reboot-pending", async (req, res) => {
    try {
      const activeRole = req.headers['x-user-role'] || getSessionRole(req);
      const cacheKey = `reboot_${getSessionUser(req)}_${activeRole}_${req.query.group || 'all'}`;
      const now = Date.now();
      
      if (healthCache[cacheKey] && now - healthCache[cacheKey].lastFetch < CACHE_TTL) {
          return res.json(healthCache[cacheKey].data);
      }

      const baseComp = getBaseComputers(req.query.group);
      const filter = await getRoleFilter(req, ctx);
      
      // FIX: Wrap baseComp in parenthesis to safely evaluate before applying role-based filter
      const relevance = '((name of it | "N/A"), ' +
        '(value of result (it, bes property "Patch_Setu_Pending_Restart") | "N/A"), ' +
        '(last report time of it as string | "N/A"), ' +
        '(value of result (it, bes property "Patch_Setu_Disk_Space") | "N/A"), ' +
        '(value of result (it, bes property "Patch_Setu_IP_Address") | "N/A"), ' +
        '(value of result (it, bes property "Patch_Setu_UpTime") | "N/A"), ' +
        '(value of result (it, bes property "BES Relay Service Installed") | "N/A")) ' +
        `of (${baseComp})${filter}`;
        
      const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
      
      const bfAuthOpts = await getBfAuthContext(req, ctx); 
      const resp = await axios.get(url, { ...bfAuthOpts, headers: { Accept: "application/json" } });
      if (resp.status < 200 || resp.status >= 300) return res.status(resp.status).send(resp.data);

      const tuples = parseTupleRows(resp.data);
      const rows = tuples.map((parts) => {
          if (!Array.isArray(parts) || parts.length < 7) return null;
          const [server, pendingStr, lastReportTime, diskStr, ipStr, uptime, besRelay] = parts;
          return { server: server || "N/A", pendingRestart: /^true$/i.test(String(pendingStr).trim()), lastReportTime: lastReportTime || "N/A", disk: String(diskStr || "").trim() || "N/A", ip: String(ipStr || "").replace(/^IP Address\s*=\s*/i, "").split(",")[0].trim() || "N/A", uptime: uptime || "N/A", besRelay: besRelay || "N/A", raw: parts };
        }).filter(r => r && r.pendingRestart === true);

      const payload = { ok: true, count: rows.length, rows };
      healthCache[cacheKey] = { data: payload, lastFetch: now };
      res.json(payload);
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });
}

module.exports = { attachHealthRoutes };