// bigfix-backend/src/routes/pilot.js
const https = require("https");
const axios = require("axios");
const { joinUrl, toLowerSafe } = require("../utils/http");
const { collectStrings, extractActionIdFromXml } = require("../utils/query");
const { actionStore } = require("../state/store");
const { logFactory } = require("../utils/log");
const { sendTriggerMail } = require("../mail/transport");
const { sql, getPool } = require("../db/mssql"); 

// --- XML Escape Helper (Fixed: Added this missing function) ---
function xmlEscape(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// --- CSV helper ---
function toCSV(serverList) {
  if (!serverList || serverList.length === 0) return null;
  const header = "ServerName";
  const rows = serverList.map(name => `"${String(name).replace(/"/g, '""')}"`);
  return [header, ...rows].join("\r\n");
}

/* ---------------- Time helpers ---------------- */
function getPatchWindowMs(patchWindow) {
  if (patchWindow && typeof patchWindow === "object") {
    const d = Number(patchWindow.days) || 0;
    const h = Number(patchWindow.hours) || 0;
    const m = Number(patchWindow.minutes) || 0;
    return d * 86400000 + h * 3600000 + m * 60000;
  }
  const legacyHours = Number(patchWindow);
  if (Number.isFinite(legacyHours) && legacyHours > 0) {
    return legacyHours * 3600000;
  }
  return 0;
}
function msToXSDuration(ms) {
  if (!Number.isFinite(ms) || ms === 0) return "PT0S";
  const neg = ms < 0;
  let t = Math.abs(ms);
  const totalSeconds = Math.floor(t / 1000);
  const days = Math.floor(totalSeconds / 86400);
  let rem = totalSeconds % 86400;
  const hours = Math.floor(rem / 3600);
  rem = rem % 3600;
  const minutes = Math.floor(rem / 60);
  const seconds = rem % 60;
  let out = "";
  if (days) out += `${days}D`;
  const timeParts = [];
  if (hours) timeParts.push(`${hours}H`);
  if (minutes) timeParts.push(`${minutes}M`);
  if (seconds) timeParts.push(`${seconds}S`);
  if (timeParts.length) out += `T${timeParts.join("")}`;
  else if (!days) out = "T0S";
  return (neg ? "-" : "") + "P" + out;
}
function localUtcOffsetMs() {
  const offsetMin = new Date().getTimezoneOffset(); 
  return -offsetMin * 60000; 
}

async function validateChangeNumber(number, ctx) {
  const { SN_URL, SN_USER, SN_PASSWORD, SN_ALLOW_SELF_SIGNED } = ctx.servicenow;
  let snBase = (SN_URL || "").replace(/\/+$/, "");
  if (/\/api\/now$/i.test(snBase)) snBase = snBase.replace(/\/api\/now$/i, "");
  if (!snBase || !SN_USER || !SN_PASSWORD) {
    return { ok: false, code: "CONFIG", message: "ServiceNow env not configured" };
  }
  const endpoint =
    `${snBase}/api/now/table/change_request` +
    `?sysparm_query=number=${encodeURIComponent(number)}` +
    `&sysparm_fields=sys_id,number,state,stage,approval,work_start,work_end` +
    `&sysparm_display_value=true`;
  const agent = new https.Agent({ rejectUnauthorized: !(String(SN_ALLOW_SELF_SIGNED).toLowerCase() === "true") });
  const resp = await axios.get(endpoint, {
    httpsAgent: agent,
    auth: { username: SN_USER, password: SN_PASSWORD },
    headers: { Accept: "application/json" },
    timeout: 30000,
    validateStatus: () => true,
  });
  if (resp.status === 401 || resp.status === 403) {
    return { ok: false, code: "NOT_FOUND_OR_FORBIDDEN", message: "Change Request doesn't exist or user doesn't have required privileges." };
  }
  let result = resp?.data?.result;
  if (Array.isArray(result)) { /* ok */ }
  else if (result && typeof result === "object") { result = [result]; }
  else { result = []; }
  if (result.length === 0) {
    return { ok: false, code: "NOT_FOUND_OR_FORBIDDEN", message: "Change Request doesn't exist or user doesn't have required privileges." };
  }
  const rec = result[0] || {};
  const state = String(rec.state || "").trim();
  const isImplement = /^implement$/i.test(state);

  if (!isImplement) {
    return { ok: false, code: "NOT_IMPLEMENT", message: "Change Request is not at Implement stage.", record: rec };
  }
  return { ok: true, exists: true, implement: true, record: rec };
}

async function triggerBaselineAction(req, ctx, {
  baselineName,
  groupName,
  autoMail,
  mailTo,
  mailFrom,
  mailCc,
  mailBcc,
  environment,
  endOffset,
  triggeredBy 
}) {
  const { BIGFIX_BASE_URL, BIGFIX_USER, BIGFIX_PASS, httpsAgent } = ctx.bigfix;
  const log = logFactory(ctx.DEBUG_LOG);
  let csvContent = null;

  // 1) Baseline lookup
  const qBaseline = `(name of site of it, id of it) of bes baseline whose (name of it is "${baselineName.replace(/"/g, '\\"')}")`;
  const urlBaseline = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(qBaseline)}`;
  log(req, "Baseline lookup →", urlBaseline);

  const baselineResp = await axios.get(urlBaseline, {
    httpsAgent,
    auth: { username: BIGFIX_USER, password: BIGFIX_PASS },
    headers: { Accept: "application/json" },
    responseType: "json",
    timeout: 60_000,
    validateStatus: () => true
  });
  if (baselineResp.status < 200 || baselineResp.status >= 300) throw new Error(`Baseline lookup failed: HTTP ${baselineResp.status}`);

  const baselineRows = Array.isArray(baselineResp.data?.result) ? baselineResp.data.result : [];
  if (!baselineRows.length) throw new Error(`Baseline not found: ${baselineName}`);
  const partsB = []; collectStrings(baselineRows[0], partsB);
  if (partsB.length < 2) throw new Error("Unexpected baseline query shape");

  const siteName = partsB[0]; const fixletId = partsB[1];

  // 2) Group lookup (WITH SELF-HEALING LOGIC)
  const qGroup = `(name of it, id of it, name of site of it, (if automatic flag of it then "Automatic" else if manual flag of it then "manual" else "server based")) of bes computer group whose (name of it is "${groupName.replace(/"/g, '\\"')}")`;
  const urlGroup = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(qGroup)}`;
  log(req, "Group lookup →", urlGroup);
  
  const groupResp = await axios.get(urlGroup, {
    httpsAgent,
    auth: { username: BIGFIX_USER, password: BIGFIX_PASS },
    headers: { Accept: "application/json" },
    responseType: "json",
    timeout: 60_000,
    validateStatus: () => true
  });

  const groupRows = Array.isArray(groupResp.data?.result) ? groupResp.data.result : [];

  if (!groupRows.length) {
      // --- SELF-HEALING START ---
      console.log(`[GroupSync] Group '${groupName}' not found in BigFix. Checking local DB...`);
      const pool = await getPool();
      
      // Check if this group exists in our AssetOwnership table
      const dbCheck = await pool.request()
          .input('Name', sql.NVarChar(255), groupName)
          .query("SELECT BigFixID FROM dbo.AssetOwnership WHERE AssetName = @Name AND AssetType = 'Group'");
      
      if (dbCheck.recordset.length > 0) {
          // It exists in DB but NOT in BigFix -> It was deleted from Console.
          console.log(`[GroupSync] 'Ghost' group detected. Removing '${groupName}' from database.`);
          
          // Instantly delete from DB
          await pool.request()
             .input('Name', sql.NVarChar(255), groupName)
             .query("DELETE FROM dbo.AssetOwnership WHERE AssetName = @Name AND AssetType = 'Group'");
             
          // Throw helpful error
          throw new Error(`Group '${groupName}' has been deleted from the BigFix Console. It was removed from your list. Please create it again.`);
      } else {
          // Standard error if it wasn't in DB either
          throw new Error(`Group '${groupName}' does not exist in BigFix.`);
      }
      // --- SELF-HEALING END ---
  }

  const partsG = []; collectStrings(groupRows[0], partsG);
  if (partsG.length < 4) throw new Error("Unexpected group query shape");

  const gName = partsG[0], gId = partsG[1], gSite = partsG[2], gType = partsG[3];

  // 3) Attach CSV (optional)
  if (autoMail) {
    try {
      const qServers = `names of members of bes computer group whose (id of it = ${gId})`;
      const urlServers = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(qServers)}`;
      const serversResp = await axios.get(urlServers, {
        httpsAgent,
        auth: { username: BIGFIX_USER, password: BIGFIX_PASS },
        headers: { Accept: "application/json" }
      });
      if (serversResp.status === 200) {
        const serverNames = Array.isArray(serversResp.data?.result) ? serversResp.data.result : [];
        csvContent = toCSV(serverNames);
      }
    } catch (e) {
      log(req, "Failed to query server list for CSV:", e.message);
    }
  }

  // 4) Relevance
  const type = toLowerSafe(gType);
  const siteTokenForAutomatic = gSite === "ActionSite" ? `site "actionsite"` : `site "CustomSite_${gSite}"`;
  let customRelevance = "";

  if (type.includes("automatic")) {
    customRelevance = `exists true whose ( if true then ( member of group ${gId} of ${siteTokenForAutomatic} ) else false)`;
  } else if (type.includes("manual")) {
    customRelevance = `exists true whose ( if true then ( member of manual group "${gName}" of client ) else false)`;
  } else {
    customRelevance = `exists true whose ( if true then ( member of server based group "${gName}" of client ) else false)`;
  }

  // 5) XML Body
  const stageName = environment || "Pilot";
  const actionTitle = `BPS_${baselineName}_${stageName}`;
  const xmlOffset = endOffset || "P2D";
  const xml = `<?xml version="1.0" encoding="UTF-8"?><BES xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="BES.xsd"><SourcedFixletAction><SourceFixlet><Sitename>${xmlEscape(siteName)}</Sitename><FixletID>${xmlEscape(fixletId)}</FixletID><Action>Action1</Action></SourceFixlet><Target><CustomRelevance>${xmlEscape(customRelevance)}</CustomRelevance></Target><Settings><HasEndTime>true</HasEndTime><EndDateTimeLocalOffset>${xmlEscape(xmlOffset)}</EndDateTimeLocalOffset><UseUTCTime>true</UseUTCTime></Settings><Title>${xmlEscape(actionTitle)}</Title></SourcedFixletAction></BES>`;

  // 6) Post to BigFix
  const bfPostUrl = joinUrl(BIGFIX_BASE_URL, "/api/actions");
  log(req, `BF POST → ${bfPostUrl} body=${xml.length} chars`);
  const bfResp = await axios.post(bfPostUrl, xml, {
    httpsAgent,
    auth: { username: BIGFIX_USER, password: BIGFIX_PASS },
    headers: { "Content-Type": "text/xml" },
    timeout: 60_000,
    validateStatus: () => true,
    responseType: "text",
  });
  log(req, `BF POST ← ${bfResp.status}`);

  if (bfResp.status < 200 || bfResp.status >= 300) throw new Error(`BigFix POST failed: HTTP ${bfResp.status} ${String(bfResp.data).slice(0, 200)}`);

  const actionId = extractActionIdFromXml(String(bfResp.data || ""));
  const smtpReady = !!(ctx.smtp && ctx.smtp.SMTP_HOST && ctx.smtp.SMTP_FROM);

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
      smtpEnabled: smtpReady, 
      postMailSent: false,
      triggeredBy: triggeredBy || "Unknown",
    };

    actionStore.lastActionId = actionId;
    actionStore.actions[actionId] = metadata;

    try {
      const pool = await getPool();
      await pool.request()
        .input('ActionID', sql.Int, Number(actionId))
        .input('Metadata', sql.NVarChar(sql.MAX), JSON.stringify(metadata))
        .input('PostMailSent', sql.Bit, 0)
        .query(`INSERT INTO dbo.ActionHistory (ActionID, Metadata, PostMailSent, CreatedAt) VALUES (@ActionID, @Metadata, @PostMailSent, SYSUTCDATETIME())`);
    } catch (dbErr) {
      log(req, `[${stageName}] FAILED to save Action ${actionId} to DB:`, dbErr.message);
    }
  }

  // 7) Email (pre-patch)
  if (autoMail && smtpReady) { 
    try {
      await sendTriggerMail(ctx.smtp, {
        environment: stageName,
        baselineName, baselineSite: siteName, baselineFixletId: fixletId,
        groupName: gName, groupId: gId, groupSite: gSite, groupType: gType,
        customRelevance, actionXml: xml, actionId,
        emailTo: mailTo, emailFrom: mailFrom, emailCc: mailCc, emailBcc: mailBcc,
        SMTP_FROM: ctx.smtp.SMTP_FROM, SMTP_TO: ctx.smtp.SMTP_TO,
        SMTP_CC: ctx.smtp.SMTP_CC, SMTP_BCC: ctx.smtp.SMTP_BCC,
        csvContent: csvContent,
      });
      log(req, `[${stageName}-mail] sent`);
    } catch (e) {
      log(req, `[${stageName}-mail] send failed:`, e?.message || e);
    }
  }

  return {
    actionId, siteName, fixletId, group: gName,
    title: actionTitle, stage: stageName, endOffset: xmlOffset,
    createdAt: new Date().toISOString()
  };
}

function attachPilotRoutes(app, ctx) {
  const log = logFactory(ctx.DEBUG_LOG);
  const handleStageTrigger = async (req, res, { isForced, environment }) => {
    req._logStart = Date.now();
    const { triggeredBy } = req.body || {}; 
    log(req, `POST /api/${environment}/actions${isForced ? '/force' : ''}. User: [${triggeredBy || 'Unknown'}].`);

    try {
      const { baselineName, groupName, chgNumber, requireChg = true, autoMail, mailTo, mailFrom, mailCc, mailBcc, patchWindow, endOffset } = req.body || {};

      if (!baselineName || !groupName) {
        return res.status(400).json({ ok: false, error: "baselineName and groupName are required" });
      }

      if (requireChg && !isForced) {
        if (!chgNumber || !/^CHG/i.test(String(chgNumber))) {
          return res.status(400).json({ ok: false, error: "Valid chgNumber required when requireChg=true and not forcing" });
        }
        const chk = await validateChangeNumber(String(chgNumber).toUpperCase(), ctx);
        if (!chk.ok) {
          return res.status(400).json({ ok: false, chgOk: false, code: chk.code || "CHG_INVALID", message: chk.message || "CHG validation failed" });
        }
      }

      const timeInput = patchWindow || endOffset;
      let chosenOffset = endOffset;
      const pwMs = getPatchWindowMs(timeInput);
      if (pwMs > 0) {
        const tzMs = localUtcOffsetMs();
        const deltaMs = pwMs - tzMs;
        chosenOffset = msToXSDuration(deltaMs);
      } else if (!chosenOffset) {
        return res.status(400).json({ ok: false, error: "Patch Window duration must be greater than zero." });
      }

      const out = await triggerBaselineAction(req, ctx, {
        baselineName, groupName, autoMail, mailTo, mailFrom, mailCc, mailBcc, environment, endOffset: chosenOffset, triggeredBy
      });

      const payload = { ok: true, chgOk: !requireChg || isForced || true, forced: isForced, ...out };
      log(req, `POST /api/${environment}/actions success →`, payload);
      return res.json(payload);

    } catch (err) {
      log(req, `Trigger Error:`, err?.message || err);
      // Return 500 but with the explicit message
      res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  };

  app.post("/api/pilot/actions", (req, res) => { handleStageTrigger(req, res, { isForced: false, environment: "Pilot" }); });
  app.post("/api/pilot/actions/force", (req, res) => { handleStageTrigger(req, res, { isForced: true, environment: "Pilot" }); });
  app.post("/api/production/actions", (req, res) => { handleStageTrigger(req, res, { isForced: false, environment: "Production" }); });
  app.post("/api/production/actions/force", (req, res) => { handleStageTrigger(req, res, { isForced: true, environment: "Production" }); });
}

module.exports = { attachPilotRoutes };