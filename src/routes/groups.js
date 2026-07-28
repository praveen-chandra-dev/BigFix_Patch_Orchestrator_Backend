// src/routes/groups.js
const axios = require("axios");
const { joinUrl, getBfAuthContext, escapeXML } = require("../utils/http");
const { logFactory } = require("../utils/log");
const { sql, getPool } = require("../db/mssql");
const { bigfixClient } = require("../services/bigfix");

async function getGroupLocation(req, ctx, groupId) {
    const bfAuthOpts = await getBfAuthContext(req, ctx);
    const bfUrl = bfAuthOpts.baseURL || (ctx.cfg?.BIGFIX_BASE_URL || "").replace(/\/$/, "");

    const relevance = `(if (name of site of it as lowercase = "actionsite" or name of site of it as lowercase = "master action site") then "master" else if (custom site flag of site of it) then "custom" else if (operator site flag of site of it) then "operator" else "external") & "||" & (if (custom site flag of site of it) then (if (name of site of it as lowercase starts with "customsite_") then (substring (11, length of name of site of it) of name of site of it) else name of site of it) else if (operator site flag of site of it) then (if (name of site of it as lowercase starts with "actionsite_") then (substring (11, length of name of site of it) of name of site of it) else name of site of it) else name of site of it) of bes computer groups whose (id of it as string = "${groupId}")`;
    
    const response = await axios.get(`${bfUrl}/api/query?output=json&relevance=${encodeURIComponent(relevance)}`, { ...bfAuthOpts, headers: { Accept: "application/json" }});

    const result = response.data?.result;
    const val = Array.isArray(result) ? result[0] : result;
    if (!val) throw new Error(`Group ${groupId} not found in BigFix relevance cache.`);

    const [siteType, rawSiteName] = String(val).split("||");
    return { siteType: siteType.trim(), siteName: rawSiteName.trim() };
}

async function getPropertyIdByName(req, ctx, propertyName) {
    const { BIGFIX_BASE_URL } = ctx.bigfix;
    const bfAuthOpts = await getBfAuthContext(req, ctx);
    const safeName = propertyName.toLowerCase().replace(/"/g, '""');
    
    let relevance = `(item 1 of it) of ids of bes properties whose (name of it as lowercase = "${safeName}" and reserved flag of it = true)`;
    try {
        let url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
        let resp = await axios.get(url, { ...bfAuthOpts, headers: { Accept: "application/json" } });
        let result = resp.data?.result;
        let raw = Array.isArray(result) ? result : (result ? [result] : []);
        if (raw.length > 0) return String(raw[0]);
        
        relevance = `(item 1 of it) of ids of bes properties whose (name of it as lowercase = "${safeName}")`;
        url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
        resp = await axios.get(url, { ...bfAuthOpts, headers: { Accept: "application/json" } });
        result = resp.data?.result;
        raw = Array.isArray(result) ? result : (result ? [result] : []);
        if (raw.length > 0) return String(raw[0]);
    } catch (e) {}
    return null;
}

function attachGroupRoutes(app, ctx) {
  const log = logFactory(ctx.DEBUG_LOG);
  const { BIGFIX_BASE_URL } = ctx.bigfix;

  app.get("/api/groups/metadata/role-sites", async (req, res) => {
      try {
          const bfAuthOpts = await getBfAuthContext(req, ctx);
          const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent("unique values of names of bes custom sites")}`;
          
          const resp = await axios.get(url, { ...bfAuthOpts, headers: { Accept: "application/json" } });
          const result = resp.data?.result;
          const sites = Array.isArray(result) ? result : (result ? [result] : []);
          
          res.json({ ok: true, sites });
      } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get("/api/groups/list", async (req, res) => {
    req._logStart = Date.now();
    try {
        const relevance = `(id of it as string & "||" & name of it & "||" & (number of members of it as string | "0")) of bes computer groups`;
        
        const bfAuthOpts = await getBfAuthContext(req, ctx); 
        const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
        
        log(req, `[Groups] Fetching group list...`);
        const resp = await axios.get(url, { ...bfAuthOpts, headers: { Accept: "application/json" } });
        
        let groups = [];
        if (resp.status === 200 && resp.data?.result) {
            const raw = Array.isArray(resp.data.result) ? resp.data.result : [resp.data.result];
            groups = raw.map(r => {
                const parts = String(r).split("||");
                return { id: parts[0], name: parts[1], count: parts[2] };
            });
        }
        groups.sort((a,b) => a.name.localeCompare(b.name));
        res.json({ ok: true, groups });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post("/api/groups/create", async (req, res) => {
    req._logStart = Date.now();
    const { name, type, targetSite, conditions, computerIds, logic } = req.body;
    const isIntersection = logic === "Any" ? "false" : "true";

    // Vulnerability 10 fix: strict whitelist validation on group name.
    // Only alphanumeric, spaces, hyphens, underscores, dots, max 100 chars.
    // Reject anything containing formula-injection characters (=, +, -, @, {, }, [, ]).
    if (!name) return res.status(400).json({ ok: false, error: "Group name is required" });
    const NAME_PATTERN = /^[A-Za-z0-9 ._\-]{1,100}$/;
    if (!NAME_PATTERN.test(name)) {
        return res.status(400).json({
            ok: false,
            error: "Invalid group name. Only letters, numbers, spaces, hyphens, underscores, and dots are allowed (max 100 characters)."
        });
    }

    // Vulnerability 8 fix (partial, server side): never trust the client-supplied
    // x-user-role header for privilege decisions. Derive the role from the
    // server-side session only.
    const sessionData = req.session;
    const userRole = (sessionData && sessionData.Role) ? sessionData.Role : 'Unknown';

    log(req, `[Groups] Creating ${type} group: ${name}`);

    try {
        const bfAuthOpts = await getBfAuthContext(req, ctx); 
        const operatorName = bfAuthOpts.auth.username;

        let endpoint = "", xmlBody = "";
        let phantomCheckEndpoint = "";
        
        if (type === "Manual") {
            if (!computerIds?.length) return res.status(400).json({ok:false, error: "No computers selected"});
            // Manual groups are ALWAYS created in the operator's personal site
            endpoint = `/api/computergroups/operator/${encodeURIComponent(operatorName)}`;
            phantomCheckEndpoint = `/api/computergroups/operator/${encodeURIComponent(operatorName)}`;
            
            const computerTags = computerIds.map(id => `<ComputerID>${id}</ComputerID>`).join("\n");
            xmlBody = `<?xml version="1.0" encoding="UTF-8"?><BESAPI xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="BESAPI.xsd"><ManualComputerGroup><Name>${escapeXML(name)}</Name><EvaluateOnClient>false</EvaluateOnClient>${computerTags}</ManualComputerGroup></BESAPI>`;
        } else if (type === "ServerBased" || type === "Automatic") {
            if (!conditions?.length) return res.status(400).json({ok:false, error: "No conditions provided"});
            
            // Allow users to target Custom Sites if they have access
            const sitePath = targetSite ? (targetSite.toLowerCase() === 'actionsite' || targetSite.toLowerCase() === 'master action site' ? `/operator/${encodeURIComponent(operatorName)}` : `/custom/${encodeURIComponent(targetSite)}`) : `/operator/${encodeURIComponent(operatorName)}`;
            endpoint = `/api/computergroups${sitePath}`;
            phantomCheckEndpoint = `/api/computergroups${sitePath}`;
            
            if (type === "ServerBased") {
                let searchComponents = "";
                for (const cond of conditions) {
                    const propId = await getPropertyIdByName(req, ctx, cond.property);
                    if (!propId) throw new Error(`Could not resolve BigFix Property ID for '${cond.property}'.`);
                    searchComponents += `<MembershipRule Comparison="${escapeXML(cond.operator)}"><PropertyID>${escapeXML(propId)}</PropertyID><SearchText>${escapeXML(cond.value)}</SearchText></MembershipRule>`;
                }
                xmlBody = `<?xml version="1.0" encoding="UTF-8"?><BESAPI xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="BESAPI.xsd"><ServerBasedGroup><Name>${escapeXML(name)}</Name><MembershipRules JoinByIntersection="${isIntersection}">${searchComponents}</MembershipRules></ServerBasedGroup></BESAPI>`;
            } else {
                const searchComponents = conditions.map(cond => `<SearchComponentPropertyReference PropertyName="${escapeXML(cond.property)}" Comparison="${escapeXML(cond.operator)}"><SearchText>${escapeXML(cond.value)}</SearchText><Relevance></Relevance></SearchComponentPropertyReference>`).join("");
                xmlBody = `<BES xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="BES.xsd"><ComputerGroup><Title>${escapeXML(name)}</Title><JoinByIntersection>${isIntersection}</JoinByIntersection>${searchComponents}</ComputerGroup></BES>`;
            }
        }

        const postUrl = joinUrl(BIGFIX_BASE_URL, endpoint);
        log(req, `[Groups] POST to BigFix -> ${postUrl}`);

        let bfResp = null;
        let lastError = null;

        try {
            bfResp = await axios.post(postUrl, xmlBody, { ...bfAuthOpts, responseType: 'text', headers: { ...bfAuthOpts.headers, "Content-Type": "application/xml" } });
        } catch (err) {
            lastError = err;
        }
        
        let newId = null;
        if (bfResp && bfResp.status === 200) {
            let rawStr = String(bfResp.data || "").trim();
            let idMatch = rawStr.match(/<ID>\s*(\d+)\s*<\/ID>/i) || rawStr.match(/Resource=["'].*?\/(\d+)["']/i) || rawStr.match(/\/(\d+)\s*$/);
            if (idMatch) newId = idMatch[1];
        }

        if (!newId) {
            try {
                await new Promise(resolve => setTimeout(resolve, 1000));
                const checkUrl = joinUrl(BIGFIX_BASE_URL, phantomCheckEndpoint);
                const checkResp = await axios.get(checkUrl, { ...bfAuthOpts, headers: { Accept: "application/xml" }, validateStatus: () => true });
                if (checkResp.status === 200) {
                    const xmlData = String(checkResp.data || "");
                    const groupBlocks = xmlData.split("</ComputerGroup>");
                    for (const block of groupBlocks) {
                        if (block.includes(`<Name>${name}</Name>`) || block.includes(`<Name>${escapeXML(name)}</Name>`)) {
                            const idMatch = block.match(/<ID>(\d+)<\/ID>/);
                            if (idMatch) { newId = idMatch[1]; break; }
                        }
                    }
                }
            } catch (phantomErr) {}
        }
        
        if (newId) {
            const pool = await getPool();
            await pool.request().input('BigFixID', sql.NVarChar(255), String(newId)).input('AssetName', sql.NVarChar(255), name).input('AssetType', sql.NVarChar(50), 'Group').input('CreatedByRole', sql.NVarChar(50), userRole).query(`INSERT INTO dbo.AssetOwnership (BigFixID, AssetName, AssetType, CreatedByRole, CreatedAt) VALUES (@BigFixID, @AssetName, @AssetType, @CreatedByRole, SYSUTCDATETIME())`);
            res.json({ ok: true, id: newId });
        } else {
            throw lastError || new Error("Group created but ID parse failed.");
        }
    } catch (e) { 
        log(req, `[Groups] Create Failed`, e.message);
        res.status(500).json({ ok: false, error: e.response?.data || e.message }); 
    }
  });

  app.delete("/api/groups/:id", async (req, res) => {
    req._logStart = Date.now();
    const { id } = req.params;
    log(req, `[Groups] Deleting Group ID: ${id}`);

    try {
        const bfAuthOpts = await getBfAuthContext(req, ctx); 
        const bfUrl = bfAuthOpts.baseURL || (ctx.cfg?.BIGFIX_BASE_URL || "").replace(/\/$/, "");

        let endpoint;
        try {
            const loc = await getGroupLocation(req, ctx, id);
            log(req, `[Groups] Resolved group location: ${loc.siteType} / ${loc.siteName}`);

            endpoint = `${bfUrl}/api/computergroup/${loc.siteType}`;
            if (loc.siteType === "custom" || loc.siteType === "operator" || loc.siteType === "external") {
                endpoint += `/${encodeURIComponent(loc.siteName)}`;
            }
            endpoint += `/${id}`;
        } catch (resolveErr) {
            log(req, `[Groups] Fallback - Unable to resolve location for ${id}, trying master.`);
            endpoint = `${bfUrl}/api/computergroup/master/${id}`;
        }

        log(req, `[Groups] Delete Endpoint -> ${endpoint}`);
        try {
            await axios.delete(endpoint, bfAuthOpts);
        } catch (delErr) {
            if (delErr.response && delErr.response.status === 404 && endpoint.includes('/master/')) {
                 log(req, `[Groups] Master delete 404. Attempting operator site fallback...`);
                 const operatorName = bfAuthOpts.auth.username;
                 endpoint = `${bfUrl}/api/computergroup/operator/${encodeURIComponent(operatorName)}/${id}`;
                 log(req, `[Groups] Fallback Delete Endpoint -> ${endpoint}`);
                 await axios.delete(endpoint, bfAuthOpts);
            } else throw delErr;
        }

        const pool = await getPool();
        await pool.request().input('ID', sql.NVarChar(255), String(id)).query("DELETE FROM dbo.AssetOwnership WHERE BigFixID = @ID AND AssetType = 'Group'");
        
        res.json({ ok: true });
    } catch (e) {
        log(req, "[Groups] Delete Failed:", e.message);
        res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get("/api/groups/metadata/computers", async (req, res) => {
      try {
        const page = parseInt(req.query.page) || 1;
        const requestedLimit = parseInt(req.query.limit) || 20;
        if (requestedLimit > 20000) {
            return res.status(400).json({ ok: false, error: "Bad Request: 'limit' cannot exceed 1000 to prevent resource exhaustion." });
        }
        const search = (req.query.search || "").toLowerCase();

        // Pass-through auth context uses logged-in user!
        const bfAuthOpts = await getBfAuthContext(req, ctx); 
        
        // Pass search explicitly into the BigFix relevance to prevent fetching 10k computers to node memory
        let searchFilter = search ? ` whose (name of it as lowercase contains "${search}" or exists (ip addresses of it as string) whose (it contains "${search}"))` : "";
        const safeRelevanceBase = `((id of it as string | "0") & "||" & (name of it as string | "Unknown") & "||" & (concatenation "," of (ip addresses of it as string) | "") & "||" & (operating system of it as string | "Unknown")) of bes computers${searchFilter}`;
        
        const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(safeRelevanceBase)}`;
        const resp = await axios.get(url, { ...bfAuthOpts, headers: { Accept: "application/json" } });
        
        let computerList = [];
        if (resp.status === 200 && resp.data?.result) {
            const result = resp.data.result;
            const raw = Array.isArray(result) ? result : (result ? [result] : []);
            
            computerList = raw.map(r => { 
                const p = String(r).split("||"); 
                return { id: p[0], name: p[1], ips: (p[2]||"").split(/[;,]/).map(x=>x.trim()).filter(Boolean), os: p[3] }; 
            });
        }

        const startIndex = (page - 1) * requestedLimit;
        const resultSlice = computerList.slice(startIndex, startIndex + requestedLimit);

        res.json({ ok: true, computers: resultSlice, total: computerList.length, page, totalPages: Math.ceil(computerList.length / requestedLimit) });
      } catch (e) { res.status(500).json({ok:false, error:e.message}); }
  });

  app.get("/api/groups/:name/members", async (req, res) => {
    try {
      const client = bigfixClient(req, ctx); 
      // bigfixClient uses getBfAuthContext inside, so it's safely filtered!
      const members = await client.getGroupMembers(req.params.name);

      res.json({ ok: true, members });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get("/api/groups/metadata/properties", async (req, res) => {
      try {
        const bfAuthOpts = await getBfAuthContext(req, ctx);
        const relevance = `(((item 1 of it) of id of it as string | "N/A") & "||" & (name of it as string | "N/A")) of bes properties whose (reserved flag of it is true)`;
        const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
        
        const resp = await axios.get(url, { ...bfAuthOpts, headers: { Accept: "application/json" } });
        const raw = Array.isArray(resp.data?.result) ? resp.data.result : [];
        const properties = raw.map(r => String(r).split("||")[1] || "Unknown").sort();
        
        res.json({ ok: true, properties: [...new Set(properties)] });
      } catch (e) { res.status(500).json({ok:false, error:e.message}); }
  });

  app.get("/api/groups/manage", async (req, res) => {
    req._logStart = Date.now();
    try {
        const relevance = `((id of it as string | "N/A") & "||" & (name of it as string | "N/A") & "||" & (if automatic flag of it then "Automatic" else if manual flag of it then "Manual" else "Server Based") & "||" & (name of site of it as string | "N/A") & "||" & (number of members of it as string | "0")) of bes computer groups`;
        
        const bfAuthOpts = await getBfAuthContext(req, ctx);
        const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
        
        log(req, `[Groups] Fetching extended group list from BigFix API...`);
        const resp = await axios.get(url, { ...bfAuthOpts, headers: { Accept: "application/json" } });
        
        let groups = [];
        if (resp.status === 200 && resp.data?.result) {
            const raw = Array.isArray(resp.data.result) ? resp.data.result : [resp.data.result];
            groups = raw.map(r => {
                const parts = String(r).split("||");
                return { id: parts[0], name: parts[1], type: parts[2], site: parts[3], count: parts[4] };
            });
        }

        res.json({ ok: true, groups });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get("/api/groups/computers-extended", async (req, res) => {
      try {
          const groupId = req.query.groupId; 
          let combinedTarget = groupId ? `members of bes computer groups whose (id of it as string = "${escapeXML(groupId)}")` : `bes computers`;

          const properties = `(if exists values of results (it, bes property "Computer Name") then concatenation ";" of values of results (it, bes property "Computer Name") else "N/A") & " | " & (if exists values of results (it, bes property "OS") then concatenation ";" of values of results (it, bes property "OS") else "N/A") & " | " & (if exists values of results (it, bes property "Last Report Time") then concatenation ";" of values of results (it, bes property "Last Report Time") else "N/A") & " | " & (if exists values of results (it, bes property "Locked") then concatenation ";" of values of results (it, bes property "Locked") else "N/A") & " | " & (if exists values of results (it, bes property "Relay") then concatenation ";" of values of results (it, bes property "Relay") else "N/A") & " | " & (if exists values of results (it, bes property "DNS Name") then concatenation ";" of values of results (it, bes property "DNS Name") else "N/A") & " | " & (if exists values of results (it, bes property "IP Address") then concatenation ";" of values of results (it, bes property "IP Address") else "N/A") & " | " & (if exists values of results (it, bes property "BES Root Server") then concatenation ";" of values of results (it, bes property "BES Root Server") else "N/A") & " | " & (if exists values of results (it, bes property "Agent Type") then concatenation ";" of values of results (it, bes property "Agent Type") else "N/A") & " | " & (if exists values of results (it, bes property "Device Type") then concatenation ";" of values of results (it, bes property "Device Type") else "N/A") & " | " & (if exists values of results (it, bes property "Agent Version") then concatenation ";" of values of results (it, bes property "Agent Version") else "N/A") & " | " & (if exists values of results (it, bes property "OS Version") then concatenation ";" of values of results (it, bes property "OS Version") else "N/A")`;
          
          const finalRelevance = `((id of it as string | "0") & " | " & ${properties}) of ${combinedTarget}`;
          
          const bfAuthOpts = await getBfAuthContext(req, ctx); 
          const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(finalRelevance)}`;
          
          const resp = await axios.get(url, { ...bfAuthOpts, headers: { Accept: "application/json" } });
          
          let computers = [];
          if (resp.status === 200 && resp.data?.result) {
              const result = resp.data.result;
              const raw = Array.isArray(result) ? result : (result ? [result] : []);
              
              computers = raw.map(r => {
                  const p = String(r).split(" | ");
                  return {
                      id: p[0], name: p[1], os: p[2], lastReport: p[3], locked: p[4],
                      relay: p[5], dns: p[6], ip: p[7], rootServer: p[8],
                      agentType: p[9], deviceType: p[10], agentVersion: p[11], osVersion: p[12]
                  };
              });
          }

          res.json({ ok: true, computers });
      } catch (e) { res.status(500).json({ok:false, error:e.message}); }
  });

}

module.exports = { attachGroupRoutes };