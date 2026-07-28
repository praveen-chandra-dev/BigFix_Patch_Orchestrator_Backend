// src/routes/baseline.js
const axios = require("axios");
const { joinUrl, getBfAuthContext } = require("../utils/http");
const { logFactory } = require("../utils/log");

function attachBaselineRoutes(app, ctx) {
  const log = logFactory(ctx.DEBUG_LOG);
  const { BIGFIX_BASE_URL } = ctx.bigfix;

  app.get("/api/baseline/sites", async (req, res) => {
    try {
        const bfAuthOpts = await getBfAuthContext(req, ctx); 
        const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent("unique values of names of all bes sites")}`;
        
        const resp = await axios.get(url, { ...bfAuthOpts, headers: { Accept: "application/json" } });
        const result = resp.data?.result;
        const sites = Array.isArray(result) ? result : (result ? [result] : []);
        
        res.json({ ok: true, sites: [...new Set(sites)] });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get("/api/baseline/custom-sites", async (req, res) => {
    try {
        const bfAuthOpts = await getBfAuthContext(req, ctx); 
        const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent("unique values of names of bes custom sites")}`;
        
        const resp = await axios.get(url, { ...bfAuthOpts, headers: { Accept: "application/json" } });
        const result = resp.data?.result;
        const sites = Array.isArray(result) ? result : (result ? [result] : []);
        
        res.json({ ok: true, sites: [...new Set(sites)] });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get(["/api/baselines", "/api/baselines/list"], async (req, res) => {
    try {
        // We removed the manual Node.js RBAC filtering. BigFix will filter this natively using the user's auth token.
        const relevance = `(id of it as string & "||" & name of it & "||" & (if (name of site of it as lowercase = "actionsite" or name of site of it as lowercase = "master action site") then "master" else if (custom site flag of site of it) then "custom" else "external") & "||" & (if (custom site flag of site of it) then (if (name of site of it as lowercase starts with "customsite_") then (substring (11, length of name of site of it) of name of site of it) else name of site of it) else name of site of it) & "||" & (concatenation ";" of (ids of source fixlets of components of component groups of it as string) | "") & "||" & (applicable computer count of it as string | "0") & "||" &  (number of components of component groups of it as string | "0")) of bes baselines`;
        
        const bfAuthOpts = await getBfAuthContext(req, ctx);
        const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
        
        const resp = await axios.get(url, { ...bfAuthOpts, headers: { Accept: "application/json" } });
        let baselines = [];
        
        if (resp.status === 200 && resp.data?.result) {
            const raw = Array.isArray(resp.data.result) ? resp.data.result : [resp.data.result];
            baselines = raw.map(r => {
                const parts = String(r).split("||");
                const patches = (parts[4] || "").split(";").filter(Boolean).map(id => `BIGFIX-${id.trim()}`);
                
                return { 
                    id: parts[0], 
                    name: parts[1], 
                    baseline_name: parts[1], 
                    siteType: parts[2], 
                    siteName: parts[3],
                    patches: patches,
                    patch_count: patches.length,
                    computer_count: parseInt(parts[5] || "0", 10),
                    component_count: parseInt(parts[6] || "0", 10)
                };
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
      
      const bfAuthOpts = await getBfAuthContext(req, ctx); 
      const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
      
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

  app.post("/api/baseline/validate", async (req, res) => {
    const { baselineName } = req.body;
    if (!baselineName) return res.status(400).json({ ok: false, error: "baselineName required" });

    try {
      const safeName = baselineName.replace(/"/g, '\\"');
      const relevance = `(creation time of it as string & "||" & modification time of it as string) of bes baselines whose (name of it = "${safeName}")`;
      
      const bfAuthOpts = await getBfAuthContext(req, ctx); 
      const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
      
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