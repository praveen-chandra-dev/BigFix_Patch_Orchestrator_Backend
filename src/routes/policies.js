// src/routes/policies.js
const express = require("express");
const router  = express.Router();
const axios   = require("axios");
const { sql, getPool } = require("../db/mssql");
const { logger }       = require("../services/logger");
const { getSessionData } = require("../middlewares/auth.middleware");
const { joinUrl, escapeXML, getBfAuthContext } = require("../utils/http");
const { collectStrings, extractActionIdFromXml } = require("../utils/query");
const { getPatches }   = require("../services/prism");
const { getCache }     = require("../services/prismCache");
const { getCtx }       = require("../env");

// ── Auth helper ───────────────────────────────────────────────────────────────
function requireSession(req, res) {
  const session = getSessionData(req);
  if (!session) { res.status(401).json({ ok: false, error: "Unauthorized" }); return null; }
  return session;
}

// ── GET /api/policies ─────────────────────────────────────────────────────────
// Returns policies visible to the caller.
router.get("/api/policies", async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  try {
    const pool  = await getPool();
    const role  = session.dbRole || session.role || "";
    const isAdmin = role.toLowerCase() === "admin";

    let query;
    if (isAdmin) {
      query = pool.request().query(`
        SELECT p.*, u.LoginName AS created_by_name
        FROM dbo.PatchPolicies p
        LEFT JOIN dbo.USERS u ON p.CreatedByUserID = u.UserID
        ORDER BY p.UpdatedAt DESC
      `);
    } else {
      query = pool.request()
        .input("UserID", sql.Int,          session.userId)
        .input("Role",   sql.NVarChar(200), role)
        .query(`
          SELECT p.*, u.LoginName AS created_by_name
          FROM dbo.PatchPolicies p
          LEFT JOIN dbo.USERS u ON p.CreatedByUserID = u.UserID
          WHERE p.CreatedByUserID = @UserID
             OR (p.Scope = 'public' AND (
                   p.VisibleRoles IS NULL
                   OR p.VisibleRoles = ''
                   OR p.VisibleRoles LIKE '%' + @Role + '%'
                 ))
          ORDER BY p.UpdatedAt DESC
        `);
    }

    const rs       = await query;
    const policies = rs.recordset.map(mapRow);
    res.json({ ok: true, policies, data: policies });
  } catch (e) {
    logger.error("[Policies] GET failed:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── POST /api/policies ────────────────────────────────────────────────────────
router.post("/api/policies", async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  try {
    const pool = await getPool();
    const b    = req.body;

    if (!b.policy_name?.trim())
      return res.status(400).json({ ok: false, error: "Policy name is required." });

    // Force approved_only: true on all patch definitions
    const patchDefs = (b.patch_definitions || []).map(d => ({ ...d, approved_only: true }));
    const nextRun   = computeNextRun(b.schedule);

    const result = await pool.request()
      .input("PolicyName",          sql.NVarChar(200),     b.policy_name.trim())
      .input("Description",         sql.NVarChar(sql.MAX), b.description || "")
      .input("Scope",               sql.NVarChar(20),      b.scope || "private")
      .input("VisibleRoles",        sql.NVarChar(sql.MAX), JSON.stringify(b.visible_roles || []))
      .input("Status",              sql.NVarChar(20),      "active")
      .input("PatchDefinitions",    sql.NVarChar(sql.MAX), JSON.stringify(patchDefs))
      .input("ComputerDefinitions", sql.NVarChar(sql.MAX), JSON.stringify(b.computer_definitions || []))
      .input("Schedule",            sql.NVarChar(sql.MAX), JSON.stringify(b.schedule || {}))
      .input("NextRun",             sql.DateTimeOffset,    nextRun)
      .input("CreatedByUserID",     sql.Int,               session.userId)
      .input("CreatedBy",           sql.NVarChar(128),     session.username)
      .query(`
        INSERT INTO dbo.PatchPolicies
          (PolicyName, Description, Scope, VisibleRoles, Status,
           PatchDefinitions, ComputerDefinitions, Schedule, NextRun,
           CreatedByUserID, CreatedBy, CreatedAt, UpdatedAt)
        OUTPUT INSERTED.PolicyID
        VALUES
          (@PolicyName, @Description, @Scope, @VisibleRoles, @Status,
           @PatchDefinitions, @ComputerDefinitions, @Schedule, @NextRun,
           @CreatedByUserID, @CreatedBy, SYSUTCDATETIME(), SYSUTCDATETIME())
      `);

    const policyId = result.recordset[0]?.PolicyID;
    logger.info(`[Policies] Created policy '${b.policy_name}' (id=${policyId}) by ${session.username}`);

    // Resolve patch + computer counts — await with a 5s timeout so the response
    // still includes fresh counts without blocking indefinitely.
    if (policyId) {
      try {
        await Promise.race([
          resolveAndSaveCounts(policyId, patchDefs, b.computer_definitions || [], req),
          new Promise(r => setTimeout(r, 5000)),
        ]);
      } catch { /* non-fatal */ }
    }

    res.json({ ok: true, created: true, policyId });
  } catch (e) {
    logger.error("[Policies] POST failed:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── PUT /api/policies/:id ─────────────────────────────────────────────────────
router.put("/api/policies/:id", async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  try {
    const { id } = req.params;
    const pool   = await getPool();
    const b      = req.body;

    if (!b.policy_name?.trim())
      return res.status(400).json({ ok: false, error: "Policy name is required." });

    // Ownership check (non-admins can only edit their own policies)
    const role    = session.dbRole || session.role || "";
    const isAdmin = role.toLowerCase() === "admin";
    if (!isAdmin) {
      const owns = await pool.request()
        .input("PolicyID", sql.Int, id)
        .input("UserID",   sql.Int, session.userId)
        .query("SELECT 1 FROM dbo.PatchPolicies WHERE PolicyID=@PolicyID AND CreatedByUserID=@UserID");
      if (!owns.recordset.length)
        return res.status(403).json({ ok: false, error: "You can only edit your own policies." });
    }

    // Force approved_only: true on all patch definitions
    const patchDefs = (b.patch_definitions || []).map(d => ({ ...d, approved_only: true }));
    const nextRun   = computeNextRun(b.schedule);

    await pool.request()
      .input("PolicyID",            sql.Int,               id)
      .input("PolicyName",          sql.NVarChar(200),     b.policy_name.trim())
      .input("Description",         sql.NVarChar(sql.MAX), b.description || "")
      .input("Scope",               sql.NVarChar(20),      b.scope || "private")
      .input("VisibleRoles",        sql.NVarChar(sql.MAX), JSON.stringify(b.visible_roles || []))
      .input("PatchDefinitions",    sql.NVarChar(sql.MAX), JSON.stringify(patchDefs))
      .input("ComputerDefinitions", sql.NVarChar(sql.MAX), JSON.stringify(b.computer_definitions || []))
      .input("Schedule",            sql.NVarChar(sql.MAX), JSON.stringify(b.schedule || {}))
      .input("NextRun",             sql.DateTimeOffset,    nextRun)
      .query(`
        UPDATE dbo.PatchPolicies SET
          PolicyName=@PolicyName, Description=@Description, Scope=@Scope,
          VisibleRoles=@VisibleRoles, PatchDefinitions=@PatchDefinitions,
          ComputerDefinitions=@ComputerDefinitions, Schedule=@Schedule,
          NextRun=@NextRun, UpdatedAt=SYSUTCDATETIME()
        WHERE PolicyID=@PolicyID
      `);

    logger.info(`[Policies] Updated policy ${id} by ${session.username}`);

    // Await count refresh with timeout so updated list reflects new counts
    try {
      await Promise.race([
        resolveAndSaveCounts(id, patchDefs, b.computer_definitions || [], req),
        new Promise(r => setTimeout(r, 5000)),
      ]);
    } catch { /* non-fatal */ }

    res.json({ ok: true, updated: true });
  } catch (e) {
    logger.error("[Policies] PUT failed:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── DELETE /api/policies/:id ──────────────────────────────────────────────────
router.delete("/api/policies/:id", async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  try {
    const { id }  = req.params;
    const pool    = await getPool();
    const role    = session.dbRole || session.role || "";
    const isAdmin = role.toLowerCase() === "admin";

    if (!isAdmin) {
      const owns = await pool.request()
        .input("PolicyID", sql.Int, id)
        .input("UserID",   sql.Int, session.userId)
        .query("SELECT 1 FROM dbo.PatchPolicies WHERE PolicyID=@PolicyID AND CreatedByUserID=@UserID");
      if (!owns.recordset.length)
        return res.status(403).json({ ok: false, error: "Forbidden" });
    }

    await pool.request()
      .input("PolicyID", sql.Int, id)
      .query("DELETE FROM dbo.PatchPolicies WHERE PolicyID=@PolicyID");

    logger.info(`[Policies] Deleted policy ${id} by ${session.username}`);
    res.json({ ok: true, deleted: true });
  } catch (e) {
    logger.error("[Policies] DELETE failed:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── PATCH /api/policies/:id/status ───────────────────────────────────────────
router.patch("/api/policies/:id/status", async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  try {
    const { id }     = req.params;
    const { status } = req.body;
    if (!["active","inactive"].includes(status))
      return res.status(400).json({ ok: false, error: "Invalid status." });

    const pool = await getPool();
    await pool.request()
      .input("PolicyID", sql.Int,          id)
      .input("Status",   sql.NVarChar(20), status)
      .query("UPDATE dbo.PatchPolicies SET Status=@Status, UpdatedAt=SYSUTCDATETIME() WHERE PolicyID=@PolicyID");

    res.json({ ok: true, status });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── POST /api/policies/:id/run ────────────────────────────────────────────────
// Resolves approved fixlets + target computers, then dispatches BigFix actions.
router.post("/api/policies/:id/run", async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  try {
    const { id } = req.params;
    const pool   = await getPool();

    // Fetch the policy
    const policyRes = await pool.request()
      .input("PolicyID", sql.Int, id)
      .query("SELECT * FROM dbo.PatchPolicies WHERE PolicyID=@PolicyID");

    if (!policyRes.recordset.length)
      return res.status(404).json({ ok: false, error: "Policy not found." });

    const policyRow      = policyRes.recordset[0];
    const patchDefs      = policyRow.PatchDefinitions      ? JSON.parse(policyRow.PatchDefinitions)      : [];
    const computerDefs   = policyRow.ComputerDefinitions   ? JSON.parse(policyRow.ComputerDefinitions)   : [];
    const schedule       = policyRow.Schedule              ? JSON.parse(policyRow.Schedule)              : {};

    // Mark as running
    await pool.request()
      .input("PolicyID", sql.Int, id)
      .query("UPDATE dbo.PatchPolicies SET Status='running', LastRun=SYSUTCDATETIME(), UpdatedAt=SYSUTCDATETIME() WHERE PolicyID=@PolicyID");

    logger.info(`[Policies] Run triggered for policy ${id} ('${policyRow.PolicyName}') by ${session.username}`);

    // ── Dispatch BigFix actions in the background ──────────────────────────
    dispatchBigFixActions({
      policyId:    id,
      policyName:  policyRow.PolicyName,
      patchDefs,
      computerDefs,
      schedule,
      req,
      session,
    }).catch((err) => {
      logger.error(`[Policies] BigFix dispatch failed for policy ${id}: ${err.message}`);
    });

    res.json({ ok: true, triggered: true, message: "Policy run initiated — BigFix actions will be dispatched momentarily." });
  } catch (e) {
    logger.error("[Policies] POST /run failed:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /api/policies/:id/matches ─────────────────────────────────────────────
// Returns the resolved patches + computers matching this policy's criteria.
router.get("/api/policies/:id/matches", async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  try {
    const { id } = req.params;
    const pool   = await getPool();

    const policyRes = await pool.request()
      .input("PolicyID", sql.Int, id)
      .query("SELECT PatchDefinitions, ComputerDefinitions FROM dbo.PatchPolicies WHERE PolicyID=@PolicyID");

    if (!policyRes.recordset.length)
      return res.status(404).json({ ok: false, error: "Policy not found." });

    const row          = policyRes.recordset[0];
    const patchDefs    = row.PatchDefinitions    ? JSON.parse(row.PatchDefinitions)    : [];
    const computerDefs = row.ComputerDefinitions ? JSON.parse(row.ComputerDefinitions) : [];

    // ── Resolve patches (from prism cache) ────────────────────────────────
    const allPatches = getCache("patches") || await getPatches().catch(() => []);
    const approved   = (Array.isArray(allPatches) ? allPatches : [])
      .filter(p => p.status === 1 || p.IsApproved === 1 || p.is_approved === 1);
    const patches    = matchApprovedPatches(approved, patchDefs);

    // ── Resolve computers (via BigFix API) ────────────────────────────────
    let computers = [];
    try {
      computers = await resolveComputers(computerDefs, req);
    } catch (err) {
      logger.warn(`[Policies] Computer resolution failed for policy ${id}: ${err.message}`);
    }

    // Update counts in DB
    pool.request()
      .input("PolicyID",      sql.Int, id)
      .input("PatchCount",    sql.Int, patches.length)
      .input("ComputerCount", sql.Int, computers.length)
      .query("UPDATE dbo.PatchPolicies SET PatchCount=@PatchCount, ComputerCount=@ComputerCount, UpdatedAt=SYSUTCDATETIME() WHERE PolicyID=@PolicyID")
      .catch(() => {});

    res.json({ ok: true, patches, computers, patch_count: patches.length, computer_count: computers.length });
  } catch (e) {
    logger.error("[Policies] GET /matches failed:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── POST /api/policies/refresh-counts ────────────────────────────────────────
// Refreshes PatchCount + ComputerCount for all policies (called on list refresh).
router.post("/api/policies/refresh-counts", async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  try {
    const pool = await getPool();

    const rs = await pool.request().query(`
      SELECT PolicyID, PatchDefinitions, ComputerDefinitions
      FROM dbo.PatchPolicies
    `);

    if (!rs.recordset.length) return res.json({ ok: true, updated: 0 });

    // Get approved patches from cache (fast — no remote call)
    const allPatches = getCache("patches") || await getPatches().catch(() => []);
    const approved   = (Array.isArray(allPatches) ? allPatches : [])
      .filter(p => p.status === 1 || p.IsApproved === 1 || p.is_approved === 1);

    let updated = 0;
    for (const row of rs.recordset) {
      try {
        const patchDefs    = row.PatchDefinitions    ? JSON.parse(row.PatchDefinitions)    : [];
        const computerDefs = row.ComputerDefinitions ? JSON.parse(row.ComputerDefinitions) : [];

        const patchCount = matchApprovedPatches(approved, patchDefs).length;

        // Resolve computer count (with per-policy timeout of 3s)
        let computerCount = 0;
        try {
          const computers = await Promise.race([
            resolveComputers(computerDefs, req),
            new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 3000)),
          ]);
          computerCount = computers.length;
        } catch { /* leave 0 on timeout */ }

        await pool.request()
          .input("PolicyID",      sql.Int, row.PolicyID)
          .input("PatchCount",    sql.Int, patchCount)
          .input("ComputerCount", sql.Int, computerCount)
          .query("UPDATE dbo.PatchPolicies SET PatchCount=@PatchCount, ComputerCount=@ComputerCount, UpdatedAt=SYSUTCDATETIME() WHERE PolicyID=@PolicyID");

        updated++;
      } catch { /* skip individual failures */ }
    }

    res.json({ ok: true, updated });
  } catch (e) {
    logger.error("[Policies] refresh-counts failed:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── POST /api/policies/preview-computers ─────────────────────────────────────
// Returns live preview of target computers evaluated strictly via BigFix APIs.
router.post("/api/policies/preview-computers", async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  try {
    const { computer_definitions } = req.body;
    if (!Array.isArray(computer_definitions) || computer_definitions.length === 0) {
       return res.json({ ok: true, computers: [] });
    }
    
    // Resolve computer payload hitting BigFix directly
    const computers = await resolveComputers(computer_definitions, req);
    res.json({ ok: true, computers });
  } catch (e) {
    logger.error("[Policies] preview-computers failed:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// BigFix action dispatcher
// Resolves approved fixlet IDs from patch definitions and computer IDs from
// computer definitions, then POSTs a BES action to the BigFix REST API.
// ════════════════════════════════════════════════════════════════════════════
async function dispatchBigFixActions({ policyId, policyName, patchDefs, computerDefs, schedule, req }) {
  const pool   = await getPool();
  const ctx    = getCtx();
  const { BIGFIX_BASE_URL } = ctx.bigfix;

  try {
    const bfAuthOpts = await getBfAuthContext(req, ctx);

    // 1. Resolve approved patches matching all definitions
    const allPatches = getCache("patches") || await getPatches().catch(() => []);
    const approved   = (Array.isArray(allPatches) ? allPatches : [])
      .filter(p => p.status === 1 || p.IsApproved === 1 || p.is_approved === 1);
    const matched    = matchApprovedPatches(approved, patchDefs);

    if (matched.length === 0) {
      logger.warn(`[Policies] Run ${policyId}: No approved patches matched — no actions dispatched.`);
      await pool.request()
        .input("PolicyID", sql.Int, policyId)
        .query("UPDATE dbo.PatchPolicies SET Status='active', UpdatedAt=SYSUTCDATETIME() WHERE PolicyID=@PolicyID");
      return;
    }

    // 2. Resolve target computer IDs
    const computers = await resolveComputers(computerDefs, req).catch(() => []);
    if (computers.length === 0) {
      logger.warn(`[Policies] Run ${policyId}: No target computers resolved — no actions dispatched.`);
      await pool.request()
        .input("PolicyID", sql.Int, policyId)
        .query("UPDATE dbo.PatchPolicies SET Status='active', UpdatedAt=SYSUTCDATETIME() WHERE PolicyID=@PolicyID");
      return;
    }

    const targetXml = computers.map(c => `<ComputerID>${c.id}</ComputerID>`).join("");

    // 3. Dispatch one BigFix action per matched fixlet
    const actionIds  = [];
    const actionErrors = [];

    for (const patch of matched) {
      // Each patch needs a site name + fixlet ID to build a SourcedFixletAction
      const siteName = patch.site_name || patch.SiteName || "";
      const fixletId = String(patch.patch_id || patch.id || "").replace(/^BIGFIX-/i, "");

      if (!siteName || !fixletId) continue;

      const actionTitle = `BPS_Policy_${policyId}_${fixletId}`;

      // Optional schedule end-time (default 48h window)
      const windowMs      = (schedule?.interval_hours || 48) * 3_600_000;
      const endDateOffset = msToXSDuration(windowMs);

      const xml = `<?xml version="1.0" encoding="UTF-8"?><BES xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="BES.xsd"><SourcedFixletAction><SourceFixlet><Sitename>${escapeXML(siteName)}</Sitename><FixletID>${escapeXML(fixletId)}</FixletID><Action>Action1</Action></SourceFixlet><Target>${targetXml}</Target><Settings><HasEndTime>true</HasEndTime><EndDateTimeLocalOffset>${escapeXML(endDateOffset)}</EndDateTimeLocalOffset><UseUTCTime>true</UseUTCTime></Settings><Title>${escapeXML(actionTitle)}</Title></SourcedFixletAction></BES>`;

      try {
        const bfResp = await axios.post(
          joinUrl(BIGFIX_BASE_URL, "/api/actions"),
          xml,
          { ...bfAuthOpts, headers: { "Content-Type": "text/xml" }, validateStatus: () => true, responseType: "text" }
        );

        if (bfResp.status >= 200 && bfResp.status < 300) {
          const actionId = extractActionIdFromXml(String(bfResp.data || ""));
          if (actionId) actionIds.push(actionId);
        } else {
          actionErrors.push(`Fixlet ${fixletId}: HTTP ${bfResp.status}`);
        }
      } catch (err) {
        actionErrors.push(`Fixlet ${fixletId}: ${err.message}`);
      }
    }

    logger.info(`[Policies] Run ${policyId}: dispatched ${actionIds.length} BigFix action(s). Errors: ${actionErrors.length}`);
    if (actionErrors.length) logger.warn(`[Policies] Run ${policyId} errors:`, actionErrors.join(" | "));

    // 4. Update counts + status + last_run
    await pool.request()
      .input("PolicyID",      sql.Int,           policyId)
      .input("PatchCount",    sql.Int,           matched.length)
      .input("ComputerCount", sql.Int,           computers.length)
      .query(`
        UPDATE dbo.PatchPolicies
        SET Status='active', LastRun=SYSUTCDATETIME(), UpdatedAt=SYSUTCDATETIME(),
            PatchCount=@PatchCount, ComputerCount=@ComputerCount
        WHERE PolicyID=@PolicyID
      `);

    // 5. Store action history for each dispatched action
    for (const actionId of actionIds) {
      pool.request()
        .input("ActionID",  sql.Int,           Number(actionId))
        .input("Metadata",  sql.NVarChar(sql.MAX), JSON.stringify({
          id: actionId, policyId, policyName,
          patchCount: matched.length, computerCount: computers.length,
          createdAt: new Date().toISOString(),
        }))
        .input("PostMailSent", sql.Bit, 0)
        .query(`INSERT INTO dbo.ActionHistory (ActionID, Metadata, PostMailSent, CreatedAt)
                VALUES (@ActionID, @Metadata, @PostMailSent, SYSUTCDATETIME())`)
        .catch(() => {});
    }

  } catch (err) {
    logger.error(`[Policies] dispatchBigFixActions failed for policy ${policyId}:`, err.message);
    // Reset status on failure
    pool.request()
      .input("PolicyID", sql.Int, policyId)
      .query("UPDATE dbo.PatchPolicies SET Status='active', UpdatedAt=SYSUTCDATETIME() WHERE PolicyID=@PolicyID")
      .catch(() => {});
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Resolve target computer IDs from computer_definitions via BigFix REST API
// ════════════════════════════════════════════════════════════════════════════
async function resolveComputers(computerDefs, req) {
  if (!computerDefs || computerDefs.length === 0) return [];

  const ctx        = getCtx();
  const { BIGFIX_BASE_URL } = ctx.bigfix;
  const bfAuthOpts = await getBfAuthContext(req, ctx);
  const computers  = new Map(); // id → { id, name, os, ip, group }

  for (const def of computerDefs) {
    try {
      if (def.type === "group" && def.group_id) {
        // Fetch members of a BigFix computer group by ID
        const relevance = `(id of it as string, name of it, value of result from (bes property "OS") of it | "N/A", (ip address of it as string) | "N/A") of members of bes computer groups whose (id of it = ${def.group_id})`;
        const url  = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
        const resp = await axios.get(url, { ...bfAuthOpts, headers: { Accept: "application/json" }, validateStatus: () => true });

        if (resp.status === 200 && resp.data?.result) {
          const rows = Array.isArray(resp.data.result) ? resp.data.result : [resp.data.result];
          for (const row of rows) {
            const parts = [];
            collectStrings(row, parts);
            if (parts.length >= 2) {
              const [cid, cname, cos, cip] = parts;
              if (!computers.has(cid)) {
                computers.set(cid, { id: cid, name: cname, os: cos || "", ip: cip || "", group: def.group_name || def.group_id });
              }
            }
          }
        }

      } else if (def.type === "property" && def.property_name && def.property_value) {
        // Fetch computers matching a property value
        const op     = def.property_operator || "=";
        let   filter;
        if (op === "=")          filter = `value of result from (bes property "${def.property_name}") of it = "${def.property_value}"`;
        else if (op === "!=")    filter = `value of result from (bes property "${def.property_name}") of it != "${def.property_value}"`;
        else if (op === "contains")   filter = `value of result from (bes property "${def.property_name}") of it contains "${def.property_value}"`;
        else if (op === "startswith") filter = `value of result from (bes property "${def.property_name}") of it starts with "${def.property_value}"`;
        else if (op === "endswith")   filter = `value of result from (bes property "${def.property_name}") of it ends with "${def.property_value}"`;
        else filter = `value of result from (bes property "${def.property_name}") of it = "${def.property_value}"`;

        const relevance = `(id of it as string, name of it) of bes computers whose (${filter})`;
        const url  = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
        const resp = await axios.get(url, { ...bfAuthOpts, headers: { Accept: "application/json" }, validateStatus: () => true });

        if (resp.status === 200 && resp.data?.result) {
          const rows = Array.isArray(resp.data.result) ? resp.data.result : [resp.data.result];
          for (const row of rows) {
            const parts = [];
            collectStrings(row, parts);
            if (parts.length >= 2) {
              const [cid, cname] = parts;
              if (!computers.has(cid)) {
                computers.set(cid, { id: cid, name: cname, os: "", ip: "", group: `${def.property_name} ${def.property_operator} "${def.property_value}"` });
              }
            }
          }
        }

      } else if (def.type === "name" && def.value) {
        // Fetch computers by name pattern (* wildcard)
        const pattern  = def.value.replace(/\*/g, "");
        const hasWild  = def.value.includes("*");
        const filterFn = hasWild
          ? `name of it starts with "${pattern}"`
          : `name of it = "${def.value}"`;

        const relevance = `(id of it as string, name of it) of bes computers whose (${filterFn})`;
        const url  = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
        const resp = await axios.get(url, { ...bfAuthOpts, headers: { Accept: "application/json" }, validateStatus: () => true });

        if (resp.status === 200 && resp.data?.result) {
          const rows = Array.isArray(resp.data.result) ? resp.data.result : [resp.data.result];
          for (const row of rows) {
            const parts = [];
            collectStrings(row, parts);
            if (parts.length >= 2) {
              const [cid, cname] = parts;
              if (!computers.has(cid)) {
                computers.set(cid, { id: cid, name: cname, os: "", ip: "", group: `name: ${def.value}` });
              }
            }
          }
        }
      }
    } catch (err) {
      logger.warn(`[Policies] resolveComputers def=${JSON.stringify(def)} failed: ${err.message}`);
    }
  }

  return [...computers.values()];
}

// ════════════════════════════════════════════════════════════════════════════
// Resolve and save counts for a policy (async, after save)
// ════════════════════════════════════════════════════════════════════════════
async function resolveAndSaveCounts(policyId, patchDefs, computerDefs, req) {
  const pool = await getPool();

  // Patch count (from cache — fast)
  const allPatches = getCache("patches") || await getPatches().catch(() => []);
  const approved   = (Array.isArray(allPatches) ? allPatches : [])
    .filter(p => p.status === 1 || p.IsApproved === 1 || p.is_approved === 1);
  const patchCount = matchApprovedPatches(approved, patchDefs).length;

  // Computer count (from BigFix) — resolve with timeout
  let computerCount = 0;
  try {
    const computers  = await resolveComputers(computerDefs, req);
    computerCount    = computers.length;
  } catch (e) {
    logger.warn(`[Policies] resolveAndSaveCounts: computer resolution failed for ${policyId}: ${e.message}`);
  }

  await pool.request()
    .input("PolicyID",      sql.Int, policyId)
    .input("PatchCount",    sql.Int, patchCount)
    .input("ComputerCount", sql.Int, computerCount)
    .query("UPDATE dbo.PatchPolicies SET PatchCount=@PatchCount, ComputerCount=@ComputerCount, UpdatedAt=SYSUTCDATETIME() WHERE PolicyID=@PolicyID");

  logger.info(`[Policies] Counts saved for policy ${policyId}: patches=${patchCount}, computers=${computerCount}`);
}

// ════════════════════════════════════════════════════════════════════════════
// Client-side patch matching (mirrors frontend logic)
// Only returns approved patches — approved_only is always enforced.
// ════════════════════════════════════════════════════════════════════════════
// ── Patch matching uses only fields that actually exist in Prism data ─────────
// Prism fields: patch_id, patch_name, severity, source_severity, site_name, vendor, status
// NOTE: There is NO 'category', 'source', or 'source_id' field in Prism data.
function matchApprovedPatches(approvedPatches, patchDefs) {
  if (!patchDefs || patchDefs.length === 0) return [];
  const matched = new Map();

  for (const patch of approvedPatches) {
    const name   = (patch.patch_name || "").toLowerCase();
    const sev    = (patch.severity || patch.source_severity || "").toUpperCase();
    const site   = (patch.site_name || "").toLowerCase();
    const vendor = (patch.vendor || "").toLowerCase();
    const pid    = (patch.patch_id || "").toLowerCase();

    for (const def of patchDefs) {
      let ok = true;

      // Severity filter
      if (def.severities?.length > 0) {
        const sevs = def.severities.map(s => s.toUpperCase());
        if (!sevs.includes(sev)) ok = false;
      }
      // Site filter
      if (ok && def.sites?.length > 0) {
        if (!def.sites.some(s => site.includes(s.toLowerCase()))) ok = false;
      }
      // Vendor filter (def.vendors is the new canonical key; def.sources is legacy)
      if (ok && (def.vendors?.length > 0 || def.sources?.length > 0)) {
        const vs = (def.vendors?.length > 0 ? def.vendors : def.sources);
        if (!vs.some(v => vendor.includes(v.toLowerCase()))) ok = false;
      }
      // KB / source_id match against patch_id and patch_name
      if (ok && def.source_ids) {
        const ids = def.source_ids.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
        if (ids.length > 0 && !ids.some(id => pid.includes(id) || name.includes(id))) ok = false;
      }
      // Include keywords
      if (ok && def.include_keywords) {
        const kws = def.include_keywords.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
        if (kws.length > 0 && !kws.some(k => name.includes(k))) ok = false;
      }
      // Exclude keywords
      if (ok && def.exclude_keywords) {
        const kws = def.exclude_keywords.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
        if (kws.length > 0 && kws.some(k => name.includes(k))) ok = false;
      }

      if (ok) {
        const key = patch.patch_id || name;
        if (!matched.has(key)) matched.set(key, patch);
        break;
      }
    }
  }
  return [...matched.values()];
}

// ════════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════════
function mapRow(r) {
  return {
    policy_id:            r.PolicyID,
    policy_name:          r.PolicyName,
    description:          r.Description,
    scope:                r.Scope,
    visible_roles:        r.VisibleRoles        ? JSON.parse(r.VisibleRoles)        : [],
    status:               r.Status,
    patch_definitions:    r.PatchDefinitions    ? JSON.parse(r.PatchDefinitions)    : [],
    computer_definitions: r.ComputerDefinitions ? JSON.parse(r.ComputerDefinitions) : [],
    schedule:             r.Schedule            ? JSON.parse(r.Schedule)            : null,
    schedule_info:        buildScheduleInfo(r.Schedule ? JSON.parse(r.Schedule) : null),
    patch_count:          r.PatchCount    || 0,
    computer_count:       r.ComputerCount || 0,
    last_run:             r.LastRun,
    next_run:             r.NextRun,
    created_by:           r.created_by_name || r.CreatedBy,
    created_at:           r.CreatedAt,
    updated_at:           r.UpdatedAt,
  };
}

function buildScheduleInfo(schedule) {
  if (!schedule || !schedule.enabled) return null;
  const pad = (n) => String(n).padStart(2, "0");
  const t   = `${pad(schedule.time_hour || 0)}:${pad(schedule.time_minute || 0)}`;
  const tz  = schedule.timezone || "UTC";
  const DOW = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  if (schedule.type === "weekly") {
    const days = (schedule.days_of_week || []).map((d) => DOW[d]).join(", ");
    return days ? `${days} at ${t} ${tz}` : null;
  }
  if (schedule.type === "monthly_day")  return `Day ${schedule.day_of_month} monthly at ${t} ${tz}`;
  if (schedule.type === "monthly_week") {
    const wk = ["","1st","2nd","3rd","4th","Last"][schedule.week_of_month] || "";
    const dy = DOW[schedule.weekday_of_month] || "";
    return `${wk} ${dy} monthly at ${t} ${tz}`;
  }
  if (schedule.type === "interval") return `Every ${schedule.interval_hours}h`;
  return "Scheduled";
}

function computeNextRun(schedule) {
  if (!schedule || !schedule.enabled) return null;
  try {
    const now  = new Date();
    const next = new Date(now);
    next.setHours(schedule.time_hour || 0, schedule.time_minute || 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next;
  } catch { return null; }
}

function msToXSDuration(ms) {
  if (!ms || ms <= 0) return "PT48H";
  const totalSecs = Math.floor(ms / 1000);
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  let d = "";
  if (h > 0) d += `${h}H`;
  if (m > 0) d += `${m}M`;
  if (s > 0) d += `${s}S`;
  return d ? `PT${d}` : "PT48H";
}

// ════════════════════════════════════════════════════════════════════════════
// Per-policy background refresh scheduler
// Checks every 5 minutes which policies are due for a count refresh based on
// their schedule.refresh_interval_hours setting.
// ════════════════════════════════════════════════════════════════════════════
let _schedulerStarted = false;

function startPolicyRefreshScheduler(app) {
  if (_schedulerStarted) return;
  _schedulerStarted = true;

  // Create a fake req-like object for resolveComputers (needs BigFix auth context)
  const makeFakeReq = () => ({ app, headers: {}, session: {} });

  const CHECK_INTERVAL_MS = 5 * 60 * 1000; // check every 5 minutes

  const runCheck = async () => {
    try {
      const pool = await getPool();
      const rs = await pool.request().query(`
        SELECT PolicyID, PatchDefinitions, ComputerDefinitions, Schedule, UpdatedAt
        FROM dbo.PatchPolicies
        WHERE Status != 'running'
      `);
      if (!rs.recordset.length) return;

      const allPatches = getCache("patches") || await getPatches().catch(() => []);
      const approved   = (Array.isArray(allPatches) ? allPatches : [])
        .filter(p => p.status === 1 || p.IsApproved === 1 || p.is_approved === 1);
      const now = Date.now();
      const fakeReq = makeFakeReq();

      for (const row of rs.recordset) {
        try {
          const schedule = row.Schedule ? JSON.parse(row.Schedule) : {};
          if (!schedule.refresh_enabled) continue;

          // Compute interval accurately whether using the old 'refresh_interval_hours' key 
          // or the new 'interval' type
          let intervalHours = schedule.refresh_interval_hours || 24; 
          if (schedule.refresh_type === "interval" && schedule.refresh_interval_hours) {
            intervalHours = schedule.refresh_interval_hours;
          } else if (schedule.refresh_type && schedule.refresh_type !== "interval") {
             // For advanced cron-like schedules, we simplify this script by checking daily or 
             // relying on a fully robust scheduler package. As a fallback, use 24h.
             intervalHours = 24; 
          }
          
          const intervalMs = intervalHours * 3_600_000;
          const lastUpdate = row.UpdatedAt ? new Date(row.UpdatedAt).getTime() : 0;
          if (now - lastUpdate < intervalMs) continue;

          // Due for refresh
          const patchDefs    = row.PatchDefinitions    ? JSON.parse(row.PatchDefinitions)    : [];
          const computerDefs = row.ComputerDefinitions ? JSON.parse(row.ComputerDefinitions) : [];

          logger.info(`[PolicyScheduler] Refreshing counts for policy ${row.PolicyID}`);
          await resolveAndSaveCounts(row.PolicyID, patchDefs, computerDefs, fakeReq);
        } catch (e) {
          logger.warn(`[PolicyScheduler] Refresh failed for policy ${row.PolicyID}: ${e.message}`);
        }
      }
    } catch (e) {
      logger.warn(`[PolicyScheduler] Check failed: ${e.message}`);
    }
  };

  // Run after a 30s startup delay, then every CHECK_INTERVAL_MS
  setTimeout(() => {
    runCheck();
    setInterval(runCheck, CHECK_INTERVAL_MS);
  }, 30_000);

  logger.info("[PolicyScheduler] Per-policy refresh scheduler started (checks every 5 minutes).");
}

module.exports = router;
module.exports.startPolicyRefreshScheduler = startPolicyRefreshScheduler;