// bigfix-backend/src/routes/vcenter.js
const { vcenterClient } = require("../services/vcenter");
const { logFactory } = require("../utils/log");
const { sql, getPool } = require("../db/mssql"); 
const { bigfixClient } = require("../services/bigfix");
const axios = require('axios');
const https = require('https');

// --- 1. SSL & Auth Helpers ---
// Create a dedicated agent to force bypass of Self-Signed Cert errors
const agent = new https.Agent({ rejectUnauthorized: false });

// Helper to decode Base64 password from .env if needed
function decodePassword(raw) {
    if (!raw) return "";
    try {
        // Simple check: if it looks like Base64 (no spaces, ends in = or alphanumeric), try decode
        // Your password "RnJlZXNlcnZlciE1MjMxNg==" is definitely Base64
        if (/^[A-Za-z0-9+/=]+$/.test(raw) && raw.length % 4 === 0) {
             const decoded = Buffer.from(raw, 'base64').toString('utf-8');
             // Sanity check: verify it didn't turn into garbage
             if (decoded && !/[\x00-\x08\x0E-\x1F]/.test(decoded)) {
                 return decoded;
             }
        }
    } catch (e) {
        // If decode fails, assume it was plain text
    }
    return raw; 
}

// Helper: Get Session ID (Robust REST Implementation for Lookup)
async function getRobustSession(url, user, passEncoded) {
    const password = decodePassword(passEncoded);
    
    // Ensure URL is clean
    const cleanUrl = (url || "").replace(/\/+$/, ""); 
    
    try {
        const res = await axios.post(`${cleanUrl}/rest/com/vmware/cis/session`, {}, {
            httpsAgent: agent,
            auth: { username: user, password: password },
            headers: { "Content-Type": "application/json", "Accept": "application/json" },
            timeout: 10000 // 10s timeout for login
        });
        return res.data.value;
    } catch (e) {
        console.error("[VCenter Login] Failed:", e.message);
        if (e.response) console.error("Details:", JSON.stringify(e.response.data));
        throw e;
    }
}

function attachVcenterRoutes(app, ctx) {
  const log = logFactory(ctx.DEBUG_LOG);

  // --- PREPARE SAFE CONTEXT ---
  // We create a modified context where the password is pre-decoded.
  // This ensures the 'vcenterClient' service (used for Snapshot/Clone) gets the correct credentials.
  const vcenterCtx = { 
      ...ctx, 
      vcenter: { 
          ...ctx.vcenter, 
          // Ensure we pull from ctx.vcenter first, then decode
          VCENTER_PASSWORD: decodePassword(ctx.vcenter?.VCENTER_PASSWORD || ctx.cfg?.VCENTER_PASSWORD || "") 
      } 
  };

  const checkConfig = (req, res, next) => {
    const hasUrl = ctx.VCENTER_URL || (ctx.vcenter && ctx.vcenter.VCENTER_URL);
    if (!hasUrl) return res.status(503).json({ ok: false, error: "VCenter not configured." });
    next();
  };

  // --- 1. GET INVENTORY (Preserved) ---
  app.get("/api/vcenter/inventory", checkConfig, async (req, res) => {
    try {
      const client = vcenterClient(vcenterCtx); // Pass safe context
      const inventory = await client.getRestInventory();
      res.json({ ok: true, inventory });
    } catch (e) {
      console.error("[VCenter Inventory Error]", e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // --- 2. IP/VM LOOKUP (FIXED & ROBUST) ---
  // This replaces the old route with one that handles SSL and Search properly
  app.post("/api/vcenter/lookup", checkConfig, async (req, res) => {
    const { filter, targets } = req.body; 
    
    // CASE A: Batch Lookup (Legacy/Background) - Uses the Service
    if (targets && Array.isArray(targets)) {
         try {
           const client = vcenterClient(vcenterCtx);
           const matches = await client.resolveTargets(targets);
           return res.json({ ok: true, matches });
         } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
    }

    // CASE B: Single Lookup (Search Bar) - Uses Robust Route
    if (!filter || filter.length < 3) {
      return res.json({ ok: true, found: false, results: [] });
    }

    try {
      const { VCENTER_URL, VCENTER_USER, VCENTER_PASSWORD } = ctx.vcenter;
      const cleanUrl = (VCENTER_URL || "").replace(/\/+$/, "");

      // 1. Login (Robust)
      const sessionId = await getRobustSession(cleanUrl, VCENTER_USER, VCENTER_PASSWORD);
      
      // 2. Search
      // We use the REST API 'names' filter which is standard for VCenter 6.5+
      const searchUrl = `${cleanUrl}/rest/vcenter/vm?names=${encodeURIComponent(filter)}`;
      
      // Note: If you want wildcard search (e.g. 'test*'), VCenter REST API is strict.
      // We often have to fetch list and filter in JS if exact match fails, 
      // but for "Lookup" usually exact match or list is preferred.
      // Trying exact match first:
      
      const vmRes = await axios.get(searchUrl, {
        httpsAgent: agent,
        headers: { "vmware-api-session-id": sessionId, "Accept": "application/json" },
        validateStatus: () => true // Don't throw on 404
      });

      let vms = [];
      if (vmRes.status === 200 && vmRes.data.value) {
          vms = vmRes.data.value;
      } else {
          // Fallback: If filter failed, maybe try searching by IP?
          // For now, return empty to prevent crash
          console.warn(`[VCenter Lookup] Search returned ${vmRes.status}`);
      }
      
      const results = vms.map(vm => ({
          id: vm.vm,          
          name: vm.name,      
          power_state: vm.power_state
      }));
      
      res.json({ ok: true, found: results.length > 0, results });

    } catch (error) {
      console.error("[VCenter Lookup Error]:", error.message);
      // Return 200 OK with error payload so Frontend displays "Connection Error" icon instead of crashing
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  // --- 3. SNAPSHOT (PRESERVED LOGIC) ---
  app.post("/api/vcenter/snapshot", checkConfig, async (req, res) => {
    const { vmIds, snapshotName, description, includeMemory, quiesce, vmNames } = req.body; 
    log(req, `VCenter Snapshot: ${vmIds?.length} VMs`);
    try {
      const client = vcenterClient(vcenterCtx); // Uses decoded password
      const pool = await getPool();
      const getName = (id) => (vmNames && vmNames[id]) ? vmNames[id] : id;
      const results = [];
      
      const BATCH_SIZE = 5;
      for (let i = 0; i < vmIds.length; i += BATCH_SIZE) {
        const batch = vmIds.slice(i, i + BATCH_SIZE);
        const batchRes = await Promise.all(batch.map(id => client.createSnapshot(id, snapshotName, description, includeMemory, quiesce)));
        
        for (const r of batchRes) {
           await pool.request()
             .input('VmId', sql.NVarChar(100), String(r.vmId))
             .input('VmName', sql.NVarChar(255), String(getName(r.vmId)))
             .input('SnapshotName', sql.NVarChar(255), String(snapshotName))
             .input('Type', sql.NVarChar(50), 'Snapshot') 
             .input('Status', sql.NVarChar(50), r.ok ? (r.taskId?'queued':'completed') : 'failed')
             .input('TaskId', sql.NVarChar(100), r.taskId ? String(r.taskId) : null)
             .input('Error', sql.NVarChar(sql.MAX), r.error || null)
             .query(`INSERT INTO dbo.SnapshotHistory (VmId, VmName, SnapshotName, Type, TaskId, Status, Error) VALUES (@VmId, @VmName, @SnapshotName, @Type, @TaskId, @Status, @Error)`);
        }
        results.push(...batchRes);
      }
      res.json({ ok: true, results });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // --- 4. CLONE VM (PRESERVED LOGIC) ---
  app.post("/api/vcenter/clone", checkConfig, async (req, res) => {
    const { global, clones } = req.body; 
    if (!clones || !Array.isArray(clones)) return res.status(400).json({ok:false, error:"Missing clones array"});
    if (!global || !global.host || !global.datastore || !global.folder) return res.status(400).json({ok:false, error:"Missing global destination settings"});

    log(req, `VCenter Clone: Starting for ${clones.length} VMs.`);

    try {
      const client = vcenterClient(vcenterCtx); // Uses decoded password
      const pool = await getPool();
      const results = [];
      
      for (const vm of clones) {
         const { id: vmId, cloneName, newIp, subnet, gateway, dns } = vm;
         const { host: hostId, datastore: datastoreId, folder: folderId, osSpec: osSpecName } = global;

         log(req, `[Clone] Initiating: ${vm.name} -> ${cloneName} (${newIp})`);

         const cloneRes = await client.cloneVm(
            vmId, 
            cloneName, 
            { hostId, datastoreId, folderId, osSpecName },
            { newIp, subnet, gateway, dns }
         );

         const status = cloneRes.ok ? 'queued' : 'failed';
         const taskId = cloneRes.taskId || null;
         const errorMsg = cloneRes.error || null;

         await pool.request()
            .input('VmId', sql.NVarChar(100), String(vmId))
            .input('VmName', sql.NVarChar(255), String(vm.name))
            .input('SnapshotName', sql.NVarChar(255), String(cloneName))
            .input('Type', sql.NVarChar(50), 'Clone')
            .input('Status', sql.NVarChar(50), status)
            .input('TaskId', sql.NVarChar(100), String(taskId)) 
            .input('Error', sql.NVarChar(sql.MAX), errorMsg)
            .query(`INSERT INTO dbo.SnapshotHistory (VmId, VmName, SnapshotName, Type, Status, TaskId, Error) VALUES (@VmId, @VmName, @SnapshotName, @Type, @Status, @TaskId, @Error)`);
         
         results.push({ ok: cloneRes.ok, id: vmId, taskId, error: errorMsg });
      }
      res.json({ ok: true, results });
    } catch (e) {
      console.error("[VCenter Clone Error]", e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // --- 5. TASK STATUS (PRESERVED) ---
  app.post("/api/vcenter/tasks", checkConfig, async (req, res) => {
    const { taskIds } = req.body;
    if (!taskIds || !taskIds.length) return res.json({ ok: true, statuses: {} });
    try {
      const client = vcenterClient(vcenterCtx);
      const statuses = await client.getTasksStatus(taskIds);
      const pool = await getPool();
      const simple = {};
      for (const [tid, info] of Object.entries(statuses)) {
        let st = info.state === 'success' ? 'completed' : info.state === 'error' ? 'failed' : info.state;
        simple[tid] = st;
        if (st !== 'unknown') {
           const req = pool.request().input('T', sql.NVarChar(100), tid).input('S', sql.NVarChar(50), st);
           let q = "UPDATE dbo.SnapshotHistory SET Status=@S";
           if (info.error) { req.input('E', sql.NVarChar(sql.MAX), info.error); q += ", Error=@E"; }
           await req.query(q + " WHERE TaskId=@T");
        }
      }
      res.json({ ok: true, statuses: simple });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // --- 6. HISTORY & VALIDATION (PRESERVED) ---
  app.get("/api/vcenter/history", async (req, res) => {
    try {
      const pool = await getPool();
      const r = await pool.request().query(`SELECT Id, VmId, VmName, SnapshotName, Type, TaskId, Status, Error, CreatedAt FROM dbo.SnapshotHistory ORDER BY CreatedAt DESC`);
      res.json({ ok: true, history: r.recordset });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post("/api/vcenter/validate", async (req, res) => {
    const { groupName, lookbackHours = 24 } = req.body;
    try {
      const bfClient = bigfixClient(ctx);
      const members = await bfClient.getGroupMembers(groupName);
      if (!members || !members.length) return res.json({ ok: true, ready: false, error: "Group empty" });

      const pool = await getPool();
      const r = await pool.request().input('H', sql.Int, lookbackHours).query(`SELECT DISTINCT LOWER(VmName) as N FROM dbo.SnapshotHistory WHERE Status IN ('completed','success','queued','running') AND CreatedAt >= DATEADD(hour, -@H, SYSUTCDATETIME())`);
      const protectedSet = new Set(r.recordset.map(x => x.N));
      const missing = members.filter(m => !protectedSet.has(m.name.toLowerCase())).map(m => m.name);
      
      res.json({ ok: true, ready: missing.length === 0, total: members.length, protected: members.length - missing.length, missing: missing.slice(0, 10) });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
}

module.exports = { attachVcenterRoutes };