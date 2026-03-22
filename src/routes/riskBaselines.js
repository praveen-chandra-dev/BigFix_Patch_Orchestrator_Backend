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
    const rel = `(name of it & "||" & (if exists display name of it then display name of it as string else name of it as string) & "||" & url of it) of all bes sites`;
    const resp = await axios.get(`${bfUrl}/api/query?output=json&relevance=${encodeURIComponent(rel)}`, { ...bfAuthOpts, headers: { Accept: "application/json" }, validateStatus: () => true });
    const map = new Map();
    const raw = Array.isArray(resp.data?.result) ? resp.data.result : [resp.data?.result].filter(Boolean);
    raw.forEach(r => {
        const parts = String(r).split("||");
        if(parts.length >= 3) {
            map.set(parts[0].trim().toLowerCase(), parts[2].trim());
            map.set(parts[1].trim().toLowerCase(), parts[2].trim());
            const gMatch = parts[2].match(/\/bfgather\/([^/]+)/i);
            if (gMatch) map.set(gMatch[1].toLowerCase(), parts[2].trim());
        }
    });
    map.set("master action site", `${bfUrl}/cgi-bin/bfgather.exe/actionsite`);
    map.set("actionsite", `${bfUrl}/cgi-bin/bfgather.exe/actionsite`);
    allSitesCache = map;
    allSitesCacheTime = Date.now();
    return map;
}

async function getBaselineLocation(req, ctx, baselineId) {
  const bfAuthOpts = await getBfAuthContext(req, ctx);
  const bfUrl = bfAuthOpts.baseURL || (ctx.cfg?.BIGFIX_BASE_URL || "").replace(/\/$/, "");
  const relevance = `((if (name of site of it as lowercase = "actionsite" or name of site of it as lowercase = "master action site") then "master" else if (custom site flag of site of it) then "custom" else "external") & "||" & (if (custom site flag of site of it) then (if (name of site of it as lowercase starts with "customsite_") then (substring (11, length of name of site of it) of name of site of it) else name of site of it) else name of site of it)) of bes fixlets whose (baseline flag of it = true and id of it as string = "${baselineId}")`;
  const response = await axios.get(`${bfUrl}/api/query?output=json&relevance=${encodeURIComponent(relevance)}`, { ...bfAuthOpts, headers: { Accept: "application/json" }});
  const result = response.data?.result;
  const val = Array.isArray(result) ? result[0] : result;
  if (!val) throw new Error(`Baseline ${baselineId} not found in BigFix relevance cache.`);
  const [siteType, rawSiteName] = String(val).split("||");
  return { siteType: siteType.trim(), siteName: rawSiteName.trim() };
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
            const bfUrl = bfAuthOpts.baseURL || (ctx.cfg?.BIGFIX_BASE_URL || "").replace(/\/$/, "");
            const rel = `(name of it & "||" & (if exists display name of it then display name of it as string else name of it as string)) of bes custom sites`;
            const qRes = await axios.get(`${bfUrl}/api/query?output=json&relevance=${encodeURIComponent(rel)}`, { ...bfAuthOpts, headers: { Accept: "application/json" } });
            if (qRes.data?.result) {
                let raw = Array.isArray(qRes.data.result) ? qRes.data.result : [qRes.data.result];
                raw.forEach(r => {
                    const p = String(r).split("||");
                    sites.push({ name: p[0].replace(/^customsite_/i, ""), displayName: p[1] || p[0], type: "Custom" });
                });
            }
        } else {
            const roleAssets = await getRoleAssets(req, ctx, activeRole);
            (roleAssets.customSites || []).forEach(s => {
                sites.push({ name: s.replace(/^customsite_/i, ""), displayName: s, type: "Custom" });
            });
        }
        if (isMO) sites.unshift({ name: "ActionSite", displayName: "Master Action Site", type: "Master" });
        res.json({ ok: true, isMaster: isMO, sites });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  router.post("/resolve-names", async (req, res) => {
      try {
          const { ids } = req.body;
          if (!ids || !ids.length) return res.json({ ok: true, resolved: [] });
          const bfAuthOpts = await getBfAuthContext(req, ctx);
          const bfUrl = bfAuthOpts.baseURL || (ctx.cfg?.BIGFIX_BASE_URL || "").replace(/\/$/, "");
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
      const bfUrl = bfAuthOpts.baseURL || (ctx.cfg?.BIGFIX_BASE_URL || "").replace(/\/$/, "");

      const compRel = `(name of it & "||" & (id of it as string) & "||" & (name of site of it | "") & "||" & (url of site of it | "")) of source fixlets of components of component groups of bes baselines whose (id of it = ${bfId})`;
      const nameRel = `name of bes baselines whose (id of it = ${bfId})`;

      const [respComp, respName] = await Promise.all([
          axios.get(`${bfUrl}/api/query?output=json&relevance=${encodeURIComponent(compRel)}`, { ...bfAuthOpts, headers: { Accept: "application/json" } }),
          axios.get(`${bfUrl}/api/query?output=json&relevance=${encodeURIComponent(nameRel)}`, { ...bfAuthOpts, headers: { Accept: "application/json" } })
      ]);

      const baselineName = respName.data?.result?.[0] || respName.data?.result || "Unknown Baseline";
      const rawResults = Array.isArray(respComp.data?.result) ? respComp.data.result : [respComp.data?.result].filter(Boolean);

      const patches = rawResults.map(r => {
          const p = String(r).split("||");
          let parsedSite = p[2] || "Unknown Site";
          let sUrl = p[3] || "";
          
          if (sUrl.includes("/custom/")) parsedSite = decodeURIComponent(sUrl.split("/custom/")[1]);
          else if (sUrl.toLowerCase().includes("actionsite")) parsedSite = "ActionSite";
          else if (sUrl) parsedSite = sUrl.split("/bfgather/")[1] || parsedSite;

          return { patch_name: p[0], patch_id: `BIGFIX-${p[1]}`, site_name: parsedSite, site_url: sUrl };
      });
      res.json({ ok: true, data: [{ bigfix_baseline_id: bfId, baseline_name: baselineName, patches }] });

    } catch (err) {
      try {
          const bfId = req.params.id;
          const bfAuthOpts = await getBfAuthContext(req, ctx);
          const bfUrl = bfAuthOpts.baseURL || (ctx.cfg?.BIGFIX_BASE_URL || "").replace(/\/$/, "");
          let siteType = req.query.siteType; let siteName = req.query.siteName;
          
          if (!siteType || !siteName || siteType === "undefined") {
             const loc = await getBaselineLocation(req, ctx, bfId); 
             siteType = loc.siteType; siteName = loc.siteName;
          }
          
          let endpoint = buildBaselineUrl(bfUrl, siteType, siteName, bfId);
          let xmlRes;
          try {
              xmlRes = await axios.get(endpoint, { ...bfAuthOpts, headers: { Accept: "application/xml" } });
          } catch (e) {
              if (e.response && e.response.status === 404) {
                  const loc = await getBaselineLocation(req, ctx, bfId);
                  endpoint = buildBaselineUrl(bfUrl, loc.siteType, loc.siteName, bfId);
                  xmlRes = await axios.get(endpoint, { ...bfAuthOpts, headers: { Accept: "application/xml" } });
              } else throw e;
          }

          const xml = String(xmlRes.data);
          const titleMatch = xml.match(/<Title>([\s\S]*?)<\/Title>/i);
          const baselineName = titleMatch ? titleMatch[1] : "Unknown";
          const patches = [];
          const componentRegex = /<BaselineComponent[^>]*>/gi; let match;
          
          while ((match = componentRegex.exec(xml)) !== null) {
              const compTag = match[0];
              const idMatch = compTag.match(/SourceID="(\d+)"/i);
              const urlMatch = compTag.match(/SourceSiteURL="([^"]+)"/i);
              if (idMatch) {
                  let parsedSite = "Unknown Site"; let sUrl = "";
                  if (urlMatch) {
                     sUrl = urlMatch[1];
                     if (sUrl.includes("/custom/")) parsedSite = decodeURIComponent(sUrl.split("/custom/")[1]);
                     else if (sUrl.toLowerCase().includes("actionsite")) parsedSite = "ActionSite";
                     else parsedSite = sUrl.split("/bfgather/")[1] || sUrl;
                  }
                  patches.push({ patch_id: `BIGFIX-${idMatch[1]}`, patch_name: "Unknown Patch", site_name: parsedSite, site_url: sUrl });
              }
          }
          res.json({ data: [{ bigfix_baseline_id: bfId, baseline_name: baselineName, patches }] });
      } catch (fallbackErr) {
          res.status(500).json({ error: "Failed to fetch baseline details", details: fallbackErr.message });
      }
    }
  });

  router.post("/create", async (req, res) => {
    // ... [existing create logic remains unchanged]
  });

  router.put("/:id", async (req, res) => {
    // ... [existing update logic remains unchanged]
  });

  router.delete("/:id", async (req, res) => {
    // ... [existing delete logic remains unchanged]
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

      if (!isMO) {
          try {
              const roleAssets = await getRoleAssets(req, ctx, activeRole);
              const allowedSites = [...(roleAssets.customSites || []), ...(roleAssets.externalSites || [])].map(s => `"${s.toLowerCase()}"`).join("; ");
              
              // 🚀 CRITICAL FIX: Only allowed sites, NO ActionSite bypass!
              let siteFilter = ` whose (false)`;
              if (allowedSites) {
                  siteFilter = ` whose (name of site of it as lowercase is contained by set of (${allowedSites}))`;
              }

              const bfAuthOpts = await getBfAuthContext(null, ctx); 
              const bfUrl = bfAuthOpts.baseURL || (ctx.cfg?.BIGFIX_BASE_URL || "").replace(/\/$/, "");
              const queryUrl = `${bfUrl}/api/query?output=json&relevance=${encodeURIComponent(`unique values of (id of it as string) of bes baselines${siteFilter}`)}`;
              
              const bfResp = await axios.get(queryUrl, { ...bfAuthOpts, headers: { Accept: "application/json" }, validateStatus: () => true });
              
              if (bfResp.status === 200 && bfResp.data?.result) {
                  const allowedIds = new Set(Array.isArray(bfResp.data.result) ? bfResp.data.result : [bfResp.data.result]);
                  prismBaselines = prismBaselines.filter(b => allowedIds.has(String(b.bigfix_baseline_id)));
              } else { prismBaselines = []; }
          } catch(e) { prismBaselines = []; }
      }

      res.json({ ...response.data, data: prismBaselines });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.use("/api/baselines", router);
}

module.exports = attachBaselineRoutes;