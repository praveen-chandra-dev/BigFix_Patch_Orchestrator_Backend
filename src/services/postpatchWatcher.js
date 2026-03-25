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

function parseComputerTimes(xml) { return { start: pickTag(xml, "StartTime"), end: pickTag(xml, "EndTime") }; }
function parseActionXml(xml) { return { sitename: pickTag(xml, "Sitename"), fixletId: pickTag(xml, "FixletID"), title: pickTag(xml, "Title") }; }
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
  const r = await axios.get(url, { ...bfAuthOpts, headers: { Accept: "text/xml" }, validateStatus: () => true, responseType: "text" });
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
  const escape = (val) => { const str = String(val ?? "N/A"); return str.includes('"') || str.includes(',') ? `"${str.replace(/"/g, '""')}"` : str; };
  const csvRows = [headers.join(",")];
  for (const row of data) csvRows.push([escape(row.server), escape(row.patch), escape(row.status), escape(row.start), escape(row.end)].join(","));
  return csvRows.join("\r\n");
}

// 🚀 FETCH PATCH CONTENT QUERY
async function fetchBaselinePatches(bigfixCtx, baselineName, bfAuthOpts) {
  try {
    const { BIGFIX_BASE_URL } = bigfixCtx;
    const relevance = `((name of it | "N/A"), (source severity of it | "N/A"), (cve id list of it | "N/A"), (source of it | "N/A")) of source fixlets of components of component groups of bes fixlets whose (name of it as lowercase = "${String(baselineName).toLowerCase().replace(/"/g, '\\"')}")`;
    const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
    const resp = await axios.get(url, { ...bfAuthOpts, headers: { Accept: "application/json" } });
    if (resp.status >= 200 && resp.status < 300) {
        const rows = parseTupleRows(resp.data);
        return rows.map(r => ({ name: r[0], severity: r[1], cves: r[2], source: r[3] }));
    }
  } catch (e) { }
  return [];
}

function patchesToCSV(patches) {
  if (!patches || !patches.length) return null;
  const escape = (v) => `"${String(v || "").replace(/"/g, '""')}"`;
  const lines = ["Patch Name,Severity,CVEs,Source"];
  for (const p of patches) { lines.push(`${escape(p.name)},${escape(p.severity)},${escape(p.cves)},${escape(p.source)}`); }
  return lines.join("\r\n");
}

async function markSent(id) {
  if (actionStore.actions[id]) actionStore.actions[id].postMailSent = true;
  try {
    const pool = await getPool();
    await pool.request().input('ActionID', sql.Int, Number(id)).query('UPDATE dbo.ActionHistory SET PostMailSent = 1 WHERE ActionID = @ActionID');
  } catch (dbErr) {}
}

async function triggerEarlyStop(ctx, id, reason) {
  const entry = actionStore.actions[id];
  if (entry && !entry.postMailSent) { await executeStopAndMail(ctx, id, entry, reason, true); }
}

async function executeStopAndMail(ctx, id, entry, reason = "Stopped by Schedule", skipStop = false) {
  if (entry.postMailSent) return;
  entry.postMailSent = true; 
  if (entry.timerId) clearTimeout(entry.timerId); 

  console.log(`\n[Scheduler] ⏳ Executing post-patch tasks for Action ${id}. Reason: ${reason}`);

  if (!skipStop) {
    try {
      const { BIGFIX_BASE_URL } = ctx.bigfix;
      const stopUrl = joinUrl(BIGFIX_BASE_URL, `/api/action/${id}/stop`);
      const bfAuthOpts = await getBfAuthContext(null, ctx);
      await axios.post(stopUrl, "", { ...bfAuthOpts, headers: { "Content-Type": "application/xml" }, validateStatus: () => true });
      console.log(`[Scheduler] ✅ Action ${id} successfully STOPPED via API.`);
    } catch (stopErr) { console.warn(`[Scheduler] ⚠️ Failed to stop action ${id}:`, stopErr.message); }
    await new Promise(r => setTimeout(r, 5000));
  }

  const { text } = await getActionStatusXml(ctx.bigfix, id);
  const { sitename, fixletId, title } = parseActionXml(entry.xml || "");
  const times = parseComputerTimes(text || "");
  const { rows: resultRows } = await fetchActionResults(ctx.bigfix, id);
  const csvContent = toResultsCSV(resultRows);

  if (entry.smtpEnabled) {
    try {
      const bfAuthOpts = await getBfAuthContext(null, ctx);
      const baselineNameParsed = entry.baselineName || inferBaselineFromTitle(title);
      const baselinePatches = await fetchBaselinePatches(ctx.bigfix, baselineNameParsed, bfAuthOpts);
      const patchesCsvContent = patchesToCSV(baselinePatches);

      await sendPostPatchMail(ctx.smtp, {
        environment: entry.stage || inferStageFromTitle(title),
        baselineName: baselineNameParsed,
        baselineSite: sitename || entry.baselineSite || "(unknown site)",
        baselineFixletId: fixletId || entry.baselineFixletId || "(?)",
        groupName: entry.groupName || "(unknown group)",
        groupId: entry.groupId || "(?)",
        groupSite: entry.groupSite || "(?)",
        groupType: entry.groupType || "(?)",
        actionId: id, overallStatus: reason, startedAt: times.start, endedAt: times.end,
        SMTP_FROM: ctx.smtp.SMTP_FROM, SMTP_TO: ctx.smtp.SMTP_TO, SMTP_CC: ctx.smtp.SMTP_CC, SMTP_BCC: ctx.smtp.SMTP_BCC,
        csvContent, patchesCsvContent, baselinePatches
      });
      console.log(`[Scheduler] 📧 Report Email sent for action ${id}.`);
    } catch (mailErr) { console.warn(`[Scheduler] ❌ Email FAILED for action ${id}:`, mailErr.message); }
  } else { console.warn(`[Scheduler] ⚠️ Post-patch email skipped for action ${id}. SMTP is not enabled/configured.`); }

  await markSent(id);
}

function scheduleActionStop(ctx, id, entry) {
  if (!entry || entry.postMailSent) return;
  const now = Date.now(); const expiresAt = entry.expiresAt || now; const delay = expiresAt - now;

  if (delay <= 0) {
    console.log(`[Scheduler] Action ${id} time already passed. Stopping immediately.`);
    executeStopAndMail(ctx, id, entry, "Stopped by Schedule", false);
  } else {
    const mins = (delay / 60000).toFixed(1);
    console.log(`[Scheduler] 🕒 Action ${id} scheduled to STOP in exactly ${mins} minutes.`);
    entry.timerId = setTimeout(() => { executeStopAndMail(ctx, id, entry, "Stopped by Schedule", false); }, delay);
  }
}

async function pollActiveActions(ctx) {
  for (const id of Object.keys(actionStore.actions)) {
    const entry = actionStore.actions[id];
    if (entry.postMailSent) continue;
    
    try {
      const { ok, text } = await getActionStatusXml(ctx.bigfix, id);
      if (ok) {
        const state = (pickTag(text, "Status") || "").toLowerCase();
        if (state === "stopped" || state === "expired") {
          const reason = state === "stopped" ? "Stopped Manually (Console)" : "Expired";
          console.log(`[Watcher] Background check found ${id} as ${state}. Triggering early stop.`);
          await triggerEarlyStop(ctx, id, reason);
        }
      }
    } catch(e) {}
  }
}

async function loadCacheFromDb(ctx) {
  let count = 0;
  try {
    const pool = await getPool();
    const rs = await pool.request().query('SELECT ActionID, Metadata, PostMailSent FROM dbo.ActionHistory WHERE PostMailSent = 0');
    for (const row of rs.recordset) {
      try {
        const metadata = JSON.parse(row.Metadata);
        actionStore.actions[row.ActionID] = { ...metadata, postMailSent: row.PostMailSent };
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
    const result = await pool.request().input('RetentionDays', sql.Int, retentionDays).query(`DELETE FROM dbo.ActionHistory WHERE PostMailSent = 1 AND CreatedAt < DATEADD(day, -@RetentionDays, SYSUTCDATETIME())`);
    if (result.rowsAffected && result.rowsAffected[0] > 0) console.log(`[Scheduler] Cleanup: Deleted ${result.rowsAffected[0]} old actions.`);
  } catch (e) {}
}

function startPostPatchWatcher(ctx) {
  loadCacheFromDb(ctx);
  setInterval(cleanupOldActions, 3_600_000); 
  setInterval(() => pollActiveActions(ctx), 5 * 60 * 1000); 
}

module.exports = { startPostPatchWatcher, scheduleActionStop, triggerEarlyStop };