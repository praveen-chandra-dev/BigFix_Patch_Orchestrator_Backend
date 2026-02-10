// bigfix-backend/src/routes/groups.js
const axios = require("axios");
const { joinUrl } = require("../utils/http");
const { logFactory } = require("../utils/log");
const { sql, getPool } = require("../db/mssql");
const { bigfixClient } = require("../services/bigfix");

// --- CACHE STORE (For Servers) ---
const CACHE_TTL = 10 * 60 * 1000; // 10 Minutes
let computersCache = {
  data: [],
  lastFetch: 0,
  loading: false
};

const xmlEscape = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

// --- Helper: Verify which IDs actually exist in BigFix ---
async function verifyBigFixIds(bigfixCtx, ids) {
  if (!ids || ids.length === 0) return [];
  const { BIGFIX_BASE_URL, BIGFIX_USER, BIGFIX_PASS, httpsAgent } = bigfixCtx;
  
  const setStr = ids.join("; ");
  const relevance = `unique values of ids of bes computer groups whose (id of it is contained by set of (${setStr}))`;
  let foundIds = [];
  try {
    const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
    const resp = await axios.get(url, { httpsAgent, auth: { username: BIGFIX_USER, password: BIGFIX_PASS }, headers: { Accept: "application/json" } });
    const result = resp.data?.result;
    if (Array.isArray(result)) result.forEach(r => foundIds.push(String(r)));
    else if (result) foundIds.push(String(result));
  } catch (e) { console.warn("[GroupSync] Relevance check failed:", e.message); }
  
  const missing = ids.filter(id => !foundIds.includes(String(id)));
  if (missing.length > 0) {
    try {
        const restUrl = joinUrl(BIGFIX_BASE_URL, "/api/computergroups/master");
        const restResp = await axios.get(restUrl, { httpsAgent, auth: { username: BIGFIX_USER, password: BIGFIX_PASS }, headers: { Accept: "application/xml" }, validateStatus: (s) => s < 500 });
        if (restResp.status === 200) {
            const xml = String(restResp.data || "");
            const regex = /<ID>(\d+)<\/ID>/gi;
            let match;
            while ((match = regex.exec(xml)) !== null) {
                if (missing.includes(match[1])) foundIds.push(match[1]);
            }
        }
    } catch (e) { console.warn("[GroupSync] Master check failed:", e.message); }
  }
  return foundIds;
}

function attachGroupRoutes(app, ctx) {
  const log = logFactory(ctx.DEBUG_LOG);
  const { BIGFIX_BASE_URL, BIGFIX_USER, BIGFIX_PASS, httpsAgent } = ctx.bigfix;
  const authOptions = { httpsAgent, auth: { username: BIGFIX_USER, password: BIGFIX_PASS }, headers: { Accept: "application/json" } };

  // --- 1. LIST GROUPS (With Smart Sync) ---
  app.get("/api/groups/list", async (req, res) => {
    try {
      const userRole = req.headers['x-user-role'] || 'Admin';
      const pool = await getPool();
      
      let query = "SELECT BigFixID, AssetName, CreatedByRole, CreatedAt FROM dbo.AssetOwnership WHERE AssetType='Group'";
      if (userRole !== 'Admin') query += " AND CreatedByRole = @Role";
      const reqSql = pool.request();
      if (userRole !== 'Admin') reqSql.input('Role', sql.NVarChar(50), userRole);
      
      const dbRes = await reqSql.query(query);
      let dbGroups = dbRes.recordset;

      // Smart Sync: Only remove groups missing from BigFix if they are > 1 hour old
      if (dbGroups.length > 0) {
        const localIds = dbGroups.map(g => g.BigFixID);
        const realIds = await verifyBigFixIds(ctx.bigfix, localIds);
        const zombies = dbGroups.filter(g => !realIds.includes(String(g.BigFixID)));
        
        if (zombies.length > 0) {
          const idsToDelete = [];
          const now = Date.now();
          const GRACE_PERIOD_MS = 60 * 60 * 1000; 

          for (const z of zombies) {
             const createdTime = z.CreatedAt ? new Date(z.CreatedAt).getTime() : 0;
             if (now - createdTime > GRACE_PERIOD_MS) {
                idsToDelete.push(z.BigFixID);
             }
          }

          if (idsToDelete.length > 0) {
             console.log(`[GroupSync] Cleaning up ${idsToDelete.length} deleted groups.`);
             for (const zId of idsToDelete) {
                await pool.request().input('ZID', sql.NVarChar(255), String(zId)).query("DELETE FROM dbo.AssetOwnership WHERE BigFixID = @ZID");
             }
             dbGroups = dbGroups.filter(g => !idsToDelete.includes(String(g.BigFixID)));
          }
        }
      }

      const results = dbGroups.map(g => ({ id: g.BigFixID, name: g.AssetName, ownerRole: g.CreatedByRole }));
      res.json({ ok: true, groups: results });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // --- 2. CREATE GROUP ---
  app.post("/api/groups/create", async (req, res) => {
    const { name, type, targetSite, conditions, computerIds } = req.body;
    const userRole = req.headers['x-user-role'] || 'Admin';
    if (!name) return res.status(400).json({ ok: false, error: "Group name is required" });
    
    let endpoint = "", xmlBody = "";
    if (type === "Manual") {
        if (!computerIds?.length) return res.status(400).json({ok:false, error: "No computers selected"});
        endpoint = "/api/computergroup/master";
        const computerTags = computerIds.map(id => `<ComputerID>${id}</ComputerID>`).join("\n");
        xmlBody = `<?xml version="1.0" encoding="UTF-8"?><BESAPI xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="BESAPI.xsd"><ManualComputerGroup><Name>${xmlEscape(name)}</Name><EvaluateOnClient>false</EvaluateOnClient>${computerTags}</ManualComputerGroup></BESAPI>`;
    } else {
        if (!conditions?.length) return res.status(400).json({ok:false, error: "No conditions provided"});
        const sitePath = targetSite ? `/custom/${targetSite}` : "/master";
        endpoint = `/api/computergroup${sitePath}`;
        const searchComponents = conditions.map(cond => `<SearchComponentPropertyReference PropertyName="${xmlEscape(cond.property)}" Comparison="${xmlEscape(cond.operator)}"><SearchText>${xmlEscape(cond.value)}</SearchText><Relevance></Relevance></SearchComponentPropertyReference>`).join("");
        xmlBody = `<BES xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="BES.xsd"><ComputerGroup><Title>${xmlEscape(name)}</Title><JoinByIntersection>true</JoinByIntersection>${searchComponents}</ComputerGroup></BES>`;
    }

    try {
      const postUrl = joinUrl(BIGFIX_BASE_URL, endpoint);
      const bfResp = await axios.post(postUrl, xmlBody, { ...authOptions, responseType: 'text', headers: { ...authOptions.headers, "Content-Type": "application/xml" } });
      let newId = null, rawStr = String(bfResp.data || "").trim();
      let idMatch = rawStr.match(/<ID>\s*(\d+)\s*<\/ID>/i);
      if (idMatch) newId = idMatch[1];
      if (!newId) { idMatch = rawStr.match(/Resource=["'].*?\/(\d+)["']/i); if (idMatch) newId = idMatch[1]; }
      if (!newId) { idMatch = rawStr.match(/\/(\d+)\s*$/); if (idMatch) newId = idMatch[1]; }
      
      if (newId) {
        const pool = await getPool();
        await pool.request().input('BigFixID', sql.NVarChar(255), String(newId)).input('AssetName', sql.NVarChar(255), name).input('AssetType', sql.NVarChar(50), 'Group').input('CreatedByRole', sql.NVarChar(50), userRole).query(`INSERT INTO dbo.AssetOwnership (BigFixID, AssetName, AssetType, CreatedByRole, CreatedAt) VALUES (@BigFixID, @AssetName, @AssetType, @CreatedByRole, SYSUTCDATETIME())`);
        res.json({ ok: true, id: newId });
      } else throw new Error("Group created but ID parse failed.");
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // --- 3. DELETE GROUP ---
  app.delete("/api/groups/:id", async (req, res) => {
    const { id } = req.params;
    const userRole = req.headers['x-user-role'] || 'Admin';
    try {
      const pool = await getPool();
      if (userRole !== 'Admin') {
        const check = await pool.request().input('ID', sql.NVarChar(255), id).query("SELECT CreatedByRole FROM dbo.AssetOwnership WHERE BigFixID = @ID");
        if (!check.recordset.length || check.recordset[0].CreatedByRole !== userRole) return res.status(403).json({ ok: false, error: "Permission Denied" });
      }
      const url = joinUrl(BIGFIX_BASE_URL, `/api/computergroup/master/${id}`);
      try { await axios.delete(url, authOptions); } catch (e) { /* ignore 404 */ }
      await pool.request().input('ID', sql.NVarChar(255), id).query("DELETE FROM dbo.AssetOwnership WHERE BigFixID = @ID");
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // --- 4. LIST COMPUTERS (Updated for EUC Separation) ---
  app.get("/api/groups/metadata/computers", async (req, res) => {
      try {
        const userRole = req.headers['x-user-role'] || 'Admin';
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const search = (req.query.search || "").toLowerCase();

        let computerList = [];

        // === EUC ROLE: FETCH NON-SERVERS DIRECTLY ===
        if (userRole === 'EUC') {
            console.log("[BigFix] EUC Role detected: Fetching Non-Server Devices...");
            
            // Filters OUT devices where Device Type is "server"
            const relevance = `(id of it as string & "||" & name of it as string & "||" & (value of result (it, bes property "Patch_Setu_IP_Address") | "N/A") & "||" & (operating system of it as string | "Unknown")) of bes computers whose (value of result (it, bes property "Device Type") as lowercase != "server")`;
            
            const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
            const resp = await axios.get(url, authOptions);
            const raw = Array.isArray(resp.data?.result) ? resp.data.result : [];
            
            computerList = raw.map(r => { 
                const p = String(r).split("||"); 
                const ipStr = p[2] === "N/A" ? "" : p[2];
                return { 
                  id: p[0], 
                  name: p[1], 
                  ips: ipStr.split(/[;,]/).map(x => x.trim()).filter(Boolean),
                  os: p[3]
                }; 
            });

        } else {
            // === SERVER ROLES (Admin, Windows, Linux) ===
            // Use Cache logic for Servers
            const now = Date.now();
            if ((now - computersCache.lastFetch > CACHE_TTL) || !computersCache.data.length) {
                console.log("[BigFix] Refreshing Computer Cache (Servers)...");
                
                // Filters FOR devices where Device Type is "server"
                const relevance = `(id of it as string & "||" & name of it as string & "||" & (value of result (it, bes property "Patch_Setu_IP_Address") | "N/A") & "||" & (operating system of it as string | "Unknown")) of bes computers whose (value of result (it, bes property "Device Type") as lowercase = "server")`;
    
                const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
                const resp = await axios.get(url, authOptions);
                const raw = Array.isArray(resp.data?.result) ? resp.data.result : [];
                
                computersCache.data = raw.map(r => { 
                    const p = String(r).split("||"); 
                    const ipStr = p[2] === "N/A" ? "" : p[2];
                    return { 
                      id: p[0], 
                      name: p[1], 
                      ips: ipStr.split(/[;,]/).map(x => x.trim()).filter(Boolean),
                      os: p[3]
                    }; 
                });
                computersCache.lastFetch = now;
                console.log(`[BigFix] Cached ${computersCache.data.length} computers.`);
            }
            
            computerList = computersCache.data;

            // Apply Role Filters for Servers
            if (userRole === 'Windows') {
                computerList = computerList.filter(c => c.os && c.os.toLowerCase().includes("win"));
            } else if (userRole === 'Linux') {
                computerList = computerList.filter(c => c.os && !c.os.toLowerCase().includes("win"));
            }
        }

        // --- COMMON: SEARCH & PAGINATION ---
        if (search) {
            computerList = computerList.filter(c => 
                c.name.toLowerCase().includes(search) || 
                c.ips.some(ip => ip.includes(search)) ||
                (c.os && c.os.toLowerCase().includes(search))
            );
        }

        const startIndex = (page - 1) * limit;
        const endIndex = startIndex + limit;
        const resultSlice = computerList.slice(startIndex, endIndex);

        res.json({ 
            ok: true, 
            computers: resultSlice,
            total: computerList.length,
            page,
            totalPages: Math.ceil(computerList.length / limit)
        });

      } catch (e) { res.status(500).json({ok:false, error:e.message}); }
  });

  // --- 5. GET GROUP MEMBERS (Role-Filtered) ---
  app.get("/api/groups/:name/members", async (req, res) => {
    req._logStart = Date.now();
    try {
      const userRole = req.headers['x-user-role'] || 'Admin';
      const client = bigfixClient(ctx);
      let members = await client.getGroupMembers(req.params.name);
      
      // Filter members based on Role
      if (userRole === 'Windows') {
          members = members.filter(m => m.os && m.os.toLowerCase().includes("win"));
      } else if (userRole === 'Linux') {
          members = members.filter(m => m.os && !m.os.toLowerCase().includes("win"));
      }
      // Note: EUC filter for *existing* groups isn't applied here strictly by device type
      // because getGroupMembers usually returns pre-calculated members. 
      // If strict security is needed for EUC viewing mixed groups, additional logic is needed.

      res.json({ ok: true, members });
    } catch (e) {
      log(req, "Group Members Error:", e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // --- 6. PROPERTIES ---
  app.get("/api/groups/metadata/properties", async (req, res) => {
      try {
        const relevance = `(((item 1 of it) of id of it as string | "N/A") & "||" & (name of it as string | "N/A")) of bes properties whose (reserved flag of it is true)`;
        const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
        const resp = await axios.get(url, authOptions);
        const raw = Array.isArray(resp.data?.result) ? resp.data.result : [];
        const properties = raw.map(r => String(r).split("||")[1] || "Unknown").sort();
        res.json({ ok: true, properties: [...new Set(properties)] });
      } catch (e) { res.status(500).json({ok:false, error:e.message}); }
  });
}

module.exports = { attachGroupRoutes };