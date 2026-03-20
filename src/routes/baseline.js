// src/routes/baseline.js
const axios = require("axios");
const { joinUrl, getBfAuthContext } = require("../utils/http");
const { logFactory } = require("../utils/log");
const { sql, getPool } = require("../db/mssql");
const { getRoleAssets, isMasterOperator } = require("../services/bigfix");

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

function attachBaselineRoutes(app, ctx) {
  const log = logFactory(ctx.DEBUG_LOG);
  const { BIGFIX_BASE_URL } = ctx.bigfix;

  app.get("/api/baseline/sites", async (req, res) => {
    try {
        const activeRole = req.headers['x-user-role'] || getSessionRole(req);
        const activeUser = getSessionUser(req);
        const isMO = await isMasterOperator(req, ctx, activeUser);

        let sites = [];
        if (isMO) {
            const bfAuthOpts = await getBfAuthContext(req, ctx);
            const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent("unique values of names of all bes sites")}`;
            const resp = await axios.get(url, { ...bfAuthOpts, headers: { Accept: "application/json" } });
            const result = resp.data?.result;
            sites = Array.isArray(result) ? result : (result ? [result] : []);
        } else if (activeRole && activeRole !== "Admin" && activeRole !== "No Role Assigned") {
            const roleAssets = await getRoleAssets(req, ctx, activeRole);
            sites = [...(roleAssets.customSites || []), ...(roleAssets.externalSites || [])];
        }
        res.json({ ok: true, sites: [...new Set(sites)] });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // FIXED: Explicitly separated custom-sites endpoint to never show external sites
  app.get("/api/baseline/custom-sites", async (req, res) => {
    try {
        const activeRole = req.headers['x-user-role'] || getSessionRole(req);
        const activeUser = getSessionUser(req);
        const isMO = await isMasterOperator(req, ctx, activeUser);

        let sites = [];
        if (isMO) {
            const bfAuthOpts = await getBfAuthContext(req, ctx);
            const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent("unique values of names of bes custom sites")}`;
            const resp = await axios.get(url, { ...bfAuthOpts, headers: { Accept: "application/json" } });
            const result = resp.data?.result;
            sites = Array.isArray(result) ? result : (result ? [result] : []);
        } else if (activeRole && activeRole !== "Admin" && activeRole !== "No Role Assigned") {
            const roleAssets = await getRoleAssets(req, ctx, activeRole);
            sites = roleAssets.customSites || [];
        }
        res.json({ ok: true, sites: [...new Set(sites)] });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get(["/api/baselines", "/api/baselines/list"], async (req, res) => {
    try {
        const activeRole = req.headers['x-user-role'] || getSessionRole(req);
        const activeUser = getSessionUser(req);
        const isMO = await isMasterOperator(req, ctx, activeUser);

        let siteFilter = "";
        if (!isMO && activeRole && activeRole !== "Admin" && activeRole !== "No Role Assigned") {
            const roleAssets = await getRoleAssets(req, ctx, activeRole);
            const allowedSites = [...(roleAssets.customSites || []), ...(roleAssets.externalSites || [])].map(s => `"${s.toLowerCase()}"`).join("; ");
            if (allowedSites) siteFilter = ` whose (name of site of it as lowercase is contained by set of (${allowedSites}) or name of site of it as lowercase = "action site" or name of site of it as lowercase = "master action site")`;
            else siteFilter = ` whose (name of site of it as lowercase = "action site" or name of site of it as lowercase = "master action site")`;
        }

        const relevance = `(id of it as string & "||" & name of it) of bes baselines${siteFilter}`;
        const bfAuthOpts = await getBfAuthContext(req, ctx);
        const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
        
        const resp = await axios.get(url, { ...bfAuthOpts, headers: { Accept: "application/json" } });
        let baselines = [];
        if (resp.status === 200 && resp.data?.result) {
            const raw = Array.isArray(resp.data.result) ? resp.data.result : [resp.data.result];
            baselines = raw.map(r => {
                const parts = String(r).split("||");
                return { id: parts[0], name: parts[1] };
            });
        }
        baselines.sort((a, b) => a.name.localeCompare(b.name));
        res.json({ ok: true, data: baselines, baselines: baselines });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get("/api/baseline/patches", async (req, res) => {
    const { site } = req.query;
    if (!site) return res.status(400).json({ ok: false, error: "Site parameter required" });
    try {
      const safeSite = site.replace(/"/g, '%22');
      const relevance = `((id of it as string | "N/A") & " | " & (name of it | "N/A") & " | " & (display name of site of it as string | "N/A") & " | " & (source severity of it | "N/A")) of bes fixlets whose(display name of site of it is "${safeSite}" and applicable computer count of it > 0 and fixlet flag of it and exists default action of it)`;      
      const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
      
      const bfAuthOpts = await getBfAuthContext(req, ctx); 
      const resp = await axios.get(url, { ...bfAuthOpts, headers: { Accept: "application/json" } });
      
      let rawResults = resp.data?.result || [];
      if (!Array.isArray(rawResults)) rawResults = [rawResults];
      const patches = rawResults.map((str) => {
        const parts = String(str).split(" | ");
        return { id: parts[0] || "N/A", name: parts[1] || "N/A", site: parts[2] || safeSite, severity: parts[3] || "Unspecified" };
      });
      res.json({ ok: true, count: patches.length, patches });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post("/api/baseline/create", async (req, res) => {
    const { baselineName, targetSite, patchKeys } = req.body;
    const userRole = req.headers['x-user-role'] || 'Admin'; 

    if (!baselineName || !targetSite || !Array.isArray(patchKeys) || patchKeys.length === 0) return res.status(400).json({ ok: false, error: "Missing required fields." });
    try {
      const bfAuthOpts = await getBfAuthContext(req, ctx); 

      const siteToIds = new Map();
      for (const key of patchKeys) {
        const [idRaw, siteRaw] = String(key).split("||");
        const id = idRaw && idRaw.trim();
        const siteName = siteRaw && siteRaw.trim();
        if (!id || !siteName) continue;
        if (!siteToIds.has(siteName)) siteToIds.set(siteName, new Set());
        siteToIds.get(siteName).add(id);
      }
      if (siteToIds.size === 0) throw new Error("No valid keys provided.");
      
      const patchMap = new Map();
      for (const [siteName, idsSet] of siteToIds.entries()) {
        const idsStr = Array.from(idsSet).join(";");
        const safeSite = siteName.replace(/"/g, '%22');
        const relevance = `("ID: " & (id of it as string | "N/A") & " || SourceURL: " & (url of site of it as string | "N/A") & " || Site: " & (display name of site of it | "N/A")) of bes fixlets whose (display name of site of it = "${safeSite}" and id of it is contained by set of (${idsStr}))`;
        const qUrl = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
        
        const qResp = await axios.get(qUrl, { ...bfAuthOpts, headers: { Accept: "application/json" } });
        let queryResults = qResp.data?.result || [];
        if (!Array.isArray(queryResults)) queryResults = [queryResults];
        queryResults.forEach((row) => {
          const parts = String(row).split(" || ");
          if (parts.length >= 3) {
            const idPart = parts[0].replace("ID: ", "").trim();
            const urlPart = parts[1].replace("SourceURL: ", "").trim();
            const sitePart = parts[2].replace("Site: ", "").trim();
            if (idPart && urlPart && sitePart) patchMap.set(`${idPart}||${sitePart}`, urlPart);
          }
        });
      }

      let componentsXml = "";
      for (const key of patchKeys) {
        const [idStr, siteName] = String(key).split("||");
        if (!idStr || !siteName) continue;
        const sourceUrl = patchMap.get(`${idStr.trim()}||${siteName.trim()}`);
        if (sourceUrl) componentsXml += `<BaselineComponent IncludeInRelevance="true" SourceSiteURL="${sourceUrl}" SourceID="${idStr.trim()}" ActionName="Action1" />`;
      }
      if (!componentsXml) throw new Error("No valid components generated.");

      const xmlEscape = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const finalXml = `<?xml version="1.0" encoding="UTF-8"?><BES xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="BES.xsd"><Baseline><Title>${xmlEscape(baselineName)}</Title><Description /><Relevance>true</Relevance><BaselineComponentCollection><BaselineComponentGroup>${componentsXml}</BaselineComponentGroup></BaselineComponentCollection></Baseline></BES>`;
      
      const postUrl = joinUrl(BIGFIX_BASE_URL, `/api/baselines/custom/${encodeURIComponent(targetSite)}`);
      
      const postResp = await axios.post(postUrl, finalXml, { ...bfAuthOpts, headers: { "Content-Type": "application/xml" } });
      let baselineId = null;
      const idMatch = String(postResp.data || "").match(/<ID>(\d+)<\/ID>/);
      if (idMatch) baselineId = idMatch[1];
      
      if (baselineId) {
         try {
            const pool = await getPool();
            await pool.request().input('BigFixID', sql.NVarChar(255), String(baselineId)).input('AssetName', sql.NVarChar(255), baselineName).input('AssetType', sql.NVarChar(50), 'Baseline').input('CreatedByRole', sql.NVarChar(50), userRole).query(`INSERT INTO dbo.AssetOwnership (BigFixID, AssetName, AssetType, CreatedByRole, CreatedAt) VALUES (@BigFixID, @AssetName, @AssetType, @CreatedByRole, SYSUTCDATETIME())`);
         } catch (dbErr) { }
      }
      res.json({ ok: true, baselineId, baselineName });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.response?.data || e.message });
    }
  });

  app.delete("/api/baselines/:id", async (req, res) => {
      const { id } = req.params;
      try {
          const bfAuthOpts = await getBfAuthContext(req, ctx);
          try { 
              await axios.delete(joinUrl(BIGFIX_BASE_URL, `/api/baseline/master/${id}`), bfAuthOpts); 
          } catch (e) { 
              try {
                  const operatorName = bfAuthOpts.auth.username;
                  await axios.delete(joinUrl(BIGFIX_BASE_URL, `/api/baseline/operator/${encodeURIComponent(operatorName)}/${id}`), bfAuthOpts);
              } catch(err) {
                  return res.status(403).json({ ok: false, error: "Permission Denied by BigFix" });
              }
          }
          
          try {
             const pool = await getPool();
             await pool.request().input('ID', sql.NVarChar(255), id).query("DELETE FROM dbo.AssetOwnership WHERE BigFixID = @ID AND AssetType='Baseline'");
          } catch(err) {}

          res.json({ ok: true });
      } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  
  app.post("/api/baseline/validate", async (req, res) => {
    const { baselineName } = req.body;
    if (!baselineName) return res.status(400).json({ ok: false, error: "baselineName required" });

    try {
      const safeName = baselineName.replace(/"/g, '\\"');
      const relevance = `(creation time of it as string & "||" & modification time of it as string) of bes baselines whose (name of it = "${safeName}")`;
      const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
      
      const bfAuthOpts = await getBfAuthContext(req, ctx); 
      const resp = await axios.get(url, { ...bfAuthOpts, headers: { Accept: "application/json" } });

      if (resp.status < 200 || resp.status >= 300) throw new Error(`BigFix query failed: ${resp.status}`);

      const result = resp.data?.result;
      const val = Array.isArray(result) ? result[0] : result;
      let warning = null;

      if (val && typeof val === 'string' && val.includes("||")) {
          const [cTimeStr, mTimeStr] = val.split("||");
          if (new Date(mTimeStr) > new Date(cTimeStr)) warning = `Baseline was modified on ${mTimeStr}`;
      }
      res.json({ ok: true, modified: !!warning, warning });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
}

module.exports = { attachBaselineRoutes };