// src/routes/riskBaselines.js
const express = require("express");
const axios = require("axios");
const { parseStringPromise } = require("xml2js");
const { prismRequest } = require("../services/prism");
const { getBfAuthContext, joinUrl } = require("../utils/http");
const { isMasterOperator, getRoleAssets } = require("../services/bigfix");

const siteUrlCache = new Map();

function escapeXML(str = "") {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function getSessionUser(req) {
    if (req && req.cookies && req.cookies.auth_session) {
        try { return JSON.parse(req.cookies.auth_session).username; } catch(e){}
    }
    return req.headers['x-active-user'] || "unknown";
}

function getSessionRole(req) {
    if (req && req.cookies && req.cookies.auth_session) {
        try { return JSON.parse(req.cookies.auth_session).role; } catch(e){}
    }
    return null;
}

/* =========================================
   Resolve BigFix Site URL
========================================= */
async function resolveSiteURL(req, ctx, siteName) {
  if (siteUrlCache.has(siteName)) return siteUrlCache.get(siteName);

  const bfAuthOpts = await getBfAuthContext(req, ctx);
  const bfUrl = bfAuthOpts.baseURL || (ctx.cfg?.BIGFIX_BASE_URL || "").replace(/\/$/, "");

  const relevance = `(url of it) of bes sites whose (display name of it = "${siteName}" or name of it = "${siteName}")`;
  const encoded = encodeURIComponent(relevance);

  const response = await axios.get(`${bfUrl}/api/query?relevance=${encoded}`, {
    ...bfAuthOpts,
    headers: { Accept: "application/xml" }
  });

  const result = await parseStringPromise(response.data);
  const answerObj = result?.BESAPI?.Query?.[0]?.Result?.[0]?.Answer?.[0];
  const siteURL = typeof answerObj === "object" ? answerObj._ : answerObj;

  if (!siteURL) throw new Error(`Unable to resolve site URL for: ${siteName}`);

  const trimmed = siteURL.trim();
  siteUrlCache.set(siteName, trimmed);
  return trimmed;
}

/* =========================================
   Helper: Get baseline location info
========================================= */
async function getBaselineLocation(req, ctx, baselineId) {
  const bfAuthOpts = await getBfAuthContext(req, ctx);
  const bfUrl = bfAuthOpts.baseURL || (ctx.cfg?.BIGFIX_BASE_URL || "").replace(/\/$/, "");

  const relevance = `((if (name of site of it as lowercase contains "action") then "master" else "custom") & "||" & (if (name of site of it as lowercase starts with "customsite_") then (substring (11, length of name of site of it) of name of site of it) else name of site of it)) of bes fixlets whose (baseline flag of it = true and id of it as string = "${baselineId}")`;
  
  const response = await axios.get(`${bfUrl}/api/query?output=json&relevance=${encodeURIComponent(relevance)}`, {
    ...bfAuthOpts,
    headers: { Accept: "application/json" }
  });

  const result = response.data?.result;
  const val = Array.isArray(result) ? result[0] : result;

  if (!val) throw new Error(`Baseline ${baselineId} not found in BigFix`);

  const [siteType, rawSiteName] = String(val).split("||");
  return { siteType: siteType.trim(), siteName: rawSiteName.trim() };
}

function attachBaselineRoutes(app, ctx) {
  const router = express.Router();

  /* ============================
     FETCH USER'S AUTHORIZED SITES
  ============================ */
  router.get("/risk-sites", async (req, res) => {
    try {
        const activeUser = getSessionUser(req);
        const activeRole = req.headers['x-user-role'] || getSessionRole(req) || "Default";
        const isMO = await isMasterOperator(req, ctx, activeUser);

        let customSites = [];

        if (isMO) {
            const bfAuthOpts = await getBfAuthContext(req, ctx);
            const bfUrl = bfAuthOpts.baseURL || (ctx.cfg?.BIGFIX_BASE_URL || "").replace(/\/$/, "");
            const rel = `unique values of names of bes custom sites`;
            const qRes = await axios.get(`${bfUrl}/api/query?output=json&relevance=${encodeURIComponent(rel)}`, { 
                ...bfAuthOpts, headers: { Accept: "application/json" } 
            });
            if (qRes.data?.result) {
                customSites = Array.isArray(qRes.data.result) ? qRes.data.result : [qRes.data.result];
            }
        } else {
            const roleAssets = await getRoleAssets(req, ctx, activeRole);
            customSites = roleAssets.customSites || [];
        }
        
        const sites = customSites.map(s => ({ name: s, displayName: s, type: "Custom" }));
        
        if (isMO) {
            sites.unshift({ name: "ActionSite", displayName: "Master Action Site", type: "Master" });
        }
        
        res.json({ ok: true, isMaster: isMO, sites });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
  });

  /* ============================
     CREATE BASELINE
  ============================ */
  router.post("/create", async (req, res) => {
    try {
      const { name, site, siteType, patches } = req.body;

      if (!name) return res.status(400).json({ error: "Missing baseline name" });
      if (!siteType) return res.status(400).json({ error: "Missing siteType" });
      if (!patches || !Array.isArray(patches)) return res.status(400).json({ error: "Invalid patches data" });

      const bfAuthOpts = await getBfAuthContext(req, ctx);
      const bfUrl = bfAuthOpts.baseURL || (ctx.cfg?.BIGFIX_BASE_URL || "").replace(/\/$/, "");

      let baselineComponentsXML = "";
      let prismPatches = [];

      for (const p of patches) {
        const rawId = String(p.patch_id).replace(/^BIGFIX-/i, "").trim();
        if (!/^\d+$/.test(rawId)) throw new Error(`Invalid Fixlet ID: ${rawId}`);
        
        let siteURL = p.site_name ? await resolveSiteURL(req, ctx, p.site_name) : null;
        if (!siteURL) {
            const qUrl = `${bfUrl}/api/query?output=json&relevance=${encodeURIComponent(`url of site of bes fixlets whose (id of it as string = "${rawId}" and fixlet flag of it)`)}`;
            const qRes = await axios.get(qUrl, bfAuthOpts);
            siteURL = Array.isArray(qRes.data?.result) ? qRes.data.result[0] : qRes.data?.result;
        }
        if (!siteURL) throw new Error(`Could not resolve site URL for patch ${rawId}`);

        baselineComponentsXML += `\n<BaselineComponent IncludeInRelevance="true" SourceSiteURL="${siteURL}" SourceID="${rawId}" ActionName="Action1" />`;
        
        prismPatches.push({
            patch_id: `BIGFIX-${rawId}`,
            site_name: p.site_name || site || "Unknown"
        });
      }

      const baselineXML = `<?xml version="1.0" encoding="UTF-8"?>
<BES xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="BES.xsd">
  <Baseline>
    <Title>${escapeXML(name)}</Title>
    <Description>Created via PatchSetu API</Description>
    <Relevance>true</Relevance>
    <BaselineComponentCollection>
      <BaselineComponentGroup>${baselineComponentsXML}
      </BaselineComponentGroup>
    </BaselineComponentCollection>
  </Baseline>
</BES>`;

      let endpoint = siteType.toLowerCase() === "master" ? `${bfUrl}/api/baselines/master` : `${bfUrl}/api/baselines/custom/${encodeURIComponent(site)}`;

      const response = await axios.post(endpoint, baselineXML, {
        ...bfAuthOpts,
        headers: { "Content-Type": "application/xml" }
      });

      const parsed = await parseStringPromise(response.data);
      let bigfixBaselineId = Number(parsed?.BESAPI?.Baseline?.[0]?.ID?.[0]);

      if (!bigfixBaselineId || Number.isNaN(bigfixBaselineId)) {
        throw new Error("Unable to extract BigFix baseline ID");
      }

      try {
          const prismUrl = ctx.prism.PRISM_BASE_URL;
          await prismRequest({
            method: "POST",
            url: `${prismUrl}/api/v1/baselines`,
            data: {
              baseline_name: name,
              site_name: site || "Master Action Site",
              bigfix_baseline_id: bigfixBaselineId,
              patches: prismPatches, 
              status: "created"
            },
          });
      } catch (prismErr) {
          console.warn("Prism sync failed during create:", prismErr.response?.data || prismErr.message);
      }

      res.json({ success: true, message: "Baseline created successfully", bigfix_baseline_id: bigfixBaselineId });
    } catch (err) {
      console.error("Baseline creation error:", err.response?.data || err.message);
      res.status(500).json({ error: "Baseline creation failed", details: err.response?.data || err.message });
    }
  });

  /* ============================
     UPDATE BASELINE (PUT)
  ============================ */
  router.put("/:id", async (req, res) => {
    try {
        const bfId = req.params.id; 
        const { name, patches } = req.body;

        if (!name) return res.status(400).json({ error: "Missing baseline name" });
        if (!patches || !Array.isArray(patches)) return res.status(400).json({ error: "Invalid patches data" });

        let siteType = req.query.siteType;
        let siteName = req.query.siteName;

        if (!siteType || !siteName || siteType === "undefined") {
            const loc = await getBaselineLocation(req, ctx, bfId);
            siteType = loc.siteType;
            siteName = loc.siteName;
        }

        const bfAuthOpts = await getBfAuthContext(req, ctx);
        const bfUrl = bfAuthOpts.baseURL || (ctx.cfg?.BIGFIX_BASE_URL || "").replace(/\/$/, "");

        let endpoint = `${bfUrl}/api/baseline/${siteType}`;
        if (siteType === "custom") endpoint += `/${encodeURIComponent(siteName)}`;
        endpoint += `/${bfId}`;

        const xmlRes = await axios.get(endpoint, { ...bfAuthOpts, headers: { Accept: "application/xml" } });
        let xml = String(xmlRes.data);

        xml = xml.replace(/<Title>[\s\S]*?<\/Title>/i, `<Title>${escapeXML(name)}</Title>`);

        let baselineComponentsXML = "";
        let prismPatches = [];

        for (const p of patches) {
            const rawId = String(p.patch_id).replace(/^BIGFIX-/i, "").trim();
            let siteURL = p.site_name ? await resolveSiteURL(req, ctx, p.site_name) : null;
            
            if (!siteURL) {
                const qUrl = `${bfUrl}/api/query?output=json&relevance=${encodeURIComponent(`url of site of bes fixlets whose (id of it as string = "${rawId}" and fixlet flag of it)`)}`;
                const qRes = await axios.get(qUrl, bfAuthOpts);
                siteURL = Array.isArray(qRes.data?.result) ? qRes.data.result[0] : qRes.data?.result;
            }
            if (!siteURL) throw new Error(`Could not resolve site URL for patch ${rawId}`);

            baselineComponentsXML += `\n<BaselineComponent IncludeInRelevance="true" SourceSiteURL="${siteURL}" SourceID="${rawId}" ActionName="Action1" />`;
            prismPatches.push({ patch_id: `BIGFIX-${rawId}`, site_name: p.site_name || siteName || "Unknown" });
        }

        xml = xml.replace(/<BaselineComponentCollection>[\s\S]*?<\/BaselineComponentCollection>/i, `<BaselineComponentCollection>\n<BaselineComponentGroup>${baselineComponentsXML}\n</BaselineComponentGroup>\n</BaselineComponentCollection>`);

        await axios.put(endpoint, xml, { ...bfAuthOpts, headers: { "Content-Type": "application/xml" } });

        try {
            const prismUrl = ctx.prism.PRISM_BASE_URL;
            const prismGet = await prismRequest({ method: "GET", url: `${prismUrl}/api/v1/baselines`, params: { limit: 1000 } });
            const list = prismGet.data?.data || [];
            const found = list.find(b => String(b.bigfix_baseline_id) === String(bfId));
            
            if (found) {
                await prismRequest({
                    method: "PUT",
                    url: `${prismUrl}/api/v1/baselines/${found.id}`,
                    data: { baseline_name: name, patches: prismPatches, status: "updated" }
                });
            }
        } catch (prismErr) { }

        res.json({ success: true, message: "Baseline updated successfully" });
    } catch(err) {
        console.error("PUT Baseline Error:", err.message);
        res.status(500).json({ error: "Failed to update baseline", details: err.response?.data || err.message });
    }
  });

  /* ============================
     DELETE BASELINE
  ============================ */
  router.delete("/:id", async (req, res) => {
    try {
        const bfId = req.params.id;
        
        let siteType = req.query.siteType;
        let siteName = req.query.siteName;

        if (!siteType || !siteName || siteType === "undefined") {
            const loc = await getBaselineLocation(req, ctx, bfId);
            siteType = loc.siteType;
            siteName = loc.siteName;
        }

        const bfAuthOpts = await getBfAuthContext(req, ctx);
        const bfUrl = bfAuthOpts.baseURL || (ctx.cfg?.BIGFIX_BASE_URL || "").replace(/\/$/, "");

        let endpoint = `${bfUrl}/api/baseline/${siteType}`;
        if (siteType === "custom") endpoint += `/${encodeURIComponent(siteName)}`;
        endpoint += `/${bfId}`;
        
        await axios.delete(endpoint, bfAuthOpts);

        try {
            const prismUrl = ctx.prism.PRISM_BASE_URL;
            const prismGet = await prismRequest({ method: "GET", url: `${prismUrl}/api/v1/baselines`, params: { limit: 1000 } });
            const list = prismGet.data?.data || [];
            const found = list.find(b => String(b.bigfix_baseline_id) === String(bfId));
            if (found) {
                await prismRequest({ method: "DELETE", url: `${prismUrl}/api/v1/baselines/${found.id}` });
            }
        } catch(prismErr) {}

        res.json({ success: true });
    } catch (err) {
        console.error("DELETE Baseline Error:", err.message);
        const detailMsg = err.response?.data ? String(err.response.data) : err.message;
        res.status(500).json({ error: "Failed to delete baseline", details: detailMsg });
    }
  });

  /* ============================
     GET SINGLE BASELINE (Parse XML Directly + Lookup Fixlet Names)
  ============================ */
  router.get("/:id", async (req, res) => {
    try {
      const bfId = req.params.id;
      if (bfId === "create") return res.status(400).json({ error: "Invalid ID" });

      const bfAuthOpts = await getBfAuthContext(req, ctx);
      const bfUrl = bfAuthOpts.baseURL || (ctx.cfg?.BIGFIX_BASE_URL || "").replace(/\/$/, "");

      let siteType = req.query.siteType;
      let siteName = req.query.siteName;

      if (!siteType || !siteName || siteType === "undefined") {
         const loc = await getBaselineLocation(req, ctx, bfId);
         siteType = loc.siteType;
         siteName = loc.siteName;
      }

      let endpoint = `${bfUrl}/api/baseline/${siteType}`;
      if (siteType === "custom") endpoint += `/${encodeURIComponent(siteName)}`;
      endpoint += `/${bfId}`;

      // FETCH XML AND PARSE IT MANUALLY
      const xmlRes = await axios.get(endpoint, { ...bfAuthOpts, headers: { Accept: "application/xml" } });
      const xml = String(xmlRes.data);

      const titleMatch = xml.match(/<Title>([\s\S]*?)<\/Title>/i);
      const baselineName = titleMatch ? titleMatch[1] : "Unknown";

      const patchIds = [];
      const componentRegex = /<BaselineComponent[^>]*>/gi;
      let match;
      while ((match = componentRegex.exec(xml)) !== null) {
          const compTag = match[0];
          const idMatch = compTag.match(/SourceID="(\d+)"/i);
          if (idMatch) {
              patchIds.push(idMatch[1]);
          }
      }

      let patches = [];
      if (patchIds.length > 0) {
          const idSet = patchIds.join(";");
          // Use 'bes fixlets' to map IDs to Names natively
          const fixletRel = `((id of it as string) & "||" & (name of it | "Unknown Patch") & "||" & (if exists display name of site of it then display name of site of it else name of site of it | "Unknown Site")) of bes fixlets whose (id of it is contained by set of (${idSet}))`;
          
          try {
              const fixletRes = await axios.get(`${bfUrl}/api/query?output=json&relevance=${encodeURIComponent(fixletRel)}`, { ...bfAuthOpts, headers: { Accept: "application/json" } });
              const fResult = fixletRes.data?.result;
              const fRaw = Array.isArray(fResult) ? fResult : (fResult ? [fResult] : []);
              
              const fixletMap = {};
              fRaw.forEach(r => {
                  const parts = String(r).split("||");
                  fixletMap[parts[0]] = { name: parts[1], site: parts[2] };
              });

              patches = patchIds.map(id => ({
                  patch_id: `BIGFIX-${id}`,
                  patch_name: fixletMap[id]?.name || "Unknown Patch",
                  site_name: fixletMap[id]?.site || "Unknown Site"
              }));
          } catch(e) {
              console.warn("Failed to map fixlet IDs to names:", e.message);
              patches = patchIds.map(id => ({
                  patch_id: `BIGFIX-${id}`,
                  patch_name: "Unknown Patch",
                  site_name: "Unknown Site"
              }));
          }
      }

      res.json({
        data: [{
          bigfix_baseline_id: bfId,
          baseline_name: baselineName,
          patches: patches 
        }]
      });
    } catch (err) {
      console.error("GET Baseline Details Error:", err.message);
      res.status(500).json({ error: "Failed to fetch baseline details", details: err.message });
    }
  });

  /* ============================
     GET ALL BASELINES
  ============================ */
  router.get("/", async (req, res) => {
    try {
      const prismUrl = ctx.prism.PRISM_BASE_URL;
      const page = Number(req.query.page) || 1;
      const limit = Number(req.query.limit) || 50;

      const response = await prismRequest({
        method: "GET",
        url: `${prismUrl}/api/v1/baselines`,
        params: { page, limit },
      });

      let prismBaselines = response.data?.data || [];

      let username = null;
      if (req.cookies && req.cookies.auth_session) {
          try { username = JSON.parse(req.cookies.auth_session).username; } catch(e){}
      }
      if (!username) username = req.headers['x-active-user'];

      const isMO = await isMasterOperator(req, ctx, username);

      if (!isMO) {
          try {
              const bfAuthOpts = await getBfAuthContext(req, ctx);
              const bfUrl = bfAuthOpts.baseURL || (ctx.cfg?.BIGFIX_BASE_URL || "").replace(/\/$/, "");
              
              const queryUrl = `${bfUrl}/api/query?output=json&relevance=${encodeURIComponent("unique values of (id of it as string) of bes baselines")}`;
              const bfResp = await axios.get(queryUrl, { ...bfAuthOpts, headers: { Accept: "application/json" }, validateStatus: () => true });
              
              if (bfResp.status === 200 && bfResp.data?.result) {
                  const allowedIds = new Set(Array.isArray(bfResp.data.result) ? bfResp.data.result : [bfResp.data.result]);
                  prismBaselines = prismBaselines.filter(b => allowedIds.has(String(b.bigfix_baseline_id)));
              } else {
                  prismBaselines = [];
              }
          } catch(e) {
              prismBaselines = []; 
          }
      }

      res.json({
          ...response.data,
          data: prismBaselines
      });

    } catch (err) {
      res.status(500).json({ error: "Failed to fetch baselines", details: err.message });
    }
  });

  app.use("/api/baselines", router);
}

module.exports = attachBaselineRoutes;