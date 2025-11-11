// src/routes/pilot.js
const https = require("https");
const axios = require("axios");
const { joinUrl, toLowerSafe } = require("../utils/http");
const { collectStrings, extractActionIdFromXml } = require("../utils/query");
const { actionStore } = require("../state/store");
const { logFactory } = require("../utils/log");
const { sendTriggerMail } = require("../mail/transport");
const { sql, getPool } = require("../db/mssql"); // <-- NEW: Import SQL

// --- CSV helper ---
// ... (existing code, no changes) ...
function toCSV(serverList) {
  if (!serverList || serverList.length === 0) return null;
  const header = "ServerName";
  const rows = serverList.map(name => `"${String(name).replace(/"/g, '""')}"`);
  return [header, ...rows].join("\r\n");
}

/* ---------------- Time helpers (same as actions.js) ---------------- */
// ... (existing code, no changes) ...
function getPatchWindowMs(patchWindow) {
  if (patchWindow && typeof patchWindow === "object") {
    const d = Number(patchWindow.days) || 0;
// ... (existing code, no changes) ...
    const h = Number(patchWindow.hours) || 0;
    const m = Number(patchWindow.minutes) || 0;
    return d * 86400000 + h * 3600000 + m * 60000;
  }
// ... (existing code, no changes) ...
  const legacyHours = Number(patchWindow);
  if (Number.isFinite(legacyHours) && legacyHours > 0) {
    return legacyHours * 3600000;
  }
// ... (existing code, no changes) ...
  return 0;
}
function msToXSDuration(ms) {
  if (!Number.isFinite(ms) || ms === 0) return "PT0S";
// ... (existing code, no changes) ...
  const neg = ms < 0;
  let t = Math.abs(ms);
  const totalSeconds = Math.floor(t / 1000);
// ... (existing code, no changes) ...
  const days = Math.floor(totalSeconds / 86400);
  let rem = totalSeconds % 86400;
  const hours = Math.floor(rem / 3600);
  rem = rem % 3600;
// ... (existing code, no changes) ...
  const minutes = Math.floor(rem / 60);
  const seconds = rem % 60;
  let out = "";
// ... (existing code, no changes) ...
  if (days) out += `${days}D`;
  const timeParts = [];
  if (hours) timeParts.push(`${hours}H`);
  if (minutes) timeParts.push(`${minutes}M`);
// ... (existing code, no changes) ...
  if (seconds) timeParts.push(`${seconds}S`);
  if (timeParts.length) out += `T${timeParts.join("")}`;
  else if (!days) out = "T0S";
// ... (existing code, no changes) ...
  return (neg ? "-" : "") + "P" + out;
}
function localUtcOffsetMs() {
  const offsetMin = new Date().getTimezoneOffset(); // IST => -330
// ... (existing code, no changes) ...
  return -offsetMin * 60000; // => +19800000
}

async function validateChangeNumber(number, ctx) {
// ... (existing code, no changes) ...
  const { SN_URL, SN_USER, SN_PASSWORD, SN_ALLOW_SELF_SIGNED } = ctx.servicenow;
  let snBase = (SN_URL || "").replace(/\/+$/, "");
  if (/\/api\/now$/i.test(snBase)) snBase = snBase.replace(/\/api\/now$/i, "");
// ... (existing code, no changes) ...
  if (!snBase || !SN_USER || !SN_PASSWORD) {
    return { ok: false, code: "CONFIG", message: "ServiceNow env not configured" };
  }
  const endpoint =
// ... (existing code, no changes) ...
    `${snBase}/api/now/table/change_request` +
    `?sysparm_query=number=${encodeURIComponent(number)}` +
    `&sysparm_fields=sys_id,number,state,stage,approval,work_start,work_end` +
// ... (existing code, no changes) ...
    `&sysparm_display_value=true`;
  const agent = new https.Agent({ rejectUnauthorized: !(String(SN_ALLOW_SELF_SIGNED).toLowerCase() === "true") });
  const resp = await axios.get(endpoint, {
// ... (existing code, no changes) ...
    httpsAgent: agent,
    auth: { username: SN_USER, password: SN_PASSWORD },
    headers: { Accept: "application/json" },
// ... (existing code, no changes) ...
    timeout: 30000,
    validateStatus: () => true,
  });
  if (resp.status === 401 || resp.status === 403) {
// ... (existing code, no changes) ...
    return { ok: false, code: "NOT_FOUND_OR_FORBIDDEN", message: "Change Request doesn't exist or user doesn't have required privileges." };
  }
  let result = resp?.data?.result;
  if (Array.isArray(result)) { /* ok */ }
// ... (existing code, no changes) ...
  else if (result && typeof result === "object") { result = [result]; }
  else { result = []; }
  if (result.length === 0) {
    return { ok: false, code: "NOT_FOUND_OR_FORBIDDEN", message: "Change Request doesn't exist or user doesn't have required privileges." };
// ... (existing code, no changes) ...
  }
  const rec = result[0] || {};
  const state = String(rec.state || "").trim();
  const isImplement = /^implement$/i.test(state);
// ... (existing code, no changes) ...
  if (!isImplement) {
    return { ok: false, code: "NOT_IMPLEMENT", message: "Change Request is not at Implement stage.", record: rec };
  }
  return { ok: true, exists: true, implement: true, record: rec };
// ... (existing code, no changes) ...
}

async function triggerBaselineAction(req, ctx, {
  baselineName,
// ... (existing code, no changes) ...
  groupName,
  autoMail,
  mailTo,
// ... (existing code, no changes) ...
  mailFrom,
  mailCc,
  mailBcc,
// ... (existing code, no changes) ...
  environment,
  endOffset,
}) {
  const { BIGFIX_BASE_URL, BIGFIX_USER, BIGFIX_PASS, httpsAgent } = ctx.bigfix;
// ... (existing code, no changes) ...
  const log = logFactory(ctx.DEBUG_LOG);
  let csvContent = null;

  // 1) Baseline lookup
// ... (existing code, no changes) ...
  const qBaseline = `(name of site of it, id of it) of bes baseline whose (name of it is "${baselineName.replace(/"/g, '\\"')}")`;
  const urlBaseline = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(qBaseline)}`;
  log(req, "Baseline lookup →", urlBaseline);
// ... (existing code, no changes) ...
  const baselineResp = await axios.get(urlBaseline, {
    httpsAgent,
    auth: { username: BIGFIX_USER, password: BIGFIX_PASS },
// ... (existing code, no changes) ...
    headers: { Accept: "application/json" },
    responseType: "json",
    timeout: 60_000,
// ... (existing code, no changes) ...
    validateStatus: () => true
  });
  log(req, "Baseline lookup ←", baselineResp.status);
  if (baselineResp.status < 200 || baselineResp.status >= 300) throw new Error(`Baseline lookup failed: HTTP ${baselineResp.status}`);
// ... (existing code, no changes) ...
  const baselineRows = Array.isArray(baselineResp.data?.result) ? baselineResp.data.result : [];
  if (!baselineRows.length) throw new Error(`Baseline not found: ${baselineName}`);
  const partsB = []; collectStrings(baselineRows[0], partsB);
  if (partsB.length < 2) throw new Error("Unexpected baseline query shape");
// ... (existing code, no changes) ...
  const siteName = partsB[0]; const fixletId = partsB[1];

  // 2) Group lookup
  const qGroup = `(name of it, id of it, name of site of it, (if automatic flag of it then "Automatic" else if manual flag of it then "manual" else "server based")) of bes computer group whose (name of it is "${groupName.replace(/"/g, '\\"')}")`;
// ... (existing code, no changes) ...
  const urlGroup = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(qGroup)}`;
  log(req, "Group lookup →", urlGroup);
  const groupResp = await axios.get(urlGroup, {
// ... (existing code, no changes) ...
    httpsAgent,
    auth: { username: BIGFIX_USER, password: BIGFIX_PASS },
    headers: { Accept: "application/json" },
// ... (existing code, no changes) ...
    responseType: "json",
    timeout: 60_000,
    validateStatus: () => true
// ... (existing code, no changes) ...
  });
  log(req, "Group lookup ←", groupResp.status);
  if (groupResp.status < 200 || groupResp.status >= 300) throw new Error(`Group lookup failed: HTTP ${groupResp.status}`);
  const groupRows = Array.isArray(groupResp.data?.result) ? groupResp.data.result : [];
// ... (existing code, no changes) ...
  if (!groupRows.length) throw new Error(`Group not found: ${groupName}`);
  const partsG = []; collectStrings(groupRows[0], partsG);
  if (partsG.length < 4) throw new Error("Unexpected group query shape");
// ... (existing code, no changes) ...
  const gName = partsG[0], gId = partsG[1], gSite = partsG[2], gType = partsG[3];

  // 3) Attach CSV (optional)
  if (autoMail) {
// ... (existing code, no changes) ...
    try {
      const qServers = `names of members of bes computer group whose (id of it = ${gId})`;
      const urlServers = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(qServers)}`;
// ... (existing code, no changes) ...
      log(req, "Server list lookup →", urlServers);
      const serversResp = await axios.get(urlServers, {
        httpsAgent,
// ... (existing code, no changes) ...
        auth: { username: BIGFIX_USER, password: BIGFIX_PASS },
        headers: { Accept: "application/json" },
        responseType: "json",
// ... (existing code, no changes) ...
        timeout: 60_000,
        validateStatus: () => true,
      });
      if (serversResp.status === 200) {
// ... (existing code, no changes) ...
        const serverNames = Array.isArray(serversResp.data?.result) ? serversResp.data.result : [];
        csvContent = toCSV(serverNames);
        log(req, `Found ${serverNames.length} servers for CSV attachment.`);
// ... (existing code, no changes) ...
      } else {
        log(req, "Could not fetch server list for CSV:", serversResp.status);
      }
    } catch (e) {
// ... (existing code, no changes) ...
      log(req, "Failed to query server list for CSV:", e.message);
    }
  }

  // 4) Relevance
// ... (existing code, no changes) ...
  const type = toLowerSafe(gType);
  const siteTokenForAutomatic = gSite === "ActionSite" ? `site "actionsite"` : `site "CustomSite_${gSite}"`;
  let customRelevance = "";
// ... (existing code, no changes) ...
  if (type.includes("automatic")) {
    customRelevance = `exists true whose ( if true then ( member of group ${gId} of ${siteTokenForAutomatic} ) else false)`;
  } else if (type.includes("manual")) {
// ... (existing code, no changes) ...
    customRelevance = `exists true whose ( if true then ( member of manual group "${gName}" of client ) else false)`;
  } else {
    customRelevance = `exists true whose ( if true then ( member of server based group "${gName}" of client ) else false)`;
// ... (existing code, no changes) ...
  }

  // 5) XML Body
  const stageName = environment || "Pilot";
// ... (existing code, no changes) ...
  const actionTitle = `BPS_${baselineName}_${stageName}`;
  const xmlOffset = endOffset || "P2D";
  const xmlEscape = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const xml =
// ... (existing code, no changes) ...
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<BES xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="BES.xsd">` +
    `  <SourcedFixletAction>` +
// ... (existing code, no changes) ...
    `    <SourceFixlet>` +
    `      <Sitename>${xmlEscape(siteName)}</Sitename>` +
    `      <FixletID>${xmlEscape(fixletId)}</FixletID>` +
// ... (existing code, no changes) ...
    `      <Action>Action1</Action>` +
    `    </SourceFixlet>` +
    `    <Target>` +
// ... (existing code, no changes) ...
    `      <CustomRelevance>${xmlEscape(customRelevance)}</CustomRelevance>` +
    `    </Target>` +
    `    <Settings>` +
// ... (existing code, no changes) ...
    `      <HasEndTime>true</HasEndTime>` +
    `      <EndDateTimeLocalOffset>${xmlEscape(xmlOffset)}</EndDateTimeLocalOffset>` +
    `      <UseUTCTime>true</UseUTCTime>` +
// ... (existing code, no changes) ...
    `    </Settings>` +
    `    <Title>${xmlEscape(actionTitle)}</Title>` +
    `  </SourcedFixletAction>` +
// ... (existing code, no changes) ...
    `</BES>`;

  // 6) Post to BigFix
  const bfPostUrl = joinUrl(BIGFIX_BASE_URL, "/api/actions");
// ... (existing code, no changes) ...
  log(req, `BF POST → ${bfPostUrl} body=${xml.length} chars`);
  const bfResp = await axios.post(bfPostUrl, xml, {
    httpsAgent,
// ... (existing code, no changes) ...
    auth: { username: BIGFIX_USER, password: BIGFIX_PASS },
    headers: { "Content-Type": "text/xml" },
    timeout: 60_000,
// ... (existing code, no changes) ...
    validateStatus: () => true,
    responseType: "text",
  });
  log(req, `BF POST ← ${bfResp.status}`);
// ... (existing code, no changes) ...
  if (bfResp.status < 200 || bfResp.status >= 300) throw new Error(`BigFix POST failed: HTTP ${bfResp.status} ${String(bfResp.data).slice(0, 200)}`);

  const actionId = extractActionIdFromXml(String(bfResp.data || ""));
  
  // --- NEW: Save to both Cache and DB ---
  if (actionId) {
    const metadata = {
      id: actionId,
      createdAt: new Date().toISOString(),
      stage: stageName,
      xml,
      baselineName,
      baselineSite: siteName,
      baselineFixletId: fixletId,
      groupName: gName,
      groupId: gId,
      groupSite: gSite,
      groupType: gType,
      endOffset: xmlOffset,
      preMail: !!autoMail,
      postMailSent: false,
    };

    // 1. Save to in-memory cache (actionStore)
    actionStore.lastActionId = actionId;
    actionStore.actions[actionId] = metadata;

    // 2. Save to persistent database
    try {
      const pool = await getPool();
      await pool.request()
        .input('ActionID', sql.Int, Number(actionId))
        .input('Metadata', sql.NVarChar(sql.MAX), JSON.stringify(metadata))
        .input('PostMailSent', sql.Bit, 0)
        .query(`
          INSERT INTO dbo.ActionHistory (ActionID, Metadata, PostMailSent, CreatedAt)
          VALUES (@ActionID, @Metadata, @PostMailSent, SYSUTCDATETIME())
        `);
      log(req, `[${stageName}] Action ${actionId} saved to DB.`);
    } catch (dbErr) {
      // Log DB error, but don't fail the request
      log(req, `[${stageName}] FAILED to save Action ${actionId} to DB:`, dbErr.message);
    }
  }
  // --- End NEW ---

  // 7) Email (pre-patch)
  if (autoMail) {
// ... (existing code, no changes) ...
    try {
      await sendTriggerMail(ctx.smtp, {
        environment: stageName,
// ... (existing code, no changes) ...
        baselineName, baselineSite: siteName, baselineFixletId: fixletId,
        groupName: gName, groupId: gId, groupSite: gSite, groupType: gType,
        customRelevance, actionXml: xml, actionId,
// ... (existing code, no changes) ...
        emailTo: mailTo, emailFrom: mailFrom, emailCc: mailCc, emailBcc: mailBcc,
        SMTP_FROM: ctx.smtp.SMTP_FROM,
        SMTP_TO: ctx.smtp.SMTP_TO,
// ... (existing code, no changes) ...
        SMTP_CC: ctx.smtp.SMTP_CC,
        SMTP_BCC: ctx.smtp.SMTP_BCC,
        csvContent: csvContent,
// ... (existing code, no changes) ...
      });
      log(req, `[${stageName}-mail] sent`);
    } catch (e) {
      log(req, `[${stageName}-mail] send failed:`, e?.message || e);
// ... (existing code, no changes) ...
    }
  }

  return {
// ... (existing code, no changes) ...
    actionId, siteName, fixletId, group: gName,
    title: actionTitle, stage: stageName, endOffset: xmlOffset,
    createdAt: new Date().toISOString()
// ... (existing code, no changes) ...
  };
}

function attachPilotRoutes(app, ctx) {
  const log = logFactory(ctx.DEBUG_LOG);
// ... (existing code, no changes) ...

  const handleStageTrigger = async (req, res, { isForced, environment }) => {
    req._logStart = Date.now();
    log(req, `POST /api/${environment}/actions${isForced ? '/force' : ''} body:`, req.body);
// ... (existing code, no changes) ...
    try {
      const {
        baselineName,
// ... (existing code, no changes) ...
        groupName,
        chgNumber,
        requireChg = true,
// ... (existing code, no changes) ...
        autoMail,
        mailTo,
        mailFrom,
// ... (existing code, no changes) ...
        mailCc,
        mailBcc,
        // match actions.js precedence
// ... (existing code, no changes) ...
        patchWindow,
        endDateTimeLocalOffset,
        enddatetimelocaloffset,
// ... (existing code, no changes) ...
        endOffsetHours,
        endOffset,
      } = req.body || {};

      if (!baselineName || !groupName) {
// ... (existing code, no changes) ...
        return res.status(400).json({ ok: false, error: "baselineName and groupName are required" });
      }

      if (requireChg && !isForced) {
// ... (existing code, no changes) ...
        if (!chgNumber || !/^CHG/i.test(String(chgNumber))) {
          return res.status(400).json({ ok: false, error: "Valid chgNumber required when requireChg=true and not forcing" });
        }
        const chk = await validateChangeNumber(String(chgNumber).toUpperCase(), ctx);
// ... (existing code, no changes) ...
        if (!chk.ok) {
          return res.status(400).json({
            ok: false, chgOk: false, code: chk.code || "CHG_INVALID", message: chk.message || "CHG validation failed"
// ... (existing code, no changes) ...
          });
        }
      }

      // PatchWindow → EndDateTimeLocalOffset logic
// ... (existing code, no changes) ...
      const timeInput =
        patchWindow ||
        endOffsetHours ||
// ... (existing code, no changes) ...
        endDateTimeLocalOffset ||
        enddatetimelocaloffset ||
        endOffset;

      let chosenOffset = endOffset;
// ... (existing code, no changes) ...
      const pwMs = getPatchWindowMs(timeInput);
      if (pwMs > 0) {
        const tzMs = localUtcOffsetMs();
// ... (existing code, no changes) ...
        const deltaMs = pwMs - tzMs;
        chosenOffset = msToXSDuration(deltaMs);
        log(req, "Computed EndDateTimeLocalOffset:", chosenOffset, "(pwMs:", pwMs, "tzMs:", tzMs, ")");
      } else if (!chosenOffset) {
        return res.status(400).json({ ok: false, error: "Patch Window duration must be greater than zero. Please set a valid duration." });
      }

      const out = await triggerBaselineAction(req, ctx, {
// ... (existing code, no changes) ...
        baselineName,
        groupName,
        autoMail,
// ... (existing code, no changes) ...
        mailTo,
        mailFrom,
        mailCc,
// ... (existing code, no changes) ...
        mailBcc,
        environment,
        endOffset: chosenOffset,
      });

      const payload = { ok: true, chgOk: !requireChg || isForced || true, forced: isForced, ...out };
// ... (existing code, no changes) ...
      log(req, `POST /api/${environment}/actions success →`, payload);
      return res.json(payload);

    } catch (err) {
// ... (existing code, no changes) ...
      log(req, `POST /api/${environment}/actions error:`, err?.message || err);
      res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  };

  // --- PILOT ROUTES ---
// ... (existing code, no changes) ...
  app.post("/api/pilot/actions", (req, res) => {
    handleStageTrigger(req, res, { isForced: false, environment: "Pilot" });
  });
  app.post("/api/pilot/actions/force", (req, res) => {
// ... (existing code, no changes) ...
    handleStageTrigger(req, res, { isForced: true, environment: "Pilot" });
  });

  // --- PRODUCTION ROUTES ---
  app.post("/api/production/actions", (req, res) => {
// ... (existing code, no changes) ...
    handleStageTrigger(req, res, { isForced: false, environment: "Production" });
  });
  app.post("/api/production/actions/force", (req, res) => {
    handleStageTrigger(req, res, { isForced: true, environment: "Production" });
// ... (existing code, no changes) ...
  });
}

module.exports = { attachPilotRoutes };