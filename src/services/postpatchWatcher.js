// src/services/postpatchWatcher.js
const axios = require("axios");
const { actionStore, CONFIG } = require("../state/store"); // <-- Reads from CONFIG
const { joinUrl } = require("../utils/http");
const { collectStrings, parseTupleRows } = require("../utils/query");
const { sendPostPatchMail } = require("../mail/transport");
const { sql, getPool } = require("../db/mssql"); // <-- NEW: Import SQL helpers

/* -------------------- tiny XML helpers -------------------- */
function pickTag(text, tag) {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i").exec(text);
  return m ? m[1].trim() : null;
}
const pickStatusTop = (xml) => pickTag(xml, "Status");
function parseComputerTimes(xml) {
  return {
    start: pickTag(xml, "StartTime"),
    end: pickTag(xml, "EndTime"),
  };
}

/* -------- parse details back from stored Action XML -------- */
function parseActionXml(xml) {
  const sitename = pickTag(xml, "Sitename");
  const fixletId = pickTag(xml, "FixletID");
  const title    = pickTag(xml, "Title");
  return { sitename, fixletId, title };
}

function inferStageFromTitle(title) {
  if (!title) return "Baseline";
  const m = /_(Sandbox|Pilot|Production)$/i.exec(title.trim());
  return m ? (m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()) : "Baseline";
}
function inferBaselineFromTitle(title) {
  if (!title) return "(unknown)";
  // BPS_<BaselineName>_<Stage>
  return title.replace(/^BPS_/, "").replace(/_(Sandbox|Pilot|Production)$/i, "");
}

/* ---------------------- BF helpers ------------------------ */
async function getActionStatusXml(bigfixCtx, id) {
  const { BIGFIX_BASE_URL, BIGFIX_USER, BIGFIX_PASS, httpsAgent } = bigfixCtx;
  const url = joinUrl(BIGFIX_BASE_URL, `/api/action/${id}/status`);
  const r = await axios.get(url, {
    httpsAgent,
    auth: { username: BIGFIX_USER, password: BIGFIX_PASS },
    headers: { Accept: "text/xml" },
    timeout: 60_000,
    validateStatus: () => true,
    responseType: "text",
  });
  return { ok: r.status >= 200 && r.status < 300, text: String(r.data || "") };
}


/**
 * NEW: Fetches full action results using relevance from actionHelpers.js
 */
async function fetchActionResults(bigfixCtx, id) {
  const { BIGFIX_BASE_URL, BIGFIX_USER, BIGFIX_PASS, httpsAgent } = bigfixCtx;
  try {
    const relevance =
      `((if exists (name of computers of it) then name of computers of it else "N/A"),` +
      ` (if exists (names of member actions of actions of it) then (names of member actions of actions of it) else "N/A"),` +
      ` (detailed status of it as string | "N/A"),` +
      ` (start time of it as string | "N/A"),` +
      ` (end time of it as string | "N/A")) of results of bes action whose (id of it = ${id})`;

    const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
    
    const resp = await axios.get(url, {
      httpsAgent,
      auth: { username: BIGFIX_USER, password: BIGFIX_PASS },
      headers: { Accept: "application/json" },
      responseType: "json",
      timeout: 60_000,
      validateStatus: () => true,
    });

    if (resp.status < 200 || resp.status >= 300) {
      return { rows: [] }; // Don't fail the whole watcher
    }

    const rows = parseTupleRows(resp.data).map(parts => {
      const [server, patch, status, start, end] = parts;
      return { server, patch, status, start, end };
    });
    
    return { rows };

  } catch (e) {
    console.warn(`[postpatch] Failed to fetch results for action ${id}:`, e.message);
    return { rows: [] };
  }
}

/**
 * NEW: Converts an array of result objects to CSV
 */
function toResultsCSV(data) {
  if (!Array.isArray(data) || !data.length) return null;
  
  const headers = ["Server Name", "Patch Name", "Status", "Start Time", "End Time"];
  const escape = (val) => {
    const str = String(val ?? "N/A");
    if (str.includes('"') || str.includes(',')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };
  
  const csvRows = [headers.join(",")];
  for (const row of data) {
    csvRows.push([
      escape(row.server),
      escape(row.patch),
      escape(row.status),
      escape(row.start),
      escape(row.end),
    ].join(","));
  }
  
  return csvRows.join("\r\n");
}


/* ------------------- single-send guards ------------------- */
function shouldSend(entry) {
  // NEW: Read from dynamic CONFIG object
  if (!CONFIG.postPatchMail) return false;
  if (!entry) return false;
  if (entry.postMailSent) return false;
  return true;
}

/**
 * NEW: Mark as sent in both cache and database
 */
async function markSent(id) {
  // 1. Update cache (the in-memory "app data folder")
  if (actionStore.actions[id]) {
    actionStore.actions[id].postMailSent = true;
  }
  
  // 2. Update Database
  try {
    const pool = await getPool();
    await pool.request()
      .input('ActionID', sql.Int, Number(id))
      .query('UPDATE dbo.ActionHistory SET PostMailSent = 1 WHERE ActionID = @ActionID');
    console.log(`[postpatch] Marked action ${id} as sent in DB.`);
  } catch (dbErr) {
    console.warn(`[postpatch] FAILED to mark action ${id} in DB:`, dbErr.message);
  }
}

/* ---------------------- watcher loop ---------------------- */

/**
 * NEW: Load all non-completed actions from DB into the in-memory cache
 */
async function loadCacheFromDb() {
  let count = 0;
  try {
    const pool = await getPool();
    const rs = await pool.request()
      .query('SELECT ActionID, Metadata, PostMailSent FROM dbo.ActionHistory WHERE PostMailSent = 0');
    
    for (const row of rs.recordset) {
      try {
        const metadata = JSON.parse(row.Metadata);
        // Ensure cache entry has the *correct* DB state
        actionStore.actions[row.ActionID] = {
          ...metadata,
          postMailSent: row.PostMailSent, // This will be `false` based on the query
        };
        count++;
      } catch (parseErr) {
        console.warn(`[postpatch] Failed to parse metadata for ActionID ${row.ActionID}:`, parseErr.message);
      }
    }
    if (count > 0) {
      console.log(`[postpatch] Loaded ${count} pending actions from DB into cache.`);
    } else {
      console.log(`[postpatch] No pending actions found in DB.`);
    }
  } catch (dbErr) {
    console.error('[postpatch] CRITICAL: Failed to load action history from DB:', dbErr.message);
    console.error('[postpatch] This may be because the dbo.ActionHistory table does not exist. Please run the SQL script.');
  }
}

/**
 * NEW: Auto-cleanup old, completed actions from the database
 */
async function cleanupOldActions() {
  // NEW: Read retention days from the dynamic CONFIG
  const retentionDays = Number(CONFIG.postpatchRetentionDays || 30);
  if (retentionDays <= 0) {
    // A value of 0 means "keep forever"
    console.log(`[postpatch] Cleanup: Retention is set to ${retentionDays} days, skipping cleanup.`);
    return;
  }

  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('RetentionDays', sql.Int, retentionDays)
      .query(`
        DELETE FROM dbo.ActionHistory 
        WHERE PostMailSent = 1 
        AND CreatedAt < DATEADD(day, -@RetentionDays, SYSUTCDATETIME())
      `);
    
    const rowsAffected = result.rowsAffected ? result.rowsAffected[0] : 0;
    if (rowsAffected > 0) {
      console.log(`[postpatch] Cleanup: Deleted ${rowsAffected} completed actions older than ${retentionDays} days.`);
    } else {
      console.log(`[postpatch] Cleanup: No completed actions found older than ${retentionDays} days.`);
    }
  } catch (dbErr) {
    console.warn(`[postpatch] Cleanup failed:`, dbErr.message);
  }
}


function startPostPatchWatcher(ctx, { intervalMs = 60_000 } = {}) {
  const safeLog = (...a) => { try { console.log(...a); } catch {} };

  const tick = async () => {
    try {
      const ids = Object.keys(actionStore.actions || {});
      if (!ids.length) return;

      for (const id of ids) {
        const entry = actionStore.actions[id];
        if (!shouldSend(entry)) continue;

        const { ok, text } = await getActionStatusXml(ctx.bigfix, id);
        if (!ok || !text) continue;

        const overall = (pickStatusTop(text) || "").toLowerCase();
        if (overall !== "expired") continue; // only when window ended

        // Parse minimal info from stored XML
        const { sitename, fixletId, title } = parseActionXml(entry.xml || "");
        const times        = parseComputerTimes(text); // Get start/end from status XML

        // FIX: Get info directly from the stored action entry
        // Yeh "unknown group" issue ko fix karega
        const stage        = entry.stage || inferStageFromTitle(title);
        const baselineName = entry.baselineName || inferBaselineFromTitle(title);
        const groupName    = entry.groupName || "(unknown group)";
        const groupId      = entry.groupId || "(?)";
        const groupSite    = entry.groupSite || "(?)";
        const groupType    = entry.groupType || "(?)";

        // FIX: Fetch full results and generate CSV
        const { rows: resultRows } = await fetchActionResults(ctx.bigfix, id);
        const csvContent = toResultsCSV(resultRows);
        
        // Send mail
        await sendPostPatchMail(ctx.smtp, {
          environment: stage,
          baselineName,
          baselineSite: sitename || entry.baselineSite || "(unknown site)",
          baselineFixletId: fixletId || entry.baselineFixletId || "(?)",
          groupName: groupName,
          groupId: groupId,
          groupSite: groupSite,
          groupType: groupType,
          actionId: id,
          overallStatus: "Expired",
          startedAt: times.start,
          endedAt: times.end,
          SMTP_FROM: ctx.smtp.SMTP_FROM,
          SMTP_TO:   ctx.smtp.SMTP_TO,
          SMTP_CC:   ctx.smtp.SMTP_CC,
          SMTP_BCC:  ctx.smtp.SMTP_BCC,
          csvContent: csvContent, // Pass the new results CSV
        });

        // mark FIRST, then log
        await markSent(id); // <-- NEW: Now an async function
        safeLog(`[postpatch] mailed once for action ${id} (Expired) with ${resultRows.length} results.`);
      }
    } catch (e) {
      // keep silent & continue next tick
      console.warn("[postpatch] watcher error:", e?.message || e);
    }
  };

  // --- NEW: Load cache from DB on startup ---
  // We wait for the initial load to complete before starting the timer
  loadCacheFromDb().finally(() => {
    // Start polling *after* initial load finishes (or fails)
    const handle = setInterval(tick, Math.max(10_000, Number(intervalMs) || 60_000));
    safeLog(`[postpatch] Watcher service started. Polling every ${intervalMs}ms.`);
    
    // --- NEW: Run cleanup once on start, then hourly ---
    const cleanupIntervalMs = 3_600_000; // 1 hour
    cleanupOldActions(); // Run once on start
    setInterval(cleanupOldActions, cleanupIntervalMs);
    safeLog(`[postpatch] Cleanup service started. Running every ${cleanupIntervalMs}ms.`);
    // ----------------------------------------------------
  });
  // ------------------------------------------
}

module.exports = { startPostPatchWatcher };