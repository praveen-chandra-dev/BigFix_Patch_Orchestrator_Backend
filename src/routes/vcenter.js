// // src/routes/vcenter.js
// const { vcenterClient } = require("../services/vcenter");
// const { logFactory } = require("../utils/log");
// const { sql, getPool } = require("../db/mssql"); 
// const { bigfixClient } = require("../services/bigfix");
// const axios = require('axios');
// const https = require('https');
// const { bigfixClient, getRoleAssets, isMasterOperator } = require("../services/bigfix"); // 🚀 Added RBAC imports
// const { getSessionUser, getSessionRole } = require("../utils/http"); // 🚀 Added session imports

// const agent = new https.Agent({ rejectUnauthorized: false });

// async function getRobustSession(url, user, password) {
//     const cleanUrl = (url || "").replace(/\/+$/, ""); 
    
//     try {
//         // 🚀 FIX: Pass the raw, pristine password. No aggressive base64 decoding!
//         const res = await axios.post(`${cleanUrl}/rest/com/vmware/cis/session`, {}, {
//             httpsAgent: agent,
//             auth: { username: user, password: password },
//             headers: { "Content-Type": "application/json", "Accept": "application/json" },
//             timeout: 10000 
//         });
//         return res.data.value;
//     } catch (e) {
//         console.error("[VCenter Login] Failed:", e.message);
//         throw e;
//     }
// }

// function attachVcenterRoutes(app, ctx) {
//   const log = logFactory(ctx.DEBUG_LOG);
//   if (!app.locals.ctx) app.locals.ctx = ctx;

//   const getDynamicCtx = (req) => {
//       const currentCtx = req.app.locals.ctx || ctx;
//       // 🚀 FIX: env.js already decrypts DB secrets, so we just pass them straight through.
//       const password = currentCtx.cfg?.VCENTER_PASSWORD || currentCtx.vcenter?.VCENTER_PASSWORD || currentCtx.VCENTER_PASSWORD || "";
//       const url = currentCtx.cfg?.VCENTER_URL || currentCtx.vcenter?.VCENTER_URL || currentCtx.VCENTER_URL || "";
//       const user = currentCtx.cfg?.VCENTER_USER || currentCtx.vcenter?.VCENTER_USER || currentCtx.VCENTER_USER || "";
      
//       return { 
//           ...currentCtx, 
//           VCENTER_PASSWORD: password,
//           VCENTER_URL: url,
//           VCENTER_USER: user,
//           vcenter: {
//               ...currentCtx.vcenter,
//               VCENTER_URL: url,
//               VCENTER_USER: user,
//               VCENTER_PASSWORD: password
//           }
//       };
//   };

//   const checkConfig = (req, res, next) => {
//     const dCtx = getDynamicCtx(req);
//     if (!dCtx.VCENTER_URL) return res.status(503).json({ ok: false, error: "VCenter not configured." });
//     next();
//   };

//   app.get("/api/vcenter/inventory", checkConfig, async (req, res) => {
//     try {
//       const client = vcenterClient(getDynamicCtx(req)); 
//       const inventory = await client.getRestInventory();
//       res.json({ ok: true, inventory });
//     } catch (e) {
//       console.error("[VCenter Inventory Error]", e.message);
//       res.status(500).json({ ok: false, error: e.message });
//     }
//   });

//   app.post("/api/vcenter/lookup", checkConfig, async (req, res) => {
//     const { filter, targets } = req.body; 
//     const dCtx = getDynamicCtx(req);
    
//     if (targets && Array.isArray(targets)) {
//          try {
//            const client = vcenterClient(dCtx);
//            const matches = await client.resolveTargets(targets);
//            return res.json({ ok: true, matches });
//          } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
//     }

//     if (!filter || filter.length < 3) return res.json({ ok: true, found: false, results: [] });

//     try {
//       const { VCENTER_URL, VCENTER_USER, VCENTER_PASSWORD } = dCtx;
//       const cleanUrl = (VCENTER_URL || "").replace(/\/+$/, "");

//       const sessionId = await getRobustSession(cleanUrl, VCENTER_USER, VCENTER_PASSWORD);
//       const searchUrl = `${cleanUrl}/rest/vcenter/vm?names=${encodeURIComponent(filter)}`;
      
//       const vmRes = await axios.get(searchUrl, {
//         httpsAgent: agent,
//         headers: { "vmware-api-session-id": sessionId, "Accept": "application/json" },
//         validateStatus: () => true 
//       });

//       let vms = [];
//       if (vmRes.status === 200 && vmRes.data.value) vms = vmRes.data.value;
      
//       const results = vms.map(vm => ({ id: vm.vm, name: vm.name, power_state: vm.power_state }));
//       res.json({ ok: true, found: results.length > 0, results });
//     } catch (error) {
//       console.error("[VCenter Lookup Error]:", error.message);
//       res.status(500).json({ ok: false, error: error.message });
//     }
//   });

//   app.post("/api/vcenter/snapshot", checkConfig, async (req, res) => {
//     const { vmIds, snapshotName, description, includeMemory, quiesce, vmNames } = req.body; 
//     log(req, `VCenter Snapshot: ${vmIds?.length} VMs`);
//     try {
//       const client = vcenterClient(getDynamicCtx(req)); 
//       const pool = await getPool();
//       const getName = (id) => (vmNames && vmNames[id]) ? vmNames[id] : id;
//       const results = [];
      
//       const BATCH_SIZE = 5;
//       for (let i = 0; i < vmIds.length; i += BATCH_SIZE) {
//         const batch = vmIds.slice(i, i + BATCH_SIZE);
//         const batchRes = await Promise.all(batch.map(id => client.createSnapshot(id, snapshotName, description, includeMemory, quiesce)));
        
//         for (const r of batchRes) {
//            await pool.request()
//              .input('VmId', sql.NVarChar(100), String(r.vmId))
//              .input('VmName', sql.NVarChar(255), String(getName(r.vmId)))
//              .input('SnapshotName', sql.NVarChar(255), String(snapshotName))
//              .input('Type', sql.NVarChar(50), 'Snapshot') 
//              .input('Status', sql.NVarChar(50), r.ok ? (r.taskId?'queued':'completed') : 'failed')
//              .input('TaskId', sql.NVarChar(100), r.taskId ? String(r.taskId) : null)
//              .input('Error', sql.NVarChar(sql.MAX), r.error || null)
//              .query(`INSERT INTO dbo.SnapshotHistory (VmId, VmName, SnapshotName, Type, TaskId, Status, Error) VALUES (@VmId, @VmName, @SnapshotName, @Type, @TaskId, @Status, @Error)`);
//         }
//         results.push(...batchRes);
//       }
//       res.json({ ok: true, results });
//     } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
//   });

//   app.post("/api/vcenter/clone", checkConfig, async (req, res) => {
//     const { global, clones } = req.body; 
//     if (!clones || !Array.isArray(clones)) return res.status(400).json({ok:false, error:"Missing clones array"});
//     if (!global || !global.host || !global.datastore || !global.folder) return res.status(400).json({ok:false, error:"Missing global destination settings"});

//     log(req, `VCenter Clone: Starting for ${clones.length} VMs.`);

//     try {
//       const client = vcenterClient(getDynamicCtx(req)); 
//       const pool = await getPool();
//       const results = [];
      
//       for (const vm of clones) {
//          const { id: vmId, cloneName, newIp, subnet, gateway, dns } = vm;
//          const { host: hostId, datastore: datastoreId, folder: folderId, osSpec: osSpecName } = global;

//          const cloneRes = await client.cloneVm(
//             vmId, cloneName, 
//             { hostId, datastoreId, folderId, osSpecName },
//             { newIp, subnet, gateway, dns }
//          );

//          const status = cloneRes.ok ? 'queued' : 'failed';
//          const taskId = cloneRes.taskId || null;
//          const errorMsg = cloneRes.error || null;

//          await pool.request()
//             .input('VmId', sql.NVarChar(100), String(vmId))
//             .input('VmName', sql.NVarChar(255), String(vm.name))
//             .input('SnapshotName', sql.NVarChar(255), String(cloneName))
//             .input('Type', sql.NVarChar(50), 'Clone')
//             .input('Status', sql.NVarChar(50), status)
//             .input('TaskId', sql.NVarChar(100), String(taskId)) 
//             .input('Error', sql.NVarChar(sql.MAX), errorMsg)
//             .query(`INSERT INTO dbo.SnapshotHistory (VmId, VmName, SnapshotName, Type, Status, TaskId, Error) VALUES (@VmId, @VmName, @SnapshotName, @Type, @Status, @TaskId, @Error)`);
         
//          results.push({ ok: cloneRes.ok, id: vmId, taskId, error: errorMsg });
//       }
//       res.json({ ok: true, results });
//     } catch (e) {
//       res.status(500).json({ ok: false, error: e.message });
//     }
//   });

//   app.post("/api/vcenter/tasks", checkConfig, async (req, res) => {
//     const { taskIds } = req.body;
//     if (!taskIds || !taskIds.length) return res.json({ ok: true, statuses: {} });
//     try {
//       const client = vcenterClient(getDynamicCtx(req));
//       const statuses = await client.getTasksStatus(taskIds);
//       const pool = await getPool();
//       const simple = {};
//       for (const [tid, info] of Object.entries(statuses)) {
//         let st = info.state === 'success' ? 'completed' : info.state === 'error' ? 'failed' : info.state;
//         simple[tid] = st;
//         if (st !== 'unknown') {
//            const req = pool.request().input('T', sql.NVarChar(100), tid).input('S', sql.NVarChar(50), st);
//            let q = "UPDATE dbo.SnapshotHistory SET Status=@S";
//            if (info.error) { req.input('E', sql.NVarChar(sql.MAX), info.error); q += ", Error=@E"; }
//            await req.query(q + " WHERE TaskId=@T");
//         }
//       }
//       res.json({ ok: true, statuses: simple });
//     } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
//   });

//   app.get("/api/vcenter/history", async (req, res) => {
//     try {
//       const pool = await getPool();
//       const r = await pool.request().query(`SELECT Id, VmId, VmName, SnapshotName, Type, TaskId, Status, Error, CreatedAt FROM dbo.SnapshotHistory ORDER BY CreatedAt DESC`);
//       res.json({ ok: true, history: r.recordset });
//     } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
//   });

//   // app.post("/api/vcenter/validate", async (req, res) => {
//   //   const { groupName, lookbackHours = 24 } = req.body;
//   //   try {
//   //     const currentCtx = req.app.locals.ctx || ctx;
      
//   //     if (!currentCtx || !currentCtx.bigfix) {
//   //         return res.status(500).json({ ok: false, error: "System context lost. Please restart the backend service." });
//   //     }

//   //     const bfClient = bigfixClient(req, currentCtx); 
//   //     const members = await bfClient.getGroupMembers(groupName);
//   //     if (!members || !members.length) return res.json({ ok: true, ready: false, error: "Group empty" });

//   //     const pool = await getPool();
//   //     const r = await pool.request().input('H', sql.Int, lookbackHours).query(`SELECT DISTINCT LOWER(VmName) as N FROM dbo.SnapshotHistory WHERE Status IN ('completed','success','queued','running') AND CreatedAt >= DATEADD(hour, -@H, SYSUTCDATETIME())`);
//   //     const protectedSet = new Set(r.recordset.map(x => x.N));
//   //     const missing = members.filter(m => !protectedSet.has(m.name.toLowerCase())).map(m => m.name);
      
//   //     res.json({ ok: true, ready: missing.length === 0, total: members.length, protected: members.length - missing.length, missing: missing.slice(0, 10) });
//   //   } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
//   // });

//   app.post("/api/vcenter/validate", async (req, res) => {
//     const { groupName, lookbackHours = 24 } = req.body;
//     try {
//       const currentCtx = req.app.locals.ctx || ctx;
      
//       if (!currentCtx || !currentCtx.bigfix) {
//           return res.status(500).json({ ok: false, error: "System context lost. Please restart the backend service." });
//       }

//       const bfClient = bigfixClient(req, currentCtx); 
//       let members = await bfClient.getGroupMembers(groupName);

//       // ==========================================
//       // 🔒 RBAC FILTERING: Strip unauthorized VMs
//       // ==========================================
//       const activeUser = getSessionUser(req);
//       const activeRole = req.headers['x-user-role'] || getSessionRole(req);
//       const isMO = await isMasterOperator(req, currentCtx, activeUser);

//       if (!isMO) {
//           if (!activeRole || activeRole === "No Role Assigned") {
//               members = []; // Block access entirely if no role
//           } else if (activeRole !== "Admin") {
//               const roleAssets = await getRoleAssets(req, currentCtx, activeRole);
//               if (roleAssets.found && roleAssets.compNames && roleAssets.compNames.length > 0) {
//                   const allowedSet = new Set(roleAssets.compNames.map(c => c.toLowerCase()));
//                   members = members.filter(m => allowedSet.has(m.name.toLowerCase()));
//               } else {
//                   members = []; // Block if no computers assigned to this role
//               }
//           }
//       }
//       // ==========================================

//       if (!members || !members.length) return res.json({ ok: true, ready: false, error: "Group empty or no computers authorized." });

//       const pool = await getPool();
//       const r = await pool.request().input('H', sql.Int, lookbackHours).query(`SELECT DISTINCT LOWER(VmName) as N FROM dbo.SnapshotHistory WHERE Status IN ('completed','success','queued','running') AND CreatedAt >= DATEADD(hour, -@H, SYSUTCDATETIME())`);
//       const protectedSet = new Set(r.recordset.map(x => x.N));
//       const missing = members.filter(m => !protectedSet.has(m.name.toLowerCase())).map(m => m.name);
      
//       res.json({ ok: true, ready: missing.length === 0, total: members.length, protected: members.length - missing.length, missing: missing.slice(0, 10) });
//     } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
//   });
// }

// module.exports = { attachVcenterRoutes };


// src/routes/vcenter.js
const { vcenterClient } = require("../services/vcenter");
const { logFactory } = require("../utils/log");
const { sql, getPool } = require("../db/mssql"); 
const { bigfixClient, getRoleAssets, isMasterOperator } = require("../services/bigfix");
const { getSessionUser, getSessionRole } = require("../utils/http");
const axios = require('axios');
const https = require('https');

const agent = new https.Agent({ rejectUnauthorized: false });

async function getRobustSession(url, user, password) {
    const cleanUrl = (url || "").replace(/\/+$/, ""); 
    try {
        const res = await axios.post(`${cleanUrl}/rest/com/vmware/cis/session`, {}, {
            httpsAgent: agent,
            auth: { username: user, password: password },
            headers: { "Content-Type": "application/json", "Accept": "application/json" },
            timeout: 10000 
        });
        return res.data.value;
    } catch (e) { throw e; }
}

function attachVcenterRoutes(app, ctx) {
  const log = logFactory(ctx.DEBUG_LOG);
  if (!app.locals.ctx) app.locals.ctx = ctx;

  const getDynamicCtx = (req) => {
      const currentCtx = req.app.locals.ctx || ctx;
      const password = currentCtx.cfg?.VCENTER_PASSWORD || currentCtx.vcenter?.VCENTER_PASSWORD || currentCtx.VCENTER_PASSWORD || "";
      const url = currentCtx.cfg?.VCENTER_URL || currentCtx.vcenter?.VCENTER_URL || currentCtx.VCENTER_URL || "";
      const user = currentCtx.cfg?.VCENTER_USER || currentCtx.vcenter?.VCENTER_USER || currentCtx.VCENTER_USER || "";
      
      return { 
          ...currentCtx, 
          VCENTER_PASSWORD: password, VCENTER_URL: url, VCENTER_USER: user,
          vcenter: { ...currentCtx.vcenter, VCENTER_URL: url, VCENTER_USER: user, VCENTER_PASSWORD: password }
      };
  };

  const checkConfig = (req, res, next) => {
    const dCtx = getDynamicCtx(req);
    if (!dCtx.VCENTER_URL) return res.status(503).json({ ok: false, error: "VCenter not configured." });
    next();
  };

  app.get("/api/vcenter/inventory", checkConfig, async (req, res) => {
    try {
      const client = vcenterClient(getDynamicCtx(req)); 
      const inventory = await client.getRestInventory();
      res.json({ ok: true, inventory });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post("/api/vcenter/lookup", checkConfig, async (req, res) => {
    const { filter, targets } = req.body; 
    const dCtx = getDynamicCtx(req);
    
    if (targets && Array.isArray(targets)) {
         try {
           const client = vcenterClient(dCtx);
           const matches = await client.resolveTargets(targets);
           return res.json({ ok: true, matches });
         } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
    }

    if (!filter || filter.length < 3) return res.json({ ok: true, found: false, results: [] });

    try {
      const { VCENTER_URL, VCENTER_USER, VCENTER_PASSWORD } = dCtx;
      const cleanUrl = (VCENTER_URL || "").replace(/\/+$/, "");
      const sessionId = await getRobustSession(cleanUrl, VCENTER_USER, VCENTER_PASSWORD);
      const searchUrl = `${cleanUrl}/rest/vcenter/vm?names=${encodeURIComponent(filter)}`;
      const vmRes = await axios.get(searchUrl, { httpsAgent: agent, headers: { "vmware-api-session-id": sessionId, "Accept": "application/json" }, validateStatus: () => true });

      let vms = [];
      if (vmRes.status === 200 && vmRes.data.value) vms = vmRes.data.value;
      const results = vms.map(vm => ({ id: vm.vm, name: vm.name, power_state: vm.power_state }));
      res.json({ ok: true, found: results.length > 0, results });
    } catch (error) { res.status(500).json({ ok: false, error: error.message }); }
  });

  app.post("/api/vcenter/snapshot", checkConfig, async (req, res) => {
    const { vmIds, snapshotName, description, includeMemory, quiesce, vmNames } = req.body; 
    try {
      const client = vcenterClient(getDynamicCtx(req)); 
      const pool = await getPool();
      const getName = (id) => (vmNames && vmNames[id]) ? vmNames[id] : id;
      const results = [];
      
      const BATCH_SIZE = 5;
      for (let i = 0; i < vmIds.length; i += BATCH_SIZE) {
        const batch = vmIds.slice(i, i + BATCH_SIZE);
        const batchRes = await Promise.all(batch.map(id => client.createSnapshot(id, snapshotName, description, includeMemory, quiesce)));
        
        for (const r of batchRes) {
           await pool.request()
             .input('VmId', sql.NVarChar(100), String(r.vmId)).input('VmName', sql.NVarChar(255), String(getName(r.vmId))).input('SnapshotName', sql.NVarChar(255), String(snapshotName)).input('Type', sql.NVarChar(50), 'Snapshot').input('Status', sql.NVarChar(50), r.ok ? (r.taskId?'queued':'completed') : 'failed').input('TaskId', sql.NVarChar(100), r.taskId ? String(r.taskId) : null).input('Error', sql.NVarChar(sql.MAX), r.error || null)
             .query(`INSERT INTO dbo.SnapshotHistory (VmId, VmName, SnapshotName, Type, TaskId, Status, Error) VALUES (@VmId, @VmName, @SnapshotName, @Type, @TaskId, @Status, @Error)`);
        }
        results.push(...batchRes);
      }
      res.json({ ok: true, results });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post("/api/vcenter/clone", checkConfig, async (req, res) => {
    const { global, clones } = req.body; 
    if (!clones || !Array.isArray(clones)) return res.status(400).json({ok:false, error:"Missing clones array"});
    if (!global || !global.host || !global.datastore || !global.folder) return res.status(400).json({ok:false, error:"Missing global destination settings"});

    try {
      const client = vcenterClient(getDynamicCtx(req)); 
      const pool = await getPool();
      const results = [];
      for (const vm of clones) {
         const { id: vmId, cloneName, newIp, subnet, gateway, dns } = vm;
         const { host: hostId, datastore: datastoreId, folder: folderId, osSpec: osSpecName } = global;

         const cloneRes = await client.cloneVm(vmId, cloneName, { hostId, datastoreId, folderId, osSpecName }, { newIp, subnet, gateway, dns });
         const status = cloneRes.ok ? 'queued' : 'failed';
         const taskId = cloneRes.taskId || null;
         const errorMsg = cloneRes.error || null;

         await pool.request().input('VmId', sql.NVarChar(100), String(vmId)).input('VmName', sql.NVarChar(255), String(vm.name)).input('SnapshotName', sql.NVarChar(255), String(cloneName)).input('Type', sql.NVarChar(50), 'Clone').input('Status', sql.NVarChar(50), status).input('TaskId', sql.NVarChar(100), String(taskId)).input('Error', sql.NVarChar(sql.MAX), errorMsg)
            .query(`INSERT INTO dbo.SnapshotHistory (VmId, VmName, SnapshotName, Type, Status, TaskId, Error) VALUES (@VmId, @VmName, @SnapshotName, @Type, @Status, @TaskId, @Error)`);
         
         results.push({ ok: cloneRes.ok, id: vmId, taskId, error: errorMsg });
      }
      res.json({ ok: true, results });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post("/api/vcenter/tasks", checkConfig, async (req, res) => {
    const { taskIds } = req.body;
    if (!taskIds || !taskIds.length) return res.json({ ok: true, statuses: {} });
    try {
      const client = vcenterClient(getDynamicCtx(req));
      const statuses = await client.getTasksStatus(taskIds);
      const pool = await getPool();
      const simple = {};
      for (const [tid, info] of Object.entries(statuses)) {
        let st = info.state === 'success' ? 'completed' : info.state === 'error' ? 'failed' : info.state;
        simple[tid] = st;
        if (st !== 'unknown') {
           const dbReq = pool.request().input('T', sql.NVarChar(100), tid).input('S', sql.NVarChar(50), st);
           let q = "UPDATE dbo.SnapshotHistory SET Status=@S";
           if (info.error) { dbReq.input('E', sql.NVarChar(sql.MAX), info.error); q += ", Error=@E"; }
           await dbReq.query(q + " WHERE TaskId=@T");
        }
      }
      res.json({ ok: true, statuses: simple });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

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
      const currentCtx = req.app.locals.ctx || ctx;
      if (!currentCtx || !currentCtx.bigfix) return res.status(500).json({ ok: false, error: "System context lost." });

      const bfClient = bigfixClient(req, currentCtx); 
      let members = await bfClient.getGroupMembers(groupName);

      // 🔒 RBAC FILTERING
      const activeUser = getSessionUser(req);
      const activeRole = req.headers['x-user-role'] || getSessionRole(req);
      const isMO = await isMasterOperator(req, currentCtx, activeUser);

      if (!isMO) {
          if (!activeRole || activeRole === "No Role Assigned") {
              members = [];
          } else if (activeRole !== "Admin") {
              const roleAssets = await getRoleAssets(req, currentCtx, activeRole);
              if (roleAssets.found && roleAssets.compNames && roleAssets.compNames.length > 0) {
                  const allowedSet = new Set(roleAssets.compNames.map(c => c.toLowerCase()));
                  members = members.filter(m => allowedSet.has(m.name.toLowerCase()));
              } else {
                  members = [];
              }
          }
      }

      if (!members || !members.length) return res.json({ ok: true, ready: false, error: "Group empty or no computers authorized." });

      const pool = await getPool();
      const r = await pool.request().input('H', sql.Int, lookbackHours).query(`SELECT DISTINCT LOWER(VmName) as N FROM dbo.SnapshotHistory WHERE Status IN ('completed','success','queued','running') AND CreatedAt >= DATEADD(hour, -@H, SYSUTCDATETIME())`);
      const protectedSet = new Set(r.recordset.map(x => x.N));
      const missing = members.filter(m => !protectedSet.has(m.name.toLowerCase())).map(m => m.name);
      
      res.json({ ok: true, ready: missing.length === 0, total: members.length, protected: members.length - missing.length, missing: missing.slice(0, 10) });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
}

// 🚀 CRITICAL: This export is required for Express to map the routes properly!
module.exports = { attachVcenterRoutes };