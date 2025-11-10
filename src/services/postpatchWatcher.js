// src/services/postpatchWatcher.js
const axios = require("axios");
const { actionStore, CONFIG } = require("../state/store");
const { joinUrl } = require("../utils/http");
const { collectStrings, parseTupleRows } = require("../utils/query");
const { sendPostPatchMail } = require("../mail/transport");

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
// FIX: Is function ki ab zaroorat nahi hai group info ke liye,
// lekin baaki details (sitename, fixletId) ke liye rakhenge.
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

// FIX: 'resolveGroupInfo' function ab use nahi ho raha hai,
// kyunki hum stored info use kar rahe hain.

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
  if (!CONFIG.postPatchMail) return false;
  if (!entry) return false;
  if (entry.postMailSent) return false;
  return true;
}
function markSent(id) {
  if (actionStore.actions[id]) actionStore.actions[id].postMailSent = true;
}

/* ---------------------- watcher loop ---------------------- */
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
        markSent(id);
        safeLog(`[postpatch] mailed once for action ${id} (Expired) with ${resultRows.length} results.`);
      }
    } catch (e) {
      // keep silent & continue next tick
      console.warn("[postpatch] watcher error:", e?.message || e);
    }
  };

  const handle = setInterval(tick, Math.max(10_000, Number(intervalMs) || 60_000));
  safeLog(`[postpatch] Watcher service started. Polling every ${intervalMs}ms.`);
  return () => clearInterval(handle);
}

module.exports = { startPostPatchWatcher };