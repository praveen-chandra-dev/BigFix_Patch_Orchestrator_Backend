const stageController = require("../controllers/pilot");

function attachPilotRoutes(app, ctx) {
  // Pilot Endpoints
  app.post("/api/pilot/actions", stageController.triggerPilot);
  app.post("/api/pilot/actions/force", stageController.triggerPilotForce);
  
  // Production Endpoints
  app.post("/api/production/actions", stageController.triggerProduction);
  app.post("/api/production/actions/force", stageController.triggerProductionForce);
}

module.exports = { attachPilotRoutes };


// // src/routes/pilot.js
// const https = require("https");
// const axios = require("axios");
// const { joinUrl, toLowerSafe, escapeXML, getBfAuthContext } = require("../utils/http");
// const { collectStrings, extractActionIdFromXml, parseTupleRows } = require("../utils/query"); // Added parseTupleRows
// const { actionStore, CONFIG } = require("../state/store");
// const { logFactory } = require("../utils/log");
// const { sendTriggerMail } = require("../mail/transport");
// const { sql, getPool } = require("../db/mssql"); 
// const { saveConfigToDB } = require("./config");
// const { scheduleActionStop } = require("../services/postpatchWatcher");

// function toCSV(serverList) {
//   if (!serverList || serverList.length === 0) return null;
//   const header = "ServerName";
//   const rows = serverList.map(name => `"${String(name).replace(/"/g, '""')}"`);
//   return [header, ...rows].join("\r\n");
// }

// function getPatchWindowMs(patchWindow) {
//   if (patchWindow && typeof patchWindow === "object") {
//     const d = Number(patchWindow.days) || 0; const h = Number(patchWindow.hours) || 0; const m = Number(patchWindow.minutes) || 0;
//     return d * 86400000 + h * 3600000 + m * 60000;
//   }
//   const legacyHours = Number(patchWindow);
//   if (Number.isFinite(legacyHours) && legacyHours > 0) return legacyHours * 3600000;
//   return 0;
// }

// // 🚀 FETCH PATCH CONTENT QUERY
// async function fetchBaselinePatches(bigfixCtx, baselineName, bfAuthOpts) {
//   try {
//     const { BIGFIX_BASE_URL } = bigfixCtx;
//     const relevance = `((name of it | "N/A"), (source severity of it | "N/A"), (cve id list of it | "N/A"), (source of it | "N/A")) of source fixlets of components of component groups of bes fixlets whose (name of it as lowercase = "${String(baselineName).toLowerCase().replace(/"/g, '\\"')}")`;
//     const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
//     const resp = await axios.get(url, { ...bfAuthOpts, headers: { Accept: "application/json" } });
//     if (resp.status >= 200 && resp.status < 300) {
//         const rows = parseTupleRows(resp.data);
//         return rows.map(r => ({ name: r[0], severity: r[1], cves: r[2], source: r[3] }));
//     }
//   } catch (e) { }
//   return [];
// }

// function patchesToCSV(patches) {
//   if (!patches || !patches.length) return null;
//   const escape = (v) => `"${String(v || "").replace(/"/g, '""')}"`;
//   const lines = ["Patch Name,Severity,CVEs,Source"];
//   for (const p of patches) { lines.push(`${escape(p.name)},${escape(p.severity)},${escape(p.cves)},${escape(p.source)}`); }
//   return lines.join("\r\n");
// }

// // ... (Keep validateChangeNumber identical to your current code) ...
// async function validateChangeNumber(number, ctx) {
//   const { SN_URL, SN_USER, SN_PASSWORD, SN_ALLOW_SELF_SIGNED } = ctx.servicenow;
//   let snBase = (SN_URL || "").replace(/\/+$/, "");
//   if (/\/api\/now$/i.test(snBase)) snBase = snBase.replace(/\/api\/now$/i, "");
//   if (!snBase || !SN_USER || !SN_PASSWORD) { return { ok: false, code: "CONFIG", message: "ServiceNow env not configured" }; }
//   const endpoint = `${snBase}/api/now/table/change_request` + `?sysparm_query=number=${encodeURIComponent(number)}` + `&sysparm_fields=sys_id,number,state,stage,approval,work_start,work_end` + `&sysparm_display_value=true`;
//   const agent = new https.Agent({ rejectUnauthorized: !(String(SN_ALLOW_SELF_SIGNED).toLowerCase() === "true") });
//   const resp = await axios.get(endpoint, { httpsAgent: agent, auth: { username: SN_USER, password: SN_PASSWORD }, headers: { Accept: "application/json" }, timeout: 30000, validateStatus: () => true });
//   if (resp.status === 401 || resp.status === 403) { return { ok: false, code: "NOT_FOUND_OR_FORBIDDEN", message: "Change Request doesn't exist or user doesn't have required privileges." }; }
//   let result = resp?.data?.result;
//   if (Array.isArray(result)) { /* ok */ } else if (result && typeof result === "object") { result = [result]; } else { result = []; }
//   if (result.length === 0) { return { ok: false, code: "NOT_FOUND_OR_FORBIDDEN", message: "Change Request doesn't exist or user doesn't have required privileges." }; }
//   const rec = result[0] || {}; const state = String(rec.state || "").trim(); const isImplement = /^implement$/i.test(state);
//   if (!isImplement) { return { ok: false, code: "NOT_IMPLEMENT", message: "Change Request is not at Implement stage.", record: rec }; }
//   return { ok: true, exists: true, implement: true, record: rec };
// }

// async function triggerBaselineAction(req, ctx, { baselineName, groupName, shouldMail, mailTo, mailFrom, mailCc, mailBcc, environment, triggeredBy, expiresAt }) {
//   const { BIGFIX_BASE_URL } = ctx.bigfix;
//   const log = logFactory(ctx.DEBUG_LOG);
  
//   const qBaseline = `(name of site of it, id of it) of bes baseline whose (name of it is "${baselineName.replace(/"/g, '\\"')}")`;
//   const urlBaseline = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(qBaseline)}`;
//   const bfAuthOpts = await getBfAuthContext(req, ctx);

//   const baselineResp = await axios.get(urlBaseline, { ...bfAuthOpts, headers: { Accept: "application/json" }, responseType: "json", timeout: 60_000, validateStatus: () => true });
//   if (baselineResp.status < 200 || baselineResp.status >= 300) throw new Error(`Baseline lookup failed: HTTP ${baselineResp.status}`);
//   const baselineRows = Array.isArray(baselineResp.data?.result) ? baselineResp.data.result : [];
//   if (!baselineRows.length) throw new Error(`Baseline not found: ${baselineName}`);
//   const partsB = []; collectStrings(baselineRows[0], partsB);
//   if (partsB.length < 2) throw new Error("Unexpected baseline query shape");
//   const siteName = partsB[0]; const fixletId = partsB[1];

//   const qGroup = `(name of it, id of it, name of site of it, (if automatic flag of it then "Automatic" else if manual flag of it then "manual" else "server based")) of bes computer group whose (name of it is "${groupName.replace(/"/g, '\\"')}")`;
//   const urlGroup = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(qGroup)}`;
//   const groupResp = await axios.get(urlGroup, { ...bfAuthOpts, headers: { Accept: "application/json" }, responseType: "json", timeout: 60_000, validateStatus: () => true });
//   const groupRows = Array.isArray(groupResp.data?.result) ? groupResp.data.result : [];

//   if (!groupRows.length) {
//       const pool = await getPool();
//       const dbCheck = await pool.request().input('Name', sql.NVarChar(255), groupName).query("SELECT BigFixID FROM dbo.AssetOwnership WHERE AssetName = @Name AND AssetType = 'Group'");
//       if (dbCheck.recordset.length > 0) {
//           await pool.request().input('Name', sql.NVarChar(255), groupName).query("DELETE FROM dbo.AssetOwnership WHERE AssetName = @Name AND AssetType = 'Group'");
//           throw new Error(`Group '${groupName}' has been deleted from the BigFix Console. It was removed from your list. Please create it again.`);
//       } else { throw new Error(`Group '${groupName}' does not exist in BigFix.`); }
//   }

//   const partsG = []; collectStrings(groupRows[0], partsG);
//   if (partsG.length < 4) throw new Error("Unexpected group query shape");
//   const gName = partsG[0], gId = partsG[1], gSite = partsG[2], gType = partsG[3];

//   let csvContent = null;
//   let patchesCsvContent = null;
//   let baselinePatches = [];

//   if (shouldMail) {
//     try {
//       const qServers = `names of members of bes computer group whose (id of it = ${gId})`;
//       const urlServers = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(qServers)}`;
//       const serversResp = await axios.get(urlServers, { ...bfAuthOpts, headers: { Accept: "application/json" } });
//       if (serversResp.status === 200) {
//         const serverNames = Array.isArray(serversResp.data?.result) ? serversResp.data.result : [];
//         csvContent = toCSV(serverNames);
//       }
      
//       // FETCH PATCHES
//       baselinePatches = await fetchBaselinePatches(ctx.bigfix, baselineName, bfAuthOpts);
//       patchesCsvContent = patchesToCSV(baselinePatches);
//     } catch (e) { log(req, "Failed to query server list for CSV:", e.message); }
//   }

//   const type = toLowerSafe(gType);
//   const siteTokenForAutomatic = gSite === "ActionSite" ? `site "actionsite"` : `site "CustomSite_${gSite}"`;
//   let customRelevance = "";

//   if (type.includes("automatic")) { customRelevance = `exists true whose ( if true then ( member of group ${gId} of ${siteTokenForAutomatic} ) else false)`; } 
//   else if (type.includes("manual")) { customRelevance = `exists true whose ( if true then ( member of manual group "${gName}" of client ) else false)`; } 
//   else { customRelevance = `exists true whose ( if true then ( member of server based group "${gName}" of client ) else false)`; }

//   const stageName = environment || "Pilot";
//   const actionTitle = `BPS_${baselineName}_${stageName}`;
//   const xml = `<?xml version="1.0" encoding="UTF-8"?><BES xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="BES.xsd"><SourcedFixletAction><SourceFixlet><Sitename>${escapeXML(siteName)}</Sitename><FixletID>${escapeXML(fixletId)}</FixletID><Action>Action1</Action></SourceFixlet><Target><CustomRelevance>${escapeXML(customRelevance)}</CustomRelevance></Target><Settings><UseUTCTime>true</UseUTCTime></Settings><Title>${escapeXML(actionTitle)}</Title></SourcedFixletAction></BES>`;

//   const bfPostUrl = joinUrl(BIGFIX_BASE_URL, "/api/actions");
//   const bfResp = await axios.post(bfPostUrl, xml, { ...bfAuthOpts, headers: { "Content-Type": "text/xml" }, timeout: 60_000, validateStatus: () => true, responseType: "text" });
//   if (bfResp.status < 200 || bfResp.status >= 300) throw new Error(`BigFix POST failed: HTTP ${bfResp.status} ${String(bfResp.data).slice(0, 200)}`);

//   const actionId = extractActionIdFromXml(String(bfResp.data || ""));
//   const smtpReady = !!(ctx.smtp && ctx.smtp.SMTP_HOST && ctx.smtp.SMTP_FROM);
//   let emailError = null;

//   if (actionId) {
//     const metadata = { id: actionId, createdAt: new Date().toISOString(), expiresAt, stage: stageName, xml, baselineName, baselineSite: siteName, baselineFixletId: fixletId, groupName: gName, groupId: gId, groupSite: gSite, groupType: gType, preMail: shouldMail, smtpEnabled: smtpReady, postMailSent: false, triggeredBy: triggeredBy || "Unknown" };
//     actionStore.lastActionId = actionId;
//     actionStore.actions[actionId] = metadata;

//     if (stageName.toLowerCase() === "pilot") { CONFIG.lastPilotBaseline = baselineName; CONFIG.lastPilotGroup = gName; } 
//     else if (stageName.toLowerCase() === "production") { CONFIG.lastProdBaseline = baselineName; CONFIG.lastProdGroup = gName; }
//     try { await saveConfigToDB(CONFIG, req, log); } catch(e) {}

//     try {
//       const pool = await getPool();
//       await pool.request().input('ActionID', sql.Int, Number(actionId)).input('Metadata', sql.NVarChar(sql.MAX), JSON.stringify(metadata)).input('PostMailSent', sql.Bit, 0).query(`INSERT INTO dbo.ActionHistory (ActionID, Metadata, PostMailSent, CreatedAt) VALUES (@ActionID, @Metadata, @PostMailSent, SYSUTCDATETIME())`);
//     } catch (dbErr) {}

//     scheduleActionStop(ctx, actionId, metadata);
//   }

//   if (shouldMail && smtpReady) { 
//     try {
//       await sendTriggerMail(ctx.smtp, { environment: stageName, baselineName, baselineSite: siteName, baselineFixletId: fixletId, groupName: gName, groupId: gId, groupSite: gSite, groupType: gType, customRelevance, actionXml: xml, actionId, emailTo: mailTo, emailFrom: mailFrom, emailCc: mailCc, emailBcc: mailBcc, SMTP_FROM: ctx.smtp.SMTP_FROM, SMTP_TO: ctx.smtp.SMTP_TO, SMTP_CC: ctx.smtp.SMTP_CC, SMTP_BCC: ctx.smtp.SMTP_BCC, csvContent, patchesCsvContent, baselinePatches });
//       console.log(`[Pilot/Prod] ✅ Pre-patch mail triggered successfully for ${actionId}`);
//     } catch (e) {
//       emailError = e.message || String(e);
//       console.error(`[Pilot/Prod] ❌ Pre-patch mail failed to send for ${actionId}:`, emailError);
//     }
//   } else if (shouldMail && !smtpReady) {
//       emailError = "SMTP not properly configured (Missing HOST or FROM)";
//       console.warn(`[Pilot/Prod] ⚠️ Pre-patch mail skipped for ${actionId}:`, emailError);
//   }

//   return { actionId, siteName, fixletId, group: gName, title: actionTitle, stage: stageName, createdAt: new Date().toISOString(), preMailError: emailError };
// }

// function attachPilotRoutes(app, ctx) {
//   const log = logFactory(ctx.DEBUG_LOG);
//   const handleStageTrigger = async (req, res, { isForced, environment }) => {
//     req._logStart = Date.now();
//     const { triggeredBy } = req.body || {}; 
//     log(req, `POST /api/${environment}/actions${isForced ? '/force' : ''}. User: [${triggeredBy || 'Unknown'}].`);

//     try {
//       const { baselineName, groupName, chgNumber, requireChg = true, autoMail, mailTo, mailFrom, mailCc, mailBcc, patchWindow } = req.body || {};
//       if (!baselineName || !groupName) return res.status(400).json({ ok: false, error: "baselineName and groupName are required" });

//       if (requireChg && !isForced) {
//         if (!chgNumber || !/^CHG/i.test(String(chgNumber))) return res.status(400).json({ ok: false, error: "Valid chgNumber required when requireChg=true and not forcing" });
//         const chk = await validateChangeNumber(String(chgNumber).toUpperCase(), ctx);
//         if (!chk.ok) return res.status(400).json({ ok: false, chgOk: false, code: chk.code || "CHG_INVALID", message: chk.message || "CHG validation failed" });
//       }

//       const frontendAutoMail = ["true", "1", "yes", "on", true, 1].includes(String(autoMail).toLowerCase());
//       const globalAutoMail = ["true", "1", "yes", "on", true, 1].includes(String(CONFIG.autoMail).toLowerCase());
//       const shouldMail = frontendAutoMail || globalAutoMail;

//       const pwMs = getPatchWindowMs(patchWindow);
//       let expiresAt = 0; 
//       if (pwMs > 0) expiresAt = Date.now() + pwMs; else return res.status(400).json({ ok: false, error: "Patch Window duration must be greater than zero." });

//       const out = await triggerBaselineAction(req, ctx, { baselineName, groupName, shouldMail, mailTo, mailFrom, mailCc, mailBcc, environment, triggeredBy, expiresAt });
//       const payload = { ok: true, chgOk: !requireChg || isForced || true, forced: isForced, ...out };
//       return res.json(payload);

//     } catch (err) { res.status(500).json({ ok: false, error: String(err?.message || err) }); }
//   };

//   app.post("/api/pilot/actions", (req, res) => { handleStageTrigger(req, res, { isForced: false, environment: "Pilot" }); });
//   app.post("/api/pilot/actions/force", (req, res) => { handleStageTrigger(req, res, { isForced: true, environment: "Pilot" }); });
//   app.post("/api/production/actions", (req, res) => { handleStageTrigger(req, res, { isForced: false, environment: "Production" }); });
//   app.post("/api/production/actions/force", (req, res) => { handleStageTrigger(req, res, { isForced: true, environment: "Production" }); });
// }

// module.exports = { attachPilotRoutes };


// src/routes/pilot.js
// const https = require("https");
// const axios = require("axios");
// const { joinUrl, toLowerSafe, escapeXML, getBfAuthContext } = require("../utils/http");
// const { collectStrings, extractActionIdFromXml, parseTupleRows } = require("../utils/query"); 
// const { actionStore, CONFIG } = require("../state/store");
// const { logFactory } = require("../utils/log");
// const { sendTriggerMail } = require("../mail/transport");
// const { sql, getPool } = require("../db/mssql"); 
// const { saveConfigToDB } = require("./config");
// const { scheduleActionStop } = require("../services/postpatchWatcher");

// function toCSV(serverList) {
//   if (!serverList || serverList.length === 0) return null;
//   const header = "ServerName";
//   const rows = serverList.map(name => `"${String(name).replace(/"/g, '""')}"`);
//   return [header, ...rows].join("\r\n");
// }

// // ---------------- Time Helpers ----------------
// function getPatchWindowMs(patchWindow) {
//   if (patchWindow && typeof patchWindow === "object") {
//     const d = Number(patchWindow.days) || 0; 
//     const h = Number(patchWindow.hours) || 0; 
//     const m = Number(patchWindow.minutes) || 0;
//     return d * 86400000 + h * 3600000 + m * 60000;
//   }
//   const legacyHours = Number(patchWindow);
//   if (Number.isFinite(legacyHours) && legacyHours > 0) return legacyHours * 3600000;
//   return 0;
// }

// function msToXSDuration(ms) {
//   if (!Number.isFinite(ms) || ms === 0) return "PT0S";
//   const neg = ms < 0;
//   let t = Math.abs(ms);

//   const totalSeconds = Math.floor(t / 1000);
//   const days = Math.floor(totalSeconds / 86400);
//   let rem = totalSeconds % 86400;

//   const hours = Math.floor(rem / 3600);
//   rem = rem % 3600;

//   const minutes = Math.floor(rem / 60);
//   const seconds = rem % 60;

//   let out = "";
//   if (days) out += `${days}D`;
//   const timeParts = [];

//   if (hours) timeParts.push(`${hours}H`);
//   if (minutes) timeParts.push(`${minutes}M`);
//   if (seconds) timeParts.push(`${seconds}S`);

//   if (timeParts.length) {
//     out += `T${timeParts.join("")}`;
//   } else if (!days) {
//     out = "T0S";
//   }

//   return (neg ? "-" : "") + "P" + out;
// }

// function localUtcOffsetMs() {
//   const offsetMin = new Date().getTimezoneOffset(); 
//   return -offsetMin * 60000; 
// }

// // 🚀 FETCH PATCH CONTENT QUERY
// async function fetchBaselinePatches(bigfixCtx, baselineName, bfAuthOpts) {
//   try {
//     const { BIGFIX_BASE_URL } = bigfixCtx;
//     const relevance = `((name of it | "N/A"), (source severity of it | "N/A"), (cve id list of it | "N/A"), (source of it | "N/A")) of source fixlets of components of component groups of bes fixlets whose (name of it as lowercase = "${String(baselineName).toLowerCase().replace(/"/g, '\\"')}")`;
//     const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
//     const resp = await axios.get(url, { ...bfAuthOpts, headers: { Accept: "application/json" } });
//     if (resp.status >= 200 && resp.status < 300) {
//         const rows = parseTupleRows(resp.data);
//         return rows.map(r => ({ name: r[0], severity: r[1], cves: r[2], source: r[3] }));
//     }
//   } catch (e) { }
//   return [];
// }

// function patchesToCSV(patches) {
//   if (!patches || !patches.length) return null;
//   const escape = (v) => `"${String(v || "").replace(/"/g, '""')}"`;
//   const lines = ["Patch Name,Severity,CVEs,Source"];
//   for (const p of patches) { lines.push(`${escape(p.name)},${escape(p.severity)},${escape(p.cves)},${escape(p.source)}`); }
//   return lines.join("\r\n");
// }

// // ... ServiceNow Validation ...
// async function validateChangeNumber(number, ctx) {
//   const { SN_URL, SN_USER, SN_PASSWORD, SN_ALLOW_SELF_SIGNED } = ctx.servicenow;
//   let snBase = (SN_URL || "").replace(/\/+$/, "");
//   if (/\/api\/now$/i.test(snBase)) snBase = snBase.replace(/\/api\/now$/i, "");
//   if (!snBase || !SN_USER || !SN_PASSWORD) { return { ok: false, code: "CONFIG", message: "ServiceNow env not configured" }; }
//   const endpoint = `${snBase}/api/now/table/change_request` + `?sysparm_query=number=${encodeURIComponent(number)}` + `&sysparm_fields=sys_id,number,state,stage,approval,work_start,work_end` + `&sysparm_display_value=true`;
//   const agent = new https.Agent({ rejectUnauthorized: !(String(SN_ALLOW_SELF_SIGNED).toLowerCase() === "true") });
//   const resp = await axios.get(endpoint, { httpsAgent: agent, auth: { username: SN_USER, password: SN_PASSWORD }, headers: { Accept: "application/json" }, timeout: 30000, validateStatus: () => true });
//   if (resp.status === 401 || resp.status === 403) { return { ok: false, code: "NOT_FOUND_OR_FORBIDDEN", message: "Change Request doesn't exist or user doesn't have required privileges." }; }
//   let result = resp?.data?.result;
//   if (Array.isArray(result)) { /* ok */ } else if (result && typeof result === "object") { result = [result]; } else { result = []; }
//   if (result.length === 0) { return { ok: false, code: "NOT_FOUND_OR_FORBIDDEN", message: "Change Request doesn't exist or user doesn't have required privileges." }; }
//   const rec = result[0] || {}; const state = String(rec.state || "").trim(); const isImplement = /^implement$/i.test(state);
//   if (!isImplement) { return { ok: false, code: "NOT_IMPLEMENT", message: "Change Request is not at Implement stage.", record: rec }; }
//   return { ok: true, exists: true, implement: true, record: rec };
// }

// async function triggerBaselineAction(req, ctx, { baselineName, groupName, shouldMail, mailTo, mailFrom, mailCc, mailBcc, environment, triggeredBy, expiresAt, pwMs }) {
//   const { BIGFIX_BASE_URL } = ctx.bigfix;
//   const log = logFactory(ctx.DEBUG_LOG);
  
//   const qBaseline = `(name of site of it, id of it) of bes baseline whose (name of it is "${baselineName.replace(/"/g, '\\"')}")`;
//   const urlBaseline = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(qBaseline)}`;
//   const bfAuthOpts = await getBfAuthContext(req, ctx);

//   const baselineResp = await axios.get(urlBaseline, { ...bfAuthOpts, headers: { Accept: "application/json" }, responseType: "json", timeout: 60_000, validateStatus: () => true });
//   if (baselineResp.status < 200 || baselineResp.status >= 300) throw new Error(`Baseline lookup failed: HTTP ${baselineResp.status}`);
//   const baselineRows = Array.isArray(baselineResp.data?.result) ? baselineResp.data.result : [];
//   if (!baselineRows.length) throw new Error(`Baseline not found: ${baselineName}`);
//   const partsB = []; collectStrings(baselineRows[0], partsB);
//   if (partsB.length < 2) throw new Error("Unexpected baseline query shape");
//   const siteName = partsB[0]; const fixletId = partsB[1];

//   const qGroup = `(name of it, id of it, name of site of it, (if automatic flag of it then "Automatic" else if manual flag of it then "manual" else "server based")) of bes computer group whose (name of it is "${groupName.replace(/"/g, '\\"')}")`;
//   const urlGroup = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(qGroup)}`;
//   const groupResp = await axios.get(urlGroup, { ...bfAuthOpts, headers: { Accept: "application/json" }, responseType: "json", timeout: 60_000, validateStatus: () => true });
//   const groupRows = Array.isArray(groupResp.data?.result) ? groupResp.data.result : [];

//   if (!groupRows.length) {
//       const pool = await getPool();
//       const dbCheck = await pool.request().input('Name', sql.NVarChar(255), groupName).query("SELECT BigFixID FROM dbo.AssetOwnership WHERE AssetName = @Name AND AssetType = 'Group'");
//       if (dbCheck.recordset.length > 0) {
//           await pool.request().input('Name', sql.NVarChar(255), groupName).query("DELETE FROM dbo.AssetOwnership WHERE AssetName = @Name AND AssetType = 'Group'");
//           throw new Error(`Group '${groupName}' has been deleted from the BigFix Console. It was removed from your list. Please create it again.`);
//       } else { throw new Error(`Group '${groupName}' does not exist in BigFix.`); }
//   }

//   const partsG = []; collectStrings(groupRows[0], partsG);
//   if (partsG.length < 4) throw new Error("Unexpected group query shape");
//   const gName = partsG[0], gId = partsG[1], gSite = partsG[2], gType = partsG[3];

//   // 🚀 NEW: Get specific Computer IDs for the target group
//   const qMemberIds = `(id of it as string) of members of bes computer group whose (id of it = ${gId})`;
//   const urlMemberIds = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(qMemberIds)}`;
//   const membersResp = await axios.get(urlMemberIds, { ...bfAuthOpts, headers: { Accept: "application/json" }, validateStatus: () => true });
  
//   const memberIds = [];
//   if (membersResp.status === 200 && membersResp.data?.result) {
//       collectStrings(membersResp.data.result, memberIds);
//   }
  
//   if (memberIds.length === 0) {
//       throw new Error(`No computers found in group '${gName}' or you do not have permission to view them.`);
//   }
  
//   // Build the explicit target tags instead of using CustomRelevance
//   const targetXml = memberIds.map(id => `<ComputerID>${id}</ComputerID>`).join("");

//   let csvContent = null;
//   let patchesCsvContent = null;
//   let baselinePatches = [];

//   if (shouldMail) {
//     try {
//       const qServers = `names of members of bes computer group whose (id of it = ${gId})`;
//       const urlServers = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(qServers)}`;
//       const serversResp = await axios.get(urlServers, { ...bfAuthOpts, headers: { Accept: "application/json" } });
//       if (serversResp.status === 200) {
//         const serverNames = Array.isArray(serversResp.data?.result) ? serversResp.data.result : [];
//         csvContent = toCSV(serverNames);
//       }
      
//       // FETCH PATCHES
//       baselinePatches = await fetchBaselinePatches(ctx.bigfix, baselineName, bfAuthOpts);
//       patchesCsvContent = patchesToCSV(baselinePatches);
//     } catch (e) { log(req, "Failed to query server list for CSV:", e.message); }
//   }

//   // 🚀 Calculate EndDateTimeLocalOffset
//   const tzMs = localUtcOffsetMs(); 
//   const deltaMs = pwMs - tzMs;
//   const endDateTimeLocalOffsetVal = msToXSDuration(deltaMs);

//   const stageName = environment || "Pilot";
//   const actionTitle = `BPS_${baselineName}_${stageName}`;
  
//   // Removed CustomRelevance, Added Explicit Targets & HasEndTime/EndDateTimeLocalOffset Settings
//   const xml = `<?xml version="1.0" encoding="UTF-8"?>
// <BES xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="BES.xsd">
//   <SourcedFixletAction>
//     <SourceFixlet>
//       <Sitename>${escapeXML(siteName)}</Sitename>
//       <FixletID>${escapeXML(fixletId)}</FixletID>
//       <Action>Action1</Action>
//     </SourceFixlet>
//     <Target>
//       ${targetXml}
//     </Target>
//     <Settings>
//       <HasEndTime>true</HasEndTime>
//       <EndDateTimeLocalOffset>${escapeXML(endDateTimeLocalOffsetVal)}</EndDateTimeLocalOffset>
//       <UseUTCTime>true</UseUTCTime>
//     </Settings>
//     <Title>${escapeXML(actionTitle)}</Title>
//   </SourcedFixletAction>
// </BES>`;

//   const bfPostUrl = joinUrl(BIGFIX_BASE_URL, "/api/actions");
//   const bfResp = await axios.post(bfPostUrl, xml, { ...bfAuthOpts, headers: { "Content-Type": "text/xml" }, timeout: 60_000, validateStatus: () => true, responseType: "text" });
//   if (bfResp.status < 200 || bfResp.status >= 300) throw new Error(`BigFix POST failed: HTTP ${bfResp.status} ${String(bfResp.data).slice(0, 200)}`);

//   const actionId = extractActionIdFromXml(String(bfResp.data || ""));
//   const smtpReady = !!(ctx.smtp && ctx.smtp.SMTP_HOST && ctx.smtp.SMTP_FROM);
//   let emailError = null;

//   if (actionId) {
//     const metadata = { 
//         id: actionId, createdAt: new Date().toISOString(), expiresAt, stage: stageName, xml, baselineName, baselineSite: siteName, 
//         baselineFixletId: fixletId, groupName: gName, groupId: gId, groupSite: gSite, groupType: gType, 
//         endOffset: endDateTimeLocalOffsetVal, preMail: shouldMail, smtpEnabled: smtpReady, postMailSent: false, triggeredBy: triggeredBy || "Unknown" 
//     };
//     actionStore.lastActionId = actionId;
//     actionStore.actions[actionId] = metadata;

//     if (stageName.toLowerCase() === "pilot") { CONFIG.lastPilotBaseline = baselineName; CONFIG.lastPilotGroup = gName; } 
//     else if (stageName.toLowerCase() === "production") { CONFIG.lastProdBaseline = baselineName; CONFIG.lastProdGroup = gName; }
//     try { await saveConfigToDB(CONFIG, req, log); } catch(e) {}

//     try {
//       const pool = await getPool();
//       await pool.request().input('ActionID', sql.Int, Number(actionId)).input('Metadata', sql.NVarChar(sql.MAX), JSON.stringify(metadata)).input('PostMailSent', sql.Bit, 0).query(`INSERT INTO dbo.ActionHistory (ActionID, Metadata, PostMailSent, CreatedAt) VALUES (@ActionID, @Metadata, @PostMailSent, SYSUTCDATETIME())`);
//     } catch (dbErr) {}

//     scheduleActionStop(ctx, actionId, metadata);
//   }

//   if (shouldMail && smtpReady) { 
//     try {
//       await sendTriggerMail(ctx.smtp, { environment: stageName, baselineName, baselineSite: siteName, baselineFixletId: fixletId, groupName: gName, groupId: gId, groupSite: gSite, groupType: gType, actionId, endOffset: endDateTimeLocalOffsetVal, emailTo: mailTo, emailFrom: mailFrom, emailCc: mailCc, emailBcc: mailBcc, SMTP_FROM: ctx.smtp.SMTP_FROM, SMTP_TO: ctx.smtp.SMTP_TO, SMTP_CC: ctx.smtp.SMTP_CC, SMTP_BCC: ctx.smtp.SMTP_BCC, csvContent, patchesCsvContent, baselinePatches });
//       console.log(`[Pilot/Prod] ✅ Pre-patch mail triggered successfully for ${actionId}`);
//     } catch (e) {
//       emailError = e.message || String(e);
//       console.error(`[Pilot/Prod] ❌ Pre-patch mail failed to send for ${actionId}:`, emailError);
//     }
//   } else if (shouldMail && !smtpReady) {
//       emailError = "SMTP not properly configured (Missing HOST or FROM)";
//       console.warn(`[Pilot/Prod] ⚠️ Pre-patch mail skipped for ${actionId}:`, emailError);
//   }

//   return { actionId, siteName, fixletId, group: gName, title: actionTitle, stage: stageName, endOffset: endDateTimeLocalOffsetVal, createdAt: new Date().toISOString(), preMailError: emailError };
// }

// function attachPilotRoutes(app, ctx) {
//   const log = logFactory(ctx.DEBUG_LOG);
//   const handleStageTrigger = async (req, res, { isForced, environment }) => {
//     req._logStart = Date.now();
//     const { triggeredBy } = req.body || {}; 
//     log(req, `POST /api/${environment}/actions${isForced ? '/force' : ''}. User: [${triggeredBy || 'Unknown'}].`);

//     try {
//       const { baselineName, groupName, chgNumber, requireChg = true, autoMail, mailTo, mailFrom, mailCc, mailBcc, patchWindow } = req.body || {};
//       if (!baselineName || !groupName) return res.status(400).json({ ok: false, error: "baselineName and groupName are required" });

//       if (requireChg && !isForced) {
//         if (!chgNumber || !/^CHG/i.test(String(chgNumber))) return res.status(400).json({ ok: false, error: "Valid chgNumber required when requireChg=true and not forcing" });
//         const chk = await validateChangeNumber(String(chgNumber).toUpperCase(), ctx);
//         if (!chk.ok) return res.status(400).json({ ok: false, chgOk: false, code: chk.code || "CHG_INVALID", message: chk.message || "CHG validation failed" });
//       }

//       const frontendAutoMail = ["true", "1", "yes", "on", true, 1].includes(String(autoMail).toLowerCase());
//       const globalAutoMail = ["true", "1", "yes", "on", true, 1].includes(String(CONFIG.autoMail).toLowerCase());
//       const shouldMail = frontendAutoMail || globalAutoMail;

//       const pwMs = getPatchWindowMs(patchWindow);
//       let expiresAt = 0; 
//       if (pwMs > 0) expiresAt = Date.now() + pwMs; else return res.status(400).json({ ok: false, error: "Patch Window duration must be greater than zero." });

//       const out = await triggerBaselineAction(req, ctx, { baselineName, groupName, shouldMail, mailTo, mailFrom, mailCc, mailBcc, environment, triggeredBy, expiresAt, pwMs });
//       const payload = { ok: true, chgOk: !requireChg || isForced || true, forced: isForced, ...out };
//       return res.json(payload);

//     } catch (err) { res.status(500).json({ ok: false, error: String(err?.message || err) }); }
//   };

//   app.post("/api/pilot/actions", (req, res) => { handleStageTrigger(req, res, { isForced: false, environment: "Pilot" }); });
//   app.post("/api/pilot/actions/force", (req, res) => { handleStageTrigger(req, res, { isForced: true, environment: "Pilot" }); });
//   app.post("/api/production/actions", (req, res) => { handleStageTrigger(req, res, { isForced: false, environment: "Production" }); });
//   app.post("/api/production/actions/force", (req, res) => { handleStageTrigger(req, res, { isForced: true, environment: "Production" }); });
// }

// module.exports = { attachPilotRoutes };