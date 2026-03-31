// src/routes/groups.js
const axios = require("axios");
const { joinUrl, getBfAuthContext, getSessionUser, getSessionRole, escapeXML } = require("../utils/http");
const { logFactory } = require("../utils/log");
const { sql, getPool } = require("../db/mssql");
const { bigfixClient, getRoleAssets, isMasterOperator } = require("../services/bigfix");

const CACHE_TTL = 5 * 60 * 1000; 

let globalComputersCache = { data: [], lastFetch: 0 };
let roleSitesCache = {};
let propertiesCache = { data: [], lastFetch: 0 };
let manageGroupsCache = {};

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
          const operatorName = getSessionUser(req);
          const activeRole = req.headers['x-user-role'] || getSessionRole(req) || "Default";
          
          const cacheKey = `${operatorName}_${activeRole}`;
          const now = Date.now();
          if (roleSitesCache[cacheKey] && (now - roleSitesCache[cacheKey].lastFetch < CACHE_TTL)) {
              return res.json({ ok: true, sites: roleSitesCache[cacheKey].data });
          }

          const isMO = await isMasterOperator(req, ctx, operatorName);
          let sites = [];

          if (isMO) {
              const bfAuthOpts = await getBfAuthContext(null, ctx); // Master Creds
              const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent("unique values of names of bes custom sites")}`;
              const resp = await axios.get(url, { ...bfAuthOpts, headers: { Accept: "application/json" } });
              const result = resp.data?.result;
              sites = Array.isArray(result) ? result : (result ? [result] : []);
          } else if (activeRole && activeRole !== "Admin" && activeRole !== "No Role Assigned") {
              const roleAssets = await getRoleAssets(req, ctx, activeRole);
              sites = roleAssets.customSites || [];
          }
          
          roleSitesCache[cacheKey] = { data: sites, lastFetch: now };
          res.json({ ok: true, sites });
      } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get("/api/groups/list", async (req, res) => {
    req._logStart = Date.now();
    try {
        const activeRole = req.headers['x-user-role'] || getSessionRole(req);
        const activeUser = getSessionUser(req);
        const isMO = await isMasterOperator(req, ctx, activeUser);

        let siteFilter = "";
        let memberCountRelevance = `number of members of it`; 

        if (!isMO) {
            if (!activeRole || activeRole === "No Role Assigned") {
                siteFilter = ` whose (false)`; 
                memberCountRelevance = `0`;
            } else if (activeRole !== "Admin") {
                const roleAssets = await getRoleAssets(req, ctx, activeRole);
                const allowedSites = [...(roleAssets.customSites || []), ...(roleAssets.externalSites || [])].map(s => `"${s.toLowerCase()}"`).join("; ");
                if (allowedSites) siteFilter = ` whose (name of site of it as lowercase is contained by set of (${allowedSites}) or name of site of it as lowercase = "actionsite" or name of site of it as lowercase = "master action site")`;
                else siteFilter = ` whose (name of site of it as lowercase = "actionsite" or name of site of it as lowercase = "master action site")`;

                // 🚀 Safest BigFix Syntax to count valid computers without throwing Nonexistent Object Errors
                if (roleAssets.found && roleAssets.compNames && roleAssets.compNames.length > 0) {
                    const names = roleAssets.compNames.map(n => `"${n.toLowerCase()}"`).join(";");
                    memberCountRelevance = `number of members whose (exists name whose (it as lowercase is contained by set of (${names})) of it) of it`;
                } else {
                    memberCountRelevance = `0`;
                }
            }
        }

        const relevance = `(id of it as string & "||" & name of it & "||" & (${memberCountRelevance} as string | "0")) of bes computer groups${siteFilter}`;
        
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

    const userRole = req.headers['x-user-role'] || 'Admin';
    if (!name) return res.status(400).json({ ok: false, error: "Group name is required" });
    
    log(req, `[Groups] Creating ${type} group: ${name}`);

    try {
        const bfAuthOpts = await getBfAuthContext(req, ctx); 
        const operatorName = bfAuthOpts.auth.username;

        let endpoint = "", xmlBody = "";
        let phantomCheckEndpoint = "";
        
        if (type === "Manual") {
            if (!computerIds?.length) return res.status(400).json({ok:false, error: "No computers selected"});
            const isMO = await isMasterOperator(req, ctx, operatorName);
            endpoint = isMO ? "/api/computergroups/master" : `/api/computergroups/operator/${encodeURIComponent(operatorName)}`;
            phantomCheckEndpoint = isMO ? "/api/computergroups/master" : `/api/computergroups/operator/${encodeURIComponent(operatorName)}`;
            
            const computerTags = computerIds.map(id => `<ComputerID>${id}</ComputerID>`).join("\n");
            xmlBody = `<?xml version="1.0" encoding="UTF-8"?><BESAPI xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="BESAPI.xsd"><ManualComputerGroup><Name>${escapeXML(name)}</Name><EvaluateOnClient>false</EvaluateOnClient>${computerTags}</ManualComputerGroup></BESAPI>`;
        } else if (type === "ServerBased") {
            if (!conditions?.length) return res.status(400).json({ok:false, error: "No conditions provided"});
            const sitePath = targetSite ? (targetSite.toLowerCase() === 'actionsite' || targetSite.toLowerCase() === 'master action site' ? '/master' : `/custom/${encodeURIComponent(targetSite)}`) : "/master";
            endpoint = `/api/computergroups${sitePath}`;
            phantomCheckEndpoint = `/api/computergroups${sitePath}`;
            
            let searchComponents = "";
            for (const cond of conditions) {
                const propId = await getPropertyIdByName(req, ctx, cond.property);
                if (!propId) throw new Error(`Could not resolve BigFix Property ID for '${cond.property}'.`);
                searchComponents += `<MembershipRule Comparison="${escapeXML(cond.operator)}"><PropertyID>${escapeXML(propId)}</PropertyID><SearchText>${escapeXML(cond.value)}</SearchText></MembershipRule>`;
            }
            xmlBody = `<?xml version="1.0" encoding="UTF-8"?><BESAPI xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="BESAPI.xsd"><ServerBasedGroup><Name>${escapeXML(name)}</Name><MembershipRules JoinByIntersection="${isIntersection}">${searchComponents}</MembershipRules></ServerBasedGroup></BESAPI>`;
        } else {
            if (!conditions?.length) return res.status(400).json({ok:false, error: "No conditions provided"});
            const sitePath = targetSite ? (targetSite.toLowerCase() === 'actionsite' || targetSite.toLowerCase() === 'master action site' ? '/master' : `/custom/${encodeURIComponent(targetSite)}`) : "/master";
            endpoint = `/api/computergroups${sitePath}`;
            phantomCheckEndpoint = `/api/computergroups${sitePath}`;
            
            const searchComponents = conditions.map(cond => `<SearchComponentPropertyReference PropertyName="${escapeXML(cond.property)}" Comparison="${escapeXML(cond.operator)}"><SearchText>${escapeXML(cond.value)}</SearchText><Relevance></Relevance></SearchComponentPropertyReference>`).join("");
            xmlBody = `<BES xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="BES.xsd"><ComputerGroup><Title>${escapeXML(name)}</Title><JoinByIntersection>${isIntersection}</JoinByIntersection>${searchComponents}</ComputerGroup></BES>`;
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
        const activeRole = req.headers['x-user-role'] || getSessionRole(req);
        const activeUser = getSessionUser(req);
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const search = (req.query.search || "").toLowerCase();
        const forceRefresh = req.query.refresh === 'true';
        const now = Date.now();

        const isMO = await isMasterOperator(req, ctx, activeUser);

        if (forceRefresh || (now - globalComputersCache.lastFetch > CACHE_TTL) || !globalComputersCache.data.length) {
            const masterAuthOpts = await getBfAuthContext(null, ctx); 
            const safeRelevanceBase = `((id of it as string | "0") & "||" & (name of it as string | "Unknown") & "||" & (concatenation "," of (ip addresses of it as string) | "") & "||" & (operating system of it as string | "Unknown")) of bes computers`;
            
            const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(safeRelevanceBase)}`;
            const resp = await axios.get(url, { ...masterAuthOpts, headers: { Accept: "application/json" } });
            
            if (resp.status === 200 && resp.data?.result) {
                const result = resp.data.result;
                const raw = Array.isArray(result) ? result : (result ? [result] : []);
                
                globalComputersCache.data = raw.map(r => { 
                    const p = String(r).split("||"); 
                    return { id: p[0], name: p[1], ips: (p[2]||"").split(/[;,]/).map(x=>x.trim()).filter(Boolean), os: p[3] }; 
                });
                
                if (globalComputersCache.data.length > 0) globalComputersCache.lastFetch = now;
            }
        }
        
        let computerList = globalComputersCache.data || [];

        if (!isMO) {
            if (!activeRole || activeRole === "No Role Assigned") {
                computerList = []; 
            } else if (activeRole !== "Admin") {
                const roleAssets = await getRoleAssets(req, ctx, activeRole);
                if (roleAssets.found) {
                    const allowedSet = new Set(roleAssets.compNames.map(c => c.toLowerCase()));
                    computerList = computerList.filter(c => allowedSet.has(c.name.toLowerCase()));
                } else {
                    computerList = []; 
                }
            }
        }

        if (search) {
            computerList = computerList.filter(c => c.name.toLowerCase().includes(search) || c.ips.some(ip => ip.includes(search)) || (c.os && c.os.toLowerCase().includes(search)));
        }

        const startIndex = (page - 1) * limit;
        const resultSlice = computerList.slice(startIndex, startIndex + limit);

        res.json({ ok: true, computers: resultSlice, total: computerList.length, page, totalPages: Math.ceil(computerList.length / limit) });
      } catch (e) { res.status(500).json({ok:false, error:e.message}); }
  });

  app.get("/api/groups/:name/members", async (req, res) => {
    try {
      const activeRole = req.headers['x-user-role'] || getSessionRole(req);
      const activeUser = getSessionUser(req);
      const isMO = await isMasterOperator(req, ctx, activeUser);
      const client = bigfixClient(req, ctx); 
      let members = await client.getGroupMembers(req.params.name);

      if (!isMO) {
          if (!activeRole || activeRole === "No Role Assigned") {
              members = []; 
          } else if (activeRole !== "Admin") {
              const roleAssets = await getRoleAssets(req, ctx, activeRole);
              if (roleAssets.found && roleAssets.compNames.length > 0) {
                  members = members.filter(m => roleAssets.compNames.includes(m.name.toLowerCase()));
              } else {
                  members = [];
              }
          }
      }

      res.json({ ok: true, members });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get("/api/groups/metadata/properties", async (req, res) => {
      try {
        const now = Date.now();
        if (now - propertiesCache.lastFetch < 3600000 && propertiesCache.data.length > 0) {
            return res.json({ ok: true, properties: propertiesCache.data });
        }

        const bfAuthOpts = await getBfAuthContext(null, ctx);
        const relevance = `(((item 1 of it) of id of it as string | "N/A") & "||" & (name of it as string | "N/A")) of bes properties whose (reserved flag of it is true)`;
        const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
        const resp = await axios.get(url, bfAuthOpts);
        const raw = Array.isArray(resp.data?.result) ? resp.data.result : [];
        const properties = raw.map(r => String(r).split("||")[1] || "Unknown").sort();
        
        propertiesCache.data = [...new Set(properties)];
        propertiesCache.lastFetch = now;

        res.json({ ok: true, properties: propertiesCache.data });
      } catch (e) { res.status(500).json({ok:false, error:e.message}); }
  });

  app.get("/api/groups/manage", async (req, res) => {
    req._logStart = Date.now();
    try {
        const activeRole = req.headers['x-user-role'] || getSessionRole(req);
        const activeUser = getSessionUser(req);
        const isMO = await isMasterOperator(req, ctx, activeUser);
        const forceRefresh = req.query.refresh === 'true';

        // 1. CACHE CHECK: Serve instantly if we fetched within the last 5 minutes
        const cacheKey = `${activeUser}_${activeRole}`;
        const now = Date.now();
        if (!forceRefresh && manageGroupsCache[cacheKey] && (now - manageGroupsCache[cacheKey].lastFetch < 5 * 60 * 1000)) {
            log(req, `[Groups] Serving Manage Groups from cache for ${activeUser}`);
            return res.json({ ok: true, groups: manageGroupsCache[cacheKey].data });
        }

        let siteFilter = "";
        let memberCountRelevance = `number of members of it`; 

        if (!isMO) {
            if (!activeRole || activeRole === "No Role Assigned") {
                siteFilter = ` whose (false)`; 
                memberCountRelevance = `0`;
            } else if (activeRole !== "Admin") {
                const roleAssets = await getRoleAssets(req, ctx, activeRole);
                const allowedSites = [...(roleAssets.customSites || []), ...(roleAssets.externalSites || [])].map(s => `"${s.toLowerCase()}"`).join("; ");
                if (allowedSites) siteFilter = ` whose (name of site of it as lowercase is contained by set of (${allowedSites}) or name of site of it as lowercase = "actionsite" or name of site of it as lowercase = "master action site")`;
                else siteFilter = ` whose (name of site of it as lowercase = "actionsite" or name of site of it as lowercase = "master action site")`;

                // 🚀 Safest BigFix Syntax to count valid computers without throwing Nonexistent Object Errors
                if (roleAssets.found && roleAssets.compNames && roleAssets.compNames.length > 0) {
                    const names = roleAssets.compNames.map(n => `"${n.toLowerCase()}"`).join(";");
                    memberCountRelevance = `number of members whose (exists name whose (it as lowercase is contained by set of (${names})) of it) of it`;
                } else {
                    memberCountRelevance = `0`;
                }
            }
        }

        const relevance = `((id of it as string | "N/A") & "||" & (name of it as string | "N/A") & "||" & (if automatic flag of it then "Automatic" else if manual flag of it then "Manual" else "Server Based") & "||" & (name of site of it as string | "N/A") & "||" & (${memberCountRelevance} as string | "0")) of bes computer groups${siteFilter}`;
        
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

        // 2. SAVE TO CACHE
        manageGroupsCache[cacheKey] = { data: groups, lastFetch: now };

        res.json({ ok: true, groups });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get("/api/groups/computers-extended", async (req, res) => {
      try {
          const activeRole = req.headers['x-user-role'] || getSessionRole(req);
          const activeUser = getSessionUser(req);
          const groupId = req.query.groupId; 

          const isMO = await isMasterOperator(req, ctx, activeUser);

          // 1. Determine Target
          let target = "bes computers";
          if (groupId) {
              target = `members of bes computer groups whose (id of it as string = "${escapeXML(groupId)}")`;
          }

          // 2. Apply RBAC Constraints
          let compFilter = "";
          if (!isMO) {
              if (!activeRole || activeRole === "No Role Assigned") {
                  return res.json({ ok: true, computers: [] }); 
              } else if (activeRole !== "Admin") {
                  const roleAssets = await getRoleAssets(req, ctx, activeRole);
                  if (roleAssets.found && roleAssets.compNames.length > 0) {
                      const names = roleAssets.compNames.map(n => `"${n.toLowerCase()}"`).join(";");
                      compFilter = ` whose (exists name whose (it as lowercase is contained by set of (${names})) of it)`;
                  } else {
                      return res.json({ ok: true, computers: [] }); 
                  }
              }
          }

          const combinedTarget = groupId ? `(${target})${compFilter}` : `bes computers${compFilter}`;

          // 3. Properties Relevance
          const properties = `(if exists values of results (it, bes property "Computer Name") then concatenation ";" of values of results (it, bes property "Computer Name") else "N/A") & " | " & (if exists values of results (it, bes property "OS") then concatenation ";" of values of results (it, bes property "OS") else "N/A") & " | " & (if exists values of results (it, bes property "Last Report Time") then concatenation ";" of values of results (it, bes property "Last Report Time") else "N/A") & " | " & (if exists values of results (it, bes property "Locked") then concatenation ";" of values of results (it, bes property "Locked") else "N/A") & " | " & (if exists values of results (it, bes property "Relay") then concatenation ";" of values of results (it, bes property "Relay") else "N/A") & " | " & (if exists values of results (it, bes property "DNS Name") then concatenation ";" of values of results (it, bes property "DNS Name") else "N/A") & " | " & (if exists values of results (it, bes property "IP Address") then concatenation ";" of values of results (it, bes property "IP Address") else "N/A") & " | " & (if exists values of results (it, bes property "BES Root Server") then concatenation ";" of values of results (it, bes property "BES Root Server") else "N/A") & " | " & (if exists values of results (it, bes property "Agent Type") then concatenation ";" of values of results (it, bes property "Agent Type") else "N/A") & " | " & (if exists values of results (it, bes property "Device Type") then concatenation ";" of values of results (it, bes property "Device Type") else "N/A") & " | " & (if exists values of results (it, bes property "Agent Version") then concatenation ";" of values of results (it, bes property "Agent Version") else "N/A") & " | " & (if exists values of results (it, bes property "OS Version") then concatenation ";" of values of results (it, bes property "OS Version") else "N/A")`;
          
          const finalRelevance = `((id of it as string | "0") & " | " & ${properties}) of ${combinedTarget}`;
          
          const bfAuthOpts = await getBfAuthContext(null, ctx); 
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