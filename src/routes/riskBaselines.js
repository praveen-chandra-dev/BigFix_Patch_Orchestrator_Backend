// src/routes/riskBaselines.js
const express = require("express");
const axios = require("axios");
const { parseStringPromise } = require("xml2js");
const { prismRequest } = require("../services/prism");
const { getBfAuthContext, joinUrl, escapeXML, getSessionUser, getSessionRole } = require("../utils/http");
const { isMasterOperator, getRoleAssets } = require("../services/bigfix");
const { logFactory } = require("../utils/log");

let allSitesCache = null;
let allSitesCacheTime = 0;

function buildBaselineUrl(bfUrl, siteType, siteName, bfId, isCreate = false) {
    const type = String(siteType || "").toLowerCase().trim();
    const sName = String(siteName || "").toLowerCase().trim();
    const resource = isCreate ? "baselines" : "baseline";

    if (type === "master" || sName === "actionsite" || sName === "master action site") {
        return isCreate ? `${bfUrl}/api/${resource}/master` : `${bfUrl}/api/${resource}/master/${bfId}`;
    }
    if (type === "custom") {
        return isCreate ? `${bfUrl}/api/${resource}/custom/${encodeURIComponent(siteName)}` : `${bfUrl}/api/${resource}/custom/${encodeURIComponent(siteName)}/${bfId}`;
    }
    if (type === "external") {
        return isCreate ? `${bfUrl}/api/${resource}/external/${encodeURIComponent(siteName)}` : `${bfUrl}/api/${resource}/external/${encodeURIComponent(siteName)}/${bfId}`;
    }
    return isCreate ? `${bfUrl}/api/${resource}/master` : `${bfUrl}/api/${resource}/master/${bfId}`;
}

async function getAllSitesMap(bfAuthOpts, bfUrl) {
    if (allSitesCache && (Date.now() - allSitesCacheTime < 3600000)) return allSitesCache;
    const rel = `(name of it & "||" & url of it) of all bes sites`;
    const resp = await axios.get(`${bfUrl}/api/query?output=json&relevance=${encodeURIComponent(rel)}`, { ...bfAuthOpts, headers: { Accept: "application/json" }, validateStatus: () => true });
    const map = new Map();
    const raw = Array.isArray(resp.data?.result) ? resp.data.result : [resp.data?.result].filter(Boolean);
    raw.forEach(r => {
        const parts = String(r).split("||");
        if(parts.length >= 2) {
            map.set(parts[0].trim().toLowerCase(), parts[1].trim());
        }
    });
    map.set("actionsite", `${bfUrl}/cgi-bin/bfgather.exe/actionsite`);
    allSitesCache = map;
    allSitesCacheTime = Date.now();
    return map;
}

async function getBaselineLocation(req, ctx, baselineId) {
  const bfAuthOpts = await getBfAuthContext(null, ctx); 
  const bfUrl = (ctx.cfg?.BIGFIX_BASE_URL || "").replace(/\/$/, "");

  const parseSiteInfo = (val) => {
    const [siteType, rawSiteName] = String(val).split("||");
    return { siteType: siteType.trim(), siteName: rawSiteName.trim() };
  };

  let relevance = `((if (name of site of it as lowercase = "actionsite" or name of site of it as lowercase = "master action site") then "master" else if (custom site flag of site of it) then "custom" else "external") & "||" & (if exists display name of site of it then display name of site of it else name of site of it)) of bes baselines whose (id of it = ${baselineId})`;
  let response = await axios.get(`${bfUrl}/api/query?output=json&relevance=${encodeURIComponent(relevance)}`, { ...bfAuthOpts, headers: { Accept: "application/json" } });
  let result = response.data?.result;
  let val = Array.isArray(result) ? result[0] : result;
  if (val) return parseSiteInfo(val);

  relevance = `((if (name of site of it as lowercase = "actionsite" or name of site of it as lowercase = "master action site") then "master" else if (custom site flag of site of it) then "custom" else "external") & "||" & (if exists display name of site of it then display name of site of it else name of site of it)) of bes fixlets whose (baseline flag of it = true and id of it as string = "${baselineId}")`;
  response = await axios.get(`${bfUrl}/api/query?output=json&relevance=${encodeURIComponent(relevance)}`, { ...bfAuthOpts, headers: { Accept: "application/json" } });
  result = response.data?.result;
  val = Array.isArray(result) ? result[0] : result;
  if (val) return parseSiteInfo(val);

  throw new Error(`Baseline ${baselineId} not found in BigFix.`);
}

function attachBaselineRoutes(app, ctx) {
  const router = express.Router();
  const log = logFactory(ctx.DEBUG_LOG);

  router.get("/risk-sites", async (req, res) => {
    req._logStart = Date.now();
    try {
        const activeUser = getSessionUser(req);
        const activeRole = req.headers['x-user-role'] || getSessionRole(req) || "Default";
        const isMO = await isMasterOperator(req, ctx, activeUser);
        let sites = [];
        if (isMO) {
            const bfAuthOpts = await getBfAuthContext(null, ctx); 
            const bfUrl = (ctx.cfg?.BIGFIX_BASE_URL || "").replace(/\/$/, "");
            const rel = `(name of it & "||" & (if exists display name of it then display name of it as string else name of it as string)) of bes custom sites`;
            const qRes = await axios.get(`${bfUrl}/api/query?output=json&relevance=${encodeURIComponent(rel)}`, { ...bfAuthOpts, headers: { Accept: "application/json" } });
            if (qRes.data?.result) {
                let raw = Array.isArray(qRes.data.result) ? qRes.data.result : [qRes.data.result];
                raw.forEach(r => {
                    const p = String(r).split("||");
                    sites.push({ name: p[0], displayName: p[1] || p[0], type: "Custom" });
                });
            }
            sites.unshift({ name: "ActionSite", displayName: "Master Action Site", type: "Master" });
        } else {
            const roleAssets = await getRoleAssets(req, ctx, activeRole);
            (roleAssets.customSites || []).forEach(s => {
                sites.push({ name: s, displayName: s, type: "Custom" });
            });
        }
        res.json({ ok: true, isMaster: isMO, sites });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  router.post("/resolve-names", async (req, res) => {
      try {
          const { ids } = req.body;
          if (!ids || !ids.length) return res.json({ ok: true, resolved: [] });
          const bfAuthOpts = await getBfAuthContext(req, ctx);
          const bfUrl = (ctx.cfg?.BIGFIX_BASE_URL || "").replace(/\/$/, "");
          const idSet = ids.join(";");
          const rel = `(id of it as string & "||" & name of it & "||" & (if exists display name of site of it then display name of site of it else name of site of it)) of bes fixlets whose (id of it is contained by set of (${idSet}))`;
          const resp = await axios.get(`${bfUrl}/api/query?output=json&relevance=${encodeURIComponent(rel)}`, { ...bfAuthOpts, headers: { Accept: "application/json" } });
          const raw = Array.isArray(resp.data?.result) ? resp.data.result : [resp.data?.result].filter(Boolean);
          const resolved = raw.map(r => {
              const p = String(r).split("||");
              return { id: p[0], name: p[1], site: p[2] };
          });
          res.json({ ok: true, resolved });
      } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  router.get("/:id", async (req, res) => {
    req._logStart = Date.now();
    try {
      const bfId = req.params.id;
      if (bfId === "create") return res.status(400).json({ error: "Invalid ID" });

      const bfAuthOpts = await getBfAuthContext(req, ctx);
      const bfUrl = (ctx.cfg?.BIGFIX_BASE_URL || "").replace(/\/$/, "");
      const loc = await getBaselineLocation(req, ctx, bfId);

      const compRel = `(name of it & "||" & (id of it as string) & "||" & (if exists display name of site of it then display name of site of it else name of site of it) & "||" & (url of site of it | "")) of source fixlets of components of component groups of bes baselines whose (id of it = ${bfId})`;
      const nameRel = `name of bes baselines whose (id of it = ${bfId})`;

      const [respComp, respName] = await Promise.all([
          axios.get(`${bfUrl}/api/query?output=json&relevance=${encodeURIComponent(compRel)}`, { ...bfAuthOpts, headers: { Accept: "application/json" } }),
          axios.get(`${bfUrl}/api/query?output=json&relevance=${encodeURIComponent(nameRel)}`, { ...bfAuthOpts, headers: { Accept: "application/json" } })
      ]);

      const baselineName = respName.data?.result?.[0] || respName.data?.result || "Unknown Baseline";
      const rawResults = Array.isArray(respComp.data?.result) ? respComp.data.result : [respComp.data?.result].filter(Boolean);

      const patches = rawResults.map(r => {
          const p = String(r).split("||");
          return { patch_name: p[0], patch_id: `BIGFIX-${p[1]}`, site_name: p[2] || "Unknown Site", site_url: p[3] || "" };
      });

      // 🚀 FETCH DESCRIPTION USING RELEVANCE
      let description = "";
      try {
          const descRel = `((if (body of it as string contains "Description</h2>" and body of it as string contains "subsection") then (preceding text of first "</div>" of following text of first ">" of following text of first "subsection" of following text of first "Description</h2>" of (body of it as string)) else "No Description Available")) of bes baseline whose (id of it is ${bfId})`;
          const descResp = await axios.get(`${bfUrl}/api/query?output=json&relevance=${encodeURIComponent(descRel)}`, { ...bfAuthOpts, headers: { Accept: "application/json" } });
          if (descResp.data?.result) {
              const result = Array.isArray(descResp.data.result) ? descResp.data.result[0] : descResp.data.result;
              description = String(result).trim();
              if (description === "No Description Available") description = "";
          }
      } catch(e) {
          // Fallback: keep description empty
      }

      res.json({ ok: true, data: [{ bigfix_baseline_id: bfId, baseline_name: baselineName, site_name: loc.siteName, description, patches }] });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.post("/create", async (req, res) => {
    try {
      const { name, description, site, siteType, patches } = req.body;
      if (!patches || !patches.length) return res.status(400).json({ error: "No patches selected" });

      const bfAuthOpts = await getBfAuthContext(req, ctx); 
      const bfUrl = (ctx.cfg?.BIGFIX_BASE_URL || "").replace(/\/$/, "");
      const sitesMap = await getAllSitesMap(bfAuthOpts, bfUrl);

      let componentsXML = "";
      for (const p of patches) {
        const rawId = String(p.patch_id).replace(/^BIGFIX-/i, "").trim();
        const siteURL = p.site_url || sitesMap.get(String(p.site_name || "").toLowerCase().trim());
        if (!siteURL) throw new Error(`Could not resolve site URL for patch ${rawId}`);
        componentsXML += `<BaselineComponent IncludeInRelevance="true" SourceSiteURL="${siteURL}" SourceID="${rawId}" ActionName="Action1" />`;
      }

      const finalDesc = description ? escapeXML(description) : "Created via PatchSetu";

      const xml = `<?xml version="1.0" encoding="UTF-8"?><BES xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="BES.xsd"><Baseline><Title>${escapeXML(name)}</Title><Description>${finalDesc}</Description><Relevance>true</Relevance><BaselineComponentCollection><BaselineComponentGroup>${componentsXML}</BaselineComponentGroup></BaselineComponentCollection></Baseline></BES>`;

      let endpoint = buildBaselineUrl(bfUrl, siteType, site, null, true);
      const response = await axios.post(endpoint, xml, { ...bfAuthOpts, headers: { "Content-Type": "application/xml" } });
      const parsed = await parseStringPromise(response.data);
      let newId = parsed?.BESAPI?.Baseline?.[0]?.ID?.[0];
      res.json({ success: true, bigfix_baseline_id: newId });
    } catch (err) { res.status(500).json({ error: err.response?.data || err.message }); }
  });

  router.put("/:id", async (req, res) => {
    try {
        const bfId = req.params.id; 
        const { name, description, patches } = req.body;
        const loc = await getBaselineLocation(req, ctx, bfId);

        const bfAuthOpts = await getBfAuthContext(req, ctx); 
        const bfUrl = (ctx.cfg?.BIGFIX_BASE_URL || "").replace(/\/$/, "");
        const sitesMap = await getAllSitesMap(bfAuthOpts, bfUrl);

        let componentsXML = "";
        for (const p of patches) {
            const rawId = String(p.patch_id).replace(/^BIGFIX-/i, "").trim();
            const siteURL = p.site_url || sitesMap.get(String(p.site_name || "").toLowerCase().trim());
            if (!siteURL) continue;
            componentsXML += `<BaselineComponent IncludeInRelevance="true" SourceSiteURL="${siteURL}" SourceID="${rawId}" ActionName="Action1" />`;
        }

        const finalDesc = description ? escapeXML(description) : "Updated via PatchSetu";

        const xml = `<?xml version="1.0" encoding="UTF-8"?><BES xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="BES.xsd"><Baseline><Title>${escapeXML(name)}</Title><Description>${finalDesc}</Description><Relevance>true</Relevance><BaselineComponentCollection><BaselineComponentGroup>${componentsXML}</BaselineComponentGroup></BaselineComponentCollection></Baseline></BES>`;

        const endpoint = buildBaselineUrl(bfUrl, loc.siteType, loc.siteName, bfId);
        await axios.put(endpoint, xml, { ...bfAuthOpts, headers: { "Content-Type": "application/xml" } });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.response?.data || err.message }); }
  });

  router.delete("/:id", async (req, res) => {
    try {
        const bfId = req.params.id;
        let siteType = req.query.siteType;
        let siteName = req.query.siteName;
        
        if (!siteType || !siteName || siteType === "undefined") {
            try {
                const loc = await getBaselineLocation(req, ctx, bfId);
                siteType = loc.siteType;
                siteName = loc.siteName;
            } catch (err) {
                // Ignore if already gone
            }
        }

        const bfAuthOpts = await getBfAuthContext(req, ctx);
        const bfUrl = (ctx.cfg?.BIGFIX_BASE_URL || "").replace(/\/$/, "");

        try {
            if (siteType && siteName) {
                await axios.delete(buildBaselineUrl(bfUrl, siteType, siteName, bfId), bfAuthOpts);
            }
        } catch (bfErr) {
            if (bfErr.response && bfErr.response.status === 404) {
                console.log(`[Baseline] Baseline ${bfId} already deleted in BigFix (404).`);
            } else {
                throw bfErr;
            }
        }

        const prismUrl = ctx.prism.PRISM_BASE_URL;
        try {
            const getRes = await prismRequest({ method: "GET", url: `${prismUrl}/api/v1/baselines`, params: { limit: 1000 } });
            const allPrism = getRes.data?.data || [];
            const target = allPrism.find(b => String(b.bigfix_baseline_id) === String(bfId));
            
            if (target && target.id && target.id !== "undefined") {
                await prismRequest({ method: "DELETE", url: `${prismUrl}/api/v1/baselines/${target.id}` });
            }
        } catch (pErr) {
            // Silencing
        }

        res.json({ success: true });
    } catch (err) { 
        res.status(500).json({ error: err.response?.data || err.message }); 
    }
  });

  router.get("/", async (req, res) => {
    try {
      const prismUrl = ctx.prism.PRISM_BASE_URL;
      const page = Number(req.query.page) || 1;
      const limit = Number(req.query.limit) || 50;

      const response = await prismRequest({ method: "GET", url: `${prismUrl}/api/v1/baselines`, params: { page, limit } });
      let prismBaselines = response.data?.data || [];
      const username = getSessionUser(req);
      const activeRole = req.headers['x-user-role'] || getSessionRole(req) || "Default";
      const isMO = await isMasterOperator(req, ctx, username);

      let totalLiveBaselines = 0;

      try {
          let siteFilter = ""; 
          
          if (!isMO) {
              const roleAssets = await getRoleAssets(req, ctx, activeRole);
              const allowedSites = [...(roleAssets.customSites || []), ...(roleAssets.externalSites || [])].map(s => `"${s.toLowerCase()}"`).join("; ");
              if (allowedSites) {
                  siteFilter = ` and (name of site of it as lowercase is contained by set of (${allowedSites}))`;
              } else {
                  siteFilter = ` and (false)`;
              }
          }

          const bfAuthOpts = await getBfAuthContext(null, ctx); 
          const bfUrl = (ctx.cfg?.BIGFIX_BASE_URL || "").replace(/\/$/, "");
          const queryUrl = `${bfUrl}/api/query?output=json&relevance=${encodeURIComponent(`unique values of (id of it as string) of bes fixlets whose (baseline flag of it = true and (not exists globally hidden flag of it or not globally hidden flag of it)${siteFilter})`)}`;
          
          const bfResp = await axios.get(queryUrl, { ...bfAuthOpts, headers: { Accept: "application/json" }, validateStatus: () => true });
          
          if (bfResp.status === 200 && bfResp.data?.result) {
              const allowedIds = new Set(Array.isArray(bfResp.data.result) ? bfResp.data.result : [bfResp.data.result]);
              totalLiveBaselines = allowedIds.size; 
              prismBaselines = prismBaselines.filter(b => allowedIds.has(String(b.bigfix_baseline_id)));
          } else { 
              prismBaselines = []; 
          }
      } catch(e) { 
          prismBaselines = []; 
      }

      const finalData = { ...response.data, data: prismBaselines };
      
      if (finalData.pagination) {
          finalData.pagination.total_records = totalLiveBaselines;
      }

      res.json(finalData);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.use("/api/baselines", router);
}

module.exports = attachBaselineRoutes;