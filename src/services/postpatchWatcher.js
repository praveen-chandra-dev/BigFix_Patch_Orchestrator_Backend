// src/services/postpatchWatcher.js
const axios = require("axios");
const { actionStore, CONFIG } = require("../state/store");
const { joinUrl, getBfAuthContext } = require("../utils/http");
const { parseTupleRows } = require("../utils/query");
const { sendPostPatchMail } = require("../mail/transport");
const { sql, getPool } = require("../db/mssql");

function pickTag(text, tag) {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i").exec(text);
  return m ? m[1].trim() : null;
}

function parseComputerTimes(xml) {
  return { start: pickTag(xml, "StartTime"), end: pickTag(xml, "EndTime") };
}

function parseActionXml(xml) {
  return { sitename: pickTag(xml, "Sitename"), fixletId: pickTag(xml, "FixletID"), title: pickTag(xml, "Title") };
}

function inferStageFromTitle(title) {
  if (!title) return "Baseline";
  const m = /_(Sandbox|Pilot|Production)$/i.exec(title.trim());
  return m ? (m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()) : "Baseline";
}

function inferBaselineFromTitle(title) {
  if (!title) return "(unknown)";
  return title.replace(/^BPS_/, "").replace(/_(Sandbox|Pilot|Production)$/i, "");
}

async function getActionStatusXml(bigfixCtx, id) {
  const { BIGFIX_BASE_URL } = bigfixCtx;
  const url = joinUrl(BIGFIX_BASE_URL, `/api/action/${id}/status`);
  const bfAuthOpts = await getBfAuthContext(null, { bigfix: bigfixCtx });
  const r = await axios.get(url, {
    ...bfAuthOpts, headers: { Accept: "text/xml" }, validateStatus: () => true, responseType: "text"
  });
  return { ok: r.status >= 200 && r.status < 300, text: String(r.data || "") };
}

async function fetchActionResults(bigfixCtx, id) {
  try {
    const { BIGFIX_BASE_URL } = bigfixCtx;
    const relevance = `((if exists (name of computers of it) then name of computers of it else "N/A"), (if exists (names of member actions of actions of it) then (names of member actions of actions of it) else "N/A"), (detailed status of it as string | "N/A"), (start time of it as string | "N/A"), (end time of it as string | "N/A")) of results of bes action whose (id of it = ${id})`;
    const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
    const bfAuthOpts = await getBfAuthContext(null, { bigfix: bigfixCtx });
    const resp = await axios.get(url, { ...bfAuthOpts, headers: { Accept: "application/json" } });
    if (resp.status < 200 || resp.status >= 300) return { rows: [] };
    const rows = parseTupleRows(resp.data).map(parts => ({ server: parts[0], patch: parts[1], status: parts[2], start: parts[3], end: parts[4] }));
    return { rows };
  } catch (e) { return { rows: [] }; }
}

function toResultsCSV(data) {
  if (!Array.isArray(data) || !data.length) return null;
  const headers = ["Server Name", "Patch Name", "Status", "Start Time", "End Time"];
  const escape = (val) => {
    const str = String(val ?? "N/A");
    return str.includes('"') || str.includes(',') ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const csvRows = [headers.join(",")];
  for (const row of data) csvRows.push([escape(row.server), escape(row.patch), escape(row.status), escape(row.start), escape(row.end)].join(","));
  return csvRows.join("\r\n");
}

async function markSent(id) {
  if (actionStore.actions[id]) actionStore.actions[id].postMailSent = true;
  try {
    const pool = await getPool();
    await pool.request().input('ActionID', sql.Int, Number(id)).query('UPDATE dbo.ActionHistory SET PostMailSent = 1 WHERE ActionID = @ActionID');
  } catch (dbErr) {}
}

// 🚀 1. EXACT TIME EXECUTOR (Fires exactly when window expires)
async function executeStopAndMail(ctx, id, entry) {
  if (entry.postMailSent) return;

  console.log(`\n[Scheduler] ⏳ TIME IS UP! Executing STOP for Action ${id}...`);

  // API Call to explicitly STOP the action in BigFix
  try {
    const { BIGFIX_BASE_URL } = ctx.bigfix;
    const stopUrl = joinUrl(BIGFIX_BASE_URL, `/api/action/${id}/stop`);
    const bfAuthOpts = await getBfAuthContext(null, ctx);
    await axios.post(stopUrl, "", { ...bfAuthOpts, headers: { "Content-Type": "application/xml" }, validateStatus: () => true });
    console.log(`[Scheduler] ✅ Action ${id} successfully STOPPED via API.`);
  } catch (stopErr) {
    console.warn(`[Scheduler] ⚠️ Failed to stop action ${id}:`, stopErr.message);
  }

  // Wait 5 seconds to let BigFix settle the state
  await new Promise(r => setTimeout(r, 5000));

  // Fetch Report Data ONCE for email
  const { text } = await getActionStatusXml(ctx.bigfix, id);
  const { sitename, fixletId, title } = parseActionXml(entry.xml || "");
  const times = parseComputerTimes(text || "");
  const { rows: resultRows } = await fetchActionResults(ctx.bigfix, id);
  const csvContent = toResultsCSV(resultRows);

  // Send Email
  if (entry.smtpEnabled && CONFIG.postPatchMail !== false && entry.preMail !== false) {
    try {
      await sendPostPatchMail(ctx.smtp, {
        environment: entry.stage || inferStageFromTitle(title),
        baselineName: entry.baselineName || inferBaselineFromTitle(title),
        baselineSite: sitename || entry.baselineSite || "(unknown site)",
        baselineFixletId: fixletId || entry.baselineFixletId || "(?)",
        groupName: entry.groupName || "(unknown group)",
        groupId: entry.groupId || "(?)",
        groupSite: entry.groupSite || "(?)",
        groupType: entry.groupType || "(?)",
        actionId: id,
        overallStatus: "Stopped by Schedule",
        startedAt: times.start,
        endedAt: times.end,
        SMTP_FROM: ctx.smtp.SMTP_FROM,
        SMTP_TO: ctx.smtp.SMTP_TO,
        SMTP_CC: ctx.smtp.SMTP_CC,
        SMTP_BCC: ctx.smtp.SMTP_BCC,
        csvContent: csvContent,
      });
      console.log(`[Scheduler] 📧 Report Email sent for action ${id}.`);
    } catch (mailErr) {
      console.warn(`[Scheduler] ❌ Email FAILED for action ${id}:`, mailErr.message);
    }
  }

  await markSent(id);
}

// 🚀 2. THE SCHEDULER (Sets the exact timer)
function scheduleActionStop(ctx, id, entry) {
  if (!entry || entry.postMailSent) return;

  const now = Date.now();
  const expiresAt = entry.expiresAt || now;
  const delay = expiresAt - now;

  if (delay <= 0) {
    console.log(`[Scheduler] Action ${id} time already passed. Stopping immediately.`);
    executeStopAndMail(ctx, id, entry);
  } else {
    const mins = (delay / 60000).toFixed(1);
    console.log(`[Scheduler] 🕒 Action ${id} scheduled to STOP in exactly ${mins} minutes.`);
    setTimeout(() => executeStopAndMail(ctx, id, entry), delay);
  }
}

// Load pending actions on server startup and schedule them
async function loadCacheFromDb(ctx) {
  let count = 0;
  try {
    const pool = await getPool();
    const rs = await pool.request().query('SELECT ActionID, Metadata, PostMailSent FROM dbo.ActionHistory WHERE PostMailSent = 0');
    
    for (const row of rs.recordset) {
      try {
        const metadata = JSON.parse(row.Metadata);
        actionStore.actions[row.ActionID] = { ...metadata, postMailSent: row.PostMailSent };
        
        // Re-schedule the timer (Protects against server restarts)
        scheduleActionStop(ctx, row.ActionID, actionStore.actions[row.ActionID]);
        count++;
      } catch (e) {}
    }
    if (count > 0) console.log(`[Scheduler] Restored and re-scheduled ${count} pending actions from DB.`);
  } catch (e) { console.error('[Scheduler] Failed to load from DB:', e.message); }
}

async function cleanupOldActions() {
  const retentionDays = Number(CONFIG.postpatchRetentionDays || 30);
  if (retentionDays <= 0) return;
  try {
    const pool = await getPool();
    const result = await pool.request().input('RetentionDays', sql.Int, retentionDays)
      .query(`DELETE FROM dbo.ActionHistory WHERE PostMailSent = 1 AND CreatedAt < DATEADD(day, -@RetentionDays, SYSUTCDATETIME())`);
    if (result.rowsAffected && result.rowsAffected[0] > 0) console.log(`[Scheduler] Cleanup: Deleted ${result.rowsAffected[0]} old actions.`);
  } catch (e) {}
}

function startPostPatchWatcher(ctx) {
  // ONLY run on startup. No more setInterval polling!
  loadCacheFromDb(ctx);
  setInterval(cleanupOldActions, 3_600_000); // DB Cleanup runs once an hour
}

module.exports = { startPostPatchWatcher, scheduleActionStop };