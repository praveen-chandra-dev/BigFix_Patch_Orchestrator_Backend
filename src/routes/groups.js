// src/routes/groups.js
const axios = require("axios");
const { joinUrl, getBfAuthContext } = require("../utils/http");
const { logFactory } = require("../utils/log");
const { sql, getPool } = require("../db/mssql");
const { bigfixClient, getRoleAssets, isMasterOperator } = require("../services/bigfix");

const CACHE_TTL = 60 * 1000; 

let userComputersCache = {};
let roleSitesCache = {};
let propertiesCache = { data: [], lastFetch: 0 };

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

const xmlEscape = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

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

async function verifyBigFixIds(req, ctx, ids) {
  if (!ids || ids.length === 0) return [];
  const { BIGFIX_BASE_URL } = ctx.bigfix;
  const setStr = ids.join("; ");
  const relevance = `unique values of ids of bes computer groups whose (id of it is contained by set of (${setStr}))`;
  let foundIds = [];
  try {
      const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
      const bfAuthOpts = await getBfAuthContext(req, ctx);
      const resp = await axios.get(url, { ...bfAuthOpts, headers: { Accept: "application/json" } });    
      const result = resp.data?.result;
      const raw = Array.isArray(result) ? result : (result ? [result] : []);
      raw.forEach(r => foundIds.push(String(r)));
  } catch (e) {}
  
  const missing = ids.filter(id => !foundIds.includes(String(id)));
  if (missing.length > 0) {
    try {
        const restUrl = joinUrl(BIGFIX_BASE_URL, "/api/computergroups/master");
        const bfAuthOpts = await getBfAuthContext(req, ctx);
        const restResp = await axios.get(restUrl, { ...bfAuthOpts, headers: { Accept: "application/xml" }, validateStatus: (s) => s < 500 });
        if (restResp.status === 200) {
            const xml = String(restResp.data || "");
            const regex = /<ID>(\d+)<\/ID>/gi;
            let match;
            while ((match = regex.exec(xml)) !== null) {
                if (missing.includes(match[1])) foundIds.push(match[1]);
            }
        }
    } catch (e) {}
  }
  return foundIds;
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
              const bfAuthOpts = await getBfAuthContext(req, ctx);
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

        const relevance = `(id of it as string & "||" & name of it) of bes computer groups${siteFilter}`;
        const bfAuthOpts = await getBfAuthContext(req, ctx);
        const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
        
        const resp = await axios.get(url, { ...bfAuthOpts, headers: { Accept: "application/json" } });
        
        let groups = [];
        if (resp.status === 200 && resp.data?.result) {
            const raw = Array.isArray(resp.data.result) ? resp.data.result : [resp.data.result];
            groups = raw.map(r => {
                const parts = String(r).split("||");
                return { id: parts[0], name: parts[1] };
            });
        }
        groups.sort((a,b) => a.name.localeCompare(b.name));
        res.json({ ok: true, groups });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post("/api/groups/create", async (req, res) => {
    const { name, type, targetSite, conditions, computerIds } = req.body;
    const userRole = req.headers['x-user-role'] || 'Admin';
    if (!name) return res.status(400).json({ ok: false, error: "Group name is required" });
    
    try {
        const bfAuthOpts = await getBfAuthContext(req, ctx);
        const operatorName = bfAuthOpts.auth.username;

        let endpoint = "", xmlBody = "";
        let phantomCheckEndpoint = "";
        
        if (type === "Manual") {
            if (!computerIds?.length) return res.status(400).json({ok:false, error: "No computers selected"});
            const isMO = await isMasterOperator(req, ctx, operatorName);
            endpoint = isMO ? "/api/computergroup/master" : `/api/computergroup/operator/${encodeURIComponent(operatorName)}`;
            phantomCheckEndpoint = isMO ? "/api/computergroups/master" : `/api/computergroups/operator/${encodeURIComponent(operatorName)}`;
            
            const computerTags = computerIds.map(id => `<ComputerID>${id}</ComputerID>`).join("\n");
            xmlBody = `<?xml version="1.0" encoding="UTF-8"?><BESAPI xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="BESAPI.xsd"><ManualComputerGroup><Name>${xmlEscape(name)}</Name><EvaluateOnClient>false</EvaluateOnClient>${computerTags}</ManualComputerGroup></BESAPI>`;
        } else if (type === "ServerBased") {
            if (!conditions?.length) return res.status(400).json({ok:false, error: "No conditions provided"});
            const sitePath = targetSite ? `/custom/${encodeURIComponent(targetSite)}` : "/master";
            endpoint = `/api/computergroup${sitePath}`;
            phantomCheckEndpoint = `/api/computergroups${sitePath}`;
            
            let searchComponents = "";
            for (const cond of conditions) {
                const propId = await getPropertyIdByName(req, ctx, cond.property);
                if (!propId) throw new Error(`Could not resolve BigFix Property ID for '${cond.property}'.`);
                searchComponents += `<MembershipRule Comparison="${xmlEscape(cond.operator)}"><PropertyID>${xmlEscape(propId)}</PropertyID><SearchText>${xmlEscape(cond.value)}</SearchText></MembershipRule>`;
            }
            xmlBody = `<?xml version="1.0" encoding="UTF-8"?><BESAPI xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="BESAPI.xsd"><ServerBasedGroup><Name>${xmlEscape(name)}</Name><MembershipRules JoinByIntersection="true">${searchComponents}</MembershipRules></ServerBasedGroup></BESAPI>`;
        } else {
            if (!conditions?.length) return res.status(400).json({ok:false, error: "No conditions provided"});
            const sitePath = targetSite ? `/custom/${encodeURIComponent(targetSite)}` : "/master";
            endpoint = `/api/computergroup${sitePath}`;
            phantomCheckEndpoint = `/api/computergroups${sitePath}`;
            
            const searchComponents = conditions.map(cond => `<SearchComponentPropertyReference PropertyName="${xmlEscape(cond.property)}" Comparison="${xmlEscape(cond.operator)}"><SearchText>${xmlEscape(cond.value)}</SearchText><Relevance></Relevance></SearchComponentPropertyReference>`).join("");
            xmlBody = `<BES xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="BES.xsd"><ComputerGroup><Title>${xmlEscape(name)}</Title><JoinByIntersection>true</JoinByIntersection>${searchComponents}</ComputerGroup></BES>`;
        }

        const postUrl = joinUrl(BIGFIX_BASE_URL, endpoint);
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
                        if (block.includes(`<Name>${name}</Name>`) || block.includes(`<Name>${xmlEscape(name)}</Name>`)) {
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
    } catch (e) { res.status(500).json({ ok: false, error: e.response?.data || e.message }); }
  });

  app.delete("/api/groups/:id", async (req, res) => {
    const { id } = req.params;
    try {
      const bfAuthOpts = await getBfAuthContext(req, ctx);
      try { 
          await axios.delete(joinUrl(BIGFIX_BASE_URL, `/api/computergroup/master/${id}`), bfAuthOpts); 
      } catch (e) { 
          try {
             const operatorName = bfAuthOpts.auth.username;
             await axios.delete(joinUrl(BIGFIX_BASE_URL, `/api/computergroup/operator/${encodeURIComponent(operatorName)}/${id}`), bfAuthOpts);
          } catch(err) {
             return res.status(403).json({ ok: false, error: "Permission Denied by BigFix API" });
          }
      }
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get("/api/groups/metadata/computers", async (req, res) => {
      try {
        const activeRole = req.headers['x-user-role'] || getSessionRole(req);
        const activeUser = getSessionUser(req);
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const search = (req.query.search || "").toLowerCase();
        const forceRefresh = req.query.refresh === 'true';

        let computerList = [];
        const bfAuthOpts = await getBfAuthContext(req, ctx);
        const isMO = await isMasterOperator(req, ctx, activeUser);

        let allowedComputers = null;
        if (!isMO && activeRole && activeRole !== "Admin" && activeRole !== "No Role Assigned") {
            const roleAssets = await getRoleAssets(req, ctx, activeRole);
            if (roleAssets.found) {
                allowedComputers = roleAssets.compNames;
            } else if (roleAssets.found && roleAssets.compNames.length === 0) {
                return res.json({ ok: true, computers: [], total: 0, page: 1, totalPages: 0 });
            }
        }

        const cacheKey = `${activeUser}_${activeRole || 'Default'}`;
        if (!userComputersCache[cacheKey]) userComputersCache[cacheKey] = { data: [], lastFetch: 0 };
        const cache = userComputersCache[cacheKey];
        const now = Date.now();

        if (forceRefresh || (now - cache.lastFetch > CACHE_TTL) || !cache.data.length) {
            // CRITICAL FIX: Safe Native IP string extraction prevents BigFix Parsing Crashes
            const safeRelevanceBase = `((id of it as string | "0") & "||" & (name of it as string | "Unknown") & "||" & (concatenation "," of (ip addresses of it as string) | "") & "||" & (operating system of it as string | "Unknown")) of bes computers`;
            
            const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(safeRelevanceBase)}`;
            const resp = await axios.get(url, { ...bfAuthOpts, headers: { Accept: "application/json" } });
            
            if (resp.status === 200 && resp.data?.result) {
                const result = resp.data.result;
                const raw = Array.isArray(result) ? result : (result ? [result] : []);
                
                cache.data = raw.map(r => { 
                    const p = String(r).split("||"); 
                    return { id: p[0], name: p[1], ips: (p[2]||"").split(/[;,]/).map(x=>x.trim()).filter(Boolean), os: p[3] }; 
                });
                
                if (cache.data.length > 0) cache.lastFetch = now;
            } else {
                log.error("Failed to fetch computers. Relevance error or empty response.", resp.data);
            }
        }
        
        computerList = cache.data;

        if (allowedComputers !== null) {
            computerList = computerList.filter(c => allowedComputers.includes(c.name.toLowerCase()));
        }

        if (search) computerList = computerList.filter(c => c.name.toLowerCase().includes(search) || c.ips.some(ip => ip.includes(search)) || (c.os && c.os.toLowerCase().includes(search)));

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
      
      if (!isMO && activeRole && activeRole !== "Admin" && activeRole !== "No Role Assigned") {
          const roleAssets = await getRoleAssets(req, ctx, activeRole);
          if (roleAssets.found && roleAssets.compNames.length > 0) {
              members = members.filter(m => roleAssets.compNames.includes(m.name.toLowerCase()));
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

        const bfAuthOpts = await getBfAuthContext(req, ctx);
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
}

module.exports = { attachGroupRoutes };