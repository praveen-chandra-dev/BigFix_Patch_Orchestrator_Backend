// bigfix-backend/src/routes/baseline.js
const axios = require("axios");
const { joinUrl } = require("../utils/http");
const { logFactory } = require("../utils/log");
const { sql, getPool } = require("../db/mssql");

// --- Helper: Verify if Baseline IDs exist in BigFix (Lazy Sync) ---
async function verifyBigFixBaselines(bigfixCtx, ids) {
  if (!ids || ids.length === 0) return [];
  const { BIGFIX_BASE_URL, BIGFIX_USER, BIGFIX_PASS, httpsAgent } = bigfixCtx;
  
  const setStr = ids.join("; ");
  // Relevance: returns the subset of IDs that actually exist in BigFix
  const relevance = `unique values of ids of bes baselines whose (id of it is contained by set of (${setStr}))`;
  
  try {
    const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
    const resp = await axios.get(url, {
      httpsAgent,
      auth: { username: BIGFIX_USER, password: BIGFIX_PASS },
      headers: { Accept: "application/json" }
    });
    const result = resp.data?.result;
    const foundIds = [];
    if (Array.isArray(result)) {
      result.forEach(r => foundIds.push(String(r)));
    } else if (result) {
      foundIds.push(String(result));
    }
    return foundIds;
  } catch (e) {
    console.warn("[BaselineSync] Failed to verify IDs:", e.message);
    return ids.map(String); // Fail safe: assume valid if network error
  }
}

function attachBaselineRoutes(app, ctx) {
  const log = logFactory(ctx.DEBUG_LOG);
  const { BIGFIX_BASE_URL, BIGFIX_USER, BIGFIX_PASS, httpsAgent } = ctx.bigfix;

  const authOptions = {
    httpsAgent,
    auth: { username: BIGFIX_USER, password: BIGFIX_PASS },
    headers: { Accept: "application/json" },
  };

  // --- 1. LIST BASELINES (RBAC + Lazy Sync with Safety Window) ---
  app.get("/api/baselines/list", async (req, res) => {
      try {
        const userRole = req.headers['x-user-role'] || 'Admin';
        const pool = await getPool();
        
        // FIX: Added CreatedAt to SELECT
        let query = "SELECT BigFixID, AssetName, CreatedByRole, CreatedAt FROM dbo.AssetOwnership WHERE AssetType='Baseline'";
        if (userRole !== 'Admin') {
            query += " AND CreatedByRole = @Role";
        }

        const reqSql = pool.request();
        if (userRole !== 'Admin') reqSql.input('Role', sql.NVarChar(50), userRole);
        
        const dbRes = await reqSql.query(query);
        let dbRows = dbRes.recordset;

        // Lazy Sync: Cleanup
        if (dbRows.length > 0) {
            const now = new Date();
            const SAFE_WINDOW_MS = 10 * 60 * 1000; // 10 Minutes safety window

            // Only verify items older than 10 minutes
            // This prevents deleting newly created baselines that BigFix hasn't indexed yet
            const candidates = dbRows.filter(r => {
                const created = new Date(r.CreatedAt);
                return (now - created) > SAFE_WINDOW_MS;
            });

            if (candidates.length > 0) {
                const localIdsToCheck = candidates.map(r => r.BigFixID);
                const realIds = await verifyBigFixBaselines(ctx.bigfix, localIdsToCheck);
                
                // Zombies = Checked IDs that were NOT found
                const zombies = localIdsToCheck.filter(id => !realIds.includes(String(id)));

                if (zombies.length > 0) {
                    log(req, `[BaselineSync] Removing ${zombies.length} zombie baselines.`);
                    for (const zId of zombies) {
                        await pool.request().input('ZID', sql.NVarChar(255), String(zId))
                            .query("DELETE FROM dbo.AssetOwnership WHERE BigFixID = @ZID AND AssetType='Baseline'");
                    }
                    // Remove zombies from the response list
                    dbRows = dbRows.filter(r => !zombies.includes(r.BigFixID));
                }
            }
        }

        res.json({ ok: true, baselines: dbRows.map(r => ({ id: r.BigFixID, name: r.AssetName })) });

      } catch (e) {
        log(req, "List baselines error:", e.message);
        res.status(500).json({ ok: false, error: e.message });
      }
  });

  // --- 2. GET Source Sites (Filtered by Role) ---
  app.get("/api/baseline/sites", async (req, res) => {
    try {
      const userRole = req.headers['x-user-role'] || 'Admin';
      let filter = "";

      if (userRole === 'Windows') {
          filter = ` AND (display name of it as lowercase contains "windows")`;
      } 
      else if (userRole === 'Linux') {
          filter = ` AND (display name of it as lowercase does not contain "windows")`;
      }

      const relevance =
        `display names of bes sites whose(` +
        `(display name of it contains "Patch" or display name of it contains "Updates")` +
        filter + 
        `)`;

      const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
      const resp = await axios.get(url, authOptions);
      
      let results = resp.data?.result || [];
      if (!Array.isArray(results)) results = [results];
      results.sort((a, b) => String(a).localeCompare(String(b)));

      res.json({ ok: true, sites: results });
    } catch (e) {
      log(req, "Error fetching sites:", e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // --- 3. GET Custom Sites (Filtered) ---
  app.get("/api/baseline/custom-sites", async (req, res) => {
    try {
      const relevance = `names of bes custom sites`;
      const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
      const resp = await axios.get(url, authOptions);

      let results = resp.data?.result || [];
      if (!Array.isArray(results)) results = [results];

      results.sort();
      res.json({ ok: true, sites: results });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ... (Patches Route - unchanged) ...
  app.get("/api/baseline/patches", async (req, res) => {
    const { site } = req.query;
    if (!site) return res.status(400).json({ ok: false, error: "Site parameter required" });
    try {
      const safeSite = site.replace(/"/g, '%22');
      const relevance = `((id of it as string | "N/A") & " | " & (name of it | "N/A") & " | " & (display name of site of it as string | "N/A") & " | " & (source severity of it | "N/A")) of bes fixlets whose(display name of site of it is "${safeSite}" and applicable computer count of it > 0 and fixlet flag of it and exists default action of it)`;      
      const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
      const resp = await axios.get(url, authOptions);
      let rawResults = resp.data?.result || [];
      if (!Array.isArray(rawResults)) rawResults = [rawResults];
      const patches = rawResults.map((str) => {
        const parts = String(str).split(" | ");
        return { id: parts[0] || "N/A", name: parts[1] || "N/A", site: parts[2] || safeSite, severity: parts[3] || "Unspecified" };
      });
      res.json({ ok: true, count: patches.length, patches });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // --- 4. CREATE BASELINE ---
  app.post("/api/baseline/create", async (req, res) => {
    const { baselineName, targetSite, patchKeys } = req.body;
    const userRole = req.headers['x-user-role'] || 'Admin'; 

    if (!baselineName || !targetSite || !Array.isArray(patchKeys) || patchKeys.length === 0) return res.status(400).json({ ok: false, error: "Missing required fields." });
    try {
      const siteToIds = new Map();
      for (const key of patchKeys) {
        const [idRaw, siteRaw] = String(key).split("||");
        const id = idRaw && idRaw.trim();
        const siteName = siteRaw && siteRaw.trim();
        if (!id || !siteName) continue;
        if (!siteToIds.has(siteName)) siteToIds.set(siteName, new Set());
        siteToIds.get(siteName).add(id);
      }
      if (siteToIds.size === 0) throw new Error("No valid (ID, Site) keys provided.");
      
      const patchMap = new Map();
      for (const [siteName, idsSet] of siteToIds.entries()) {
        const ids = Array.from(idsSet);
        const idsStr = ids.join(";");
        const safeSite = siteName.replace(/"/g, '%22');
        const relevance = `("ID: " & (id of it as string | "N/A") & " || SourceURL: " & (url of site of it as string | "N/A") & " || Site: " & (display name of site of it | "N/A")) of bes fixlets whose (display name of site of it = "${safeSite}" and id of it is contained by set of (${idsStr}))`;
        const qUrl = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
        const qResp = await axios.get(qUrl, authOptions);
        let queryResults = qResp.data?.result || [];
        if (!Array.isArray(queryResults)) queryResults = [queryResults];
        queryResults.forEach((row) => {
          const parts = String(row).split(" || ");
          if (parts.length >= 3) {
            const idPart = parts[0].replace("ID: ", "").trim();
            const urlPart = parts[1].replace("SourceURL: ", "").trim();
            const sitePart = parts[2].replace("Site: ", "").trim();
            if (idPart && urlPart && sitePart) {
              const key = `${idPart}||${sitePart}`;
              patchMap.set(key, urlPart);
            }
          }
        });
      }

      let componentsXml = "";
      for (const key of patchKeys) {
        const [idRaw, siteRaw] = String(key).split("||");
        const idStr = idRaw && idRaw.trim();
        const siteName = siteRaw && siteRaw.trim();
        if (!idStr || !siteName) continue;
        const mapKey = `${idStr}||${siteName}`;
        const sourceUrl = patchMap.get(mapKey);
        if (sourceUrl) {
          componentsXml += `<BaselineComponent IncludeInRelevance="true" SourceSiteURL="${sourceUrl}" SourceID="${idStr}" ActionName="Action1" />`;
        }
      }
      if (!componentsXml) throw new Error("No valid components generated.");

      const xmlEscape = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const finalXml = `<?xml version="1.0" encoding="UTF-8"?><BES xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="BES.xsd"><Baseline><Title>${xmlEscape(baselineName)}</Title><Description /><Relevance>true</Relevance><BaselineComponentCollection><BaselineComponentGroup>${componentsXml}</BaselineComponentGroup></BaselineComponentCollection></Baseline></BES>`;
      
      const encodedSite = encodeURIComponent(targetSite);
      const postUrl = joinUrl(BIGFIX_BASE_URL, `/api/baselines/custom/${encodedSite}`);
      
      log(req, `Creating baseline "${baselineName}" in site "${targetSite}"...`);
      const postResp = await axios.post(postUrl, finalXml, { ...authOptions, headers: { "Content-Type": "application/xml" } });
      const xmlResp = String(postResp.data || "");
      let baselineId = null;
      const idMatch = xmlResp.match(/<ID>(\d+)<\/ID>/);
      if (idMatch) baselineId = idMatch[1];
      
      // --- Save Ownership to DB ---
      if (baselineId) {
         try {
            const pool = await getPool();
            await pool.request()
              .input('BigFixID', sql.NVarChar(255), String(baselineId))
              .input('AssetName', sql.NVarChar(255), baselineName)
              .input('AssetType', sql.NVarChar(50), 'Baseline')
              .input('CreatedByRole', sql.NVarChar(50), userRole)
              .query(`INSERT INTO dbo.AssetOwnership (BigFixID, AssetName, AssetType, CreatedByRole, CreatedAt) VALUES (@BigFixID, @AssetName, @AssetType, @CreatedByRole, SYSUTCDATETIME())`);
         } catch (dbErr) {
             log(req, "Warning: Failed to save baseline ownership to DB:", dbErr.message);
         }
      }
      
      log(req, "Baseline Created ID:", baselineId);
      res.json({ ok: true, message: "Baseline created successfully", baselineId, baselineName });
    } catch (e) {
      const bfError = e.response?.data ? String(e.response.data) : e.message;
      log(req, "Failed to create baseline. BigFix Error:", bfError);
      res.status(500).json({ ok: false, error: bfError });
    }
  });
  
  // --- VALIDATE (Unchanged) ---
  app.post("/api/baseline/validate", async (req, res) => {
    const { baselineName } = req.body;
    if (!baselineName) return res.status(400).json({ ok: false, error: "baselineName required" });

    try {
      const safeName = baselineName.replace(/"/g, '\\"');
      const relevance = `(creation time of it as string & "||" & modification time of it as string) of bes baselines whose (name of it = "${safeName}")`;

      const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
      const resp = await axios.get(url, authOptions);

      if (resp.status < 200 || resp.status >= 300) {
         throw new Error(`BigFix query failed: ${resp.status}`);
      }

      const result = resp.data?.result;
      const val = Array.isArray(result) ? result[0] : result;
      let warning = null;

      if (val && typeof val === 'string' && val.includes("||")) {
          const [cTimeStr, mTimeStr] = val.split("||");
          const cDate = new Date(cTimeStr);
          const mDate = new Date(mTimeStr);
          if (mDate > cDate) {
             warning = `Baseline was modified on ${mTimeStr} (Created: ${cTimeStr})`;
          }
      }
      res.json({ ok: true, modified: !!warning, warning });
    } catch (e) {
      log(req, "Baseline validation failed:", e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });
}

module.exports = { attachBaselineRoutes };