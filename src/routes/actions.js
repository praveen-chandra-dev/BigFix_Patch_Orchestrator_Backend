// src/routes/actions.js
const axios = require("axios");
const { joinUrl, toLowerSafe, escapeXML, getBfAuthContext } = require("../utils/http");
const { collectStrings, extractActionIdFromXml, parseTupleRows } = require("../utils/query"); 
const { actionStore, CONFIG } = require("../state/store");
const { logFactory } = require("../utils/log");
const { sendTriggerMail } = require("../mail/transport");
const { sql, getPool } = require("../db/mssql"); 
const { saveConfigToDB } = require("./config");
const { scheduleActionStop } = require("../services/postpatchWatcher");

function toCSV(serverList) {
  if (!serverList || serverList.length === 0) return null;
  const header = "ServerName";
  const rows = serverList.map((name) => `"${String(name).replace(/"/g, '""')}"`);
  return [header, ...rows].join("\r\n");
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

function attachActionsRoutes(app, ctx) {
  const log = logFactory(ctx.DEBUG_LOG);
  const { BIGFIX_BASE_URL } = ctx.bigfix;
  const { SMTP_FROM, SMTP_TO, SMTP_CC, SMTP_BCC } = ctx.smtp;

  function getPatchWindowMs(patchWindow) {
    if (patchWindow && typeof patchWindow === "object") {
      const d = Number(patchWindow.days) || 0;
      const h = Number(patchWindow.hours) || 0;
      const m = Number(patchWindow.minutes) || 0;
      return d * 86400000 + h * 3600000 + m * 60000;
    }
    const legacyHours = Number(patchWindow);
    if (Number.isFinite(legacyHours) && legacyHours > 0) return legacyHours * 3600000;
    return 0;
  }

  app.post("/api/actions/restart", async (req, res) => {
    const { computerName } = req.body;
    if (!computerName) return res.status(400).json({ ok: false, error: "computerName is required" });
    return handleBulkRestart(req, res, [computerName]);
  });

  app.post("/api/actions/restart-bulk", async (req, res) => {
    const { computerNames } = req.body;
    if (!Array.isArray(computerNames) || computerNames.length === 0) return res.status(400).json({ ok: false, error: "computerNames array is required" });
    return handleBulkRestart(req, res, computerNames);
  });

  async function handleBulkRestart(req, res, computerNames) {
    req._logStart = Date.now();
    try {
      const safeNames = computerNames.map(n => `"${n.toLowerCase().replace(/"/g, '\\"')}"`).join("; ");
      const relevance = `(id of it) of bes computers whose (name of it as lowercase is contained by set of (${safeNames}))`;
      const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
      
      const bfAuthOpts = await getBfAuthContext(req, ctx); 
      const resp = await axios.get(url, { ...bfAuthOpts, headers: { Accept: "application/json" } });

      if (resp.status < 200 || resp.status >= 300) throw new Error(`BigFix query failed: HTTP ${resp.status}`);
      const ids = []; collectStrings(resp.data?.result, ids);
      if (ids.length === 0) return res.status(404).json({ ok: false, error: "No valid Computer IDs found." });

      const targetXml = ids.map(id => `<ComputerID>${id}</ComputerID>`).join("");
      
      // FIX: Added MIMEType and CDATA block to properly execute the restart command without Syntax Error
      const xml = `<?xml version="1.0" encoding="utf-8"?><BES xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" SkipUI="true"><SingleAction><Title>${escapeXML(`BPS_Restart_Bulk_${ids.length}_Computers`)}</Title><Relevance>true</Relevance><ActionScript MIMEType="application/x-Fixlet-Windows-Shell"><![CDATA[restart 60]]></ActionScript><SuccessCriteria Option="RunToCompletion"></SuccessCriteria><Settings /><SettingsLocks /><Target>${targetXml}</Target></SingleAction></BES>`;

      const bfPostUrl = joinUrl(BIGFIX_BASE_URL, "/api/actions");
      const bfResp = await axios.post(bfPostUrl, xml, {
        ...bfAuthOpts, 
        headers: { "Content-Type": "text/xml" },
        timeout: 60_000,
        validateStatus: () => true,
        responseType: "text",
      });

      if (bfResp.status < 200 || bfResp.status >= 300) throw new Error(`BigFix POST failed: HTTP ${bfResp.status}`);
      const actionId = extractActionIdFromXml(String(bfResp.data || "")); 
      res.json({ ok: true, actionId, count: ids.length, computerNames });
    } catch (err) { res.status(500).json({ ok: false, error: String(err?.message || err) }); }
  }

  app.post("/api/actions/service-restart", async (req, res) => {
    const { computerName } = req.body;
    if (!computerName) return res.status(400).json({ ok: false, error: "computerName is required" });

    try {
      const safeComputerName = computerName.toLowerCase().replace(/"/g, '\\"');
      const relevance = `(ids of it) of bes computers whose (name of it as lowercase = "${safeComputerName}")`;
      const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
      
      const bfAuthOpts = await getBfAuthContext(req, ctx); 
      const resp = await axios.get(url, { ...bfAuthOpts, headers: { Accept: "application/json" } });
      
      const parts = []; collectStrings(resp.data?.result, parts); 
      if (parts.length === 0 || !/^\d+$/.test(parts[0])) return res.status(404).json({ ok: false, error: "Computer not found." });
      
      const computerId = parts[0];
      
      // FIX: Added MIMEType, CDATA, and properly split the two commands with a newline so they aren't mashed together
      const actionScript = `waithidden cmd.exe /c sc config wuauserv start= auto\nwaithidden cmd.exe /c sc start wuauserv`;

      const xml = `<?xml version="1.0" encoding="utf-8"?><BES xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" SkipUI="true"><SingleAction><Title>BPS_Window_Update_Service_Restart-${escapeXML(computerName)}</Title><Relevance>true</Relevance><ActionScript MIMEType="application/x-Fixlet-Windows-Shell"><![CDATA[${actionScript}]]></ActionScript><SuccessCriteria Option="RunToCompletion"></SuccessCriteria><Settings /><SettingsLocks /><Target><ComputerID>${computerId}</ComputerID></Target></SingleAction></BES>`;
      
      const bfPostUrl = joinUrl(BIGFIX_BASE_URL, "/api/actions");
      const bfResp = await axios.post(bfPostUrl, xml, {
        ...bfAuthOpts, 
        headers: { "Content-Type": "text/xml" },
        timeout: 60_000,
        validateStatus: () => true,
        responseType: "text",
      });
      if (bfResp.status < 200 || bfResp.status >= 300) throw new Error(`BigFix POST failed: HTTP ${bfResp.status}`);
      
      res.json({ ok: true, actionId: extractActionIdFromXml(String(bfResp.data || "")), computerId, computerName });
    } catch (err) { res.status(500).json({ ok: false, error: String(err?.message || err) }); }
  });

  async function triggerAction(req, res, forcedEnvironment) {
    const body = req.body || {};
    const { baselineName, groupName, autoMail, mailTo, mailFrom, mailCc, mailBcc, environment, patchWindow, enddatetimelocaloffset, endOffsetHours, endOffset, triggeredBy } = body;
    
    // FIX: Check the frontend payload FIRST, but fallback to the global CONFIG.autoMail setting
    const frontendAutoMail = ["true", "1", "yes", "on", true, 1].includes(String(autoMail).toLowerCase());
    const globalAutoMail = ["true", "1", "yes", "on", true, 1].includes(String(CONFIG.autoMail).toLowerCase());
    const shouldMail = frontendAutoMail || globalAutoMail;

    try {
      if (!baselineName || !groupName) return res.status(400).json({ ok: false, error: "baselineName and groupName are required" });

      const bfAuthOpts = await getBfAuthContext(req, ctx); 

      // 1) Baseline lookup
      const qBaseline = `(name of site of it, id of it) of bes baseline whose (name of it is "${baselineName.replace(/"/g, '\\"')}")`;
      const urlBaseline = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(qBaseline)}`;
      const baselineResp = await axios.get(urlBaseline, { ...bfAuthOpts, headers: { Accept: "application/json" }, validateStatus: () => true });
      if (baselineResp.status < 200 || baselineResp.status >= 300) return res.status(baselineResp.status).send(baselineResp.data);
      
      const baselineRows = Array.isArray(baselineResp.data?.result) ? baselineResp.data.result : [];
      if (!baselineRows.length) return res.status(404).json({ ok: false, error: `Baseline not found: ${baselineName}` });
      
      let siteName = "", fixletId = "";
      const partsB = []; collectStrings(baselineRows[0], partsB);
      if (partsB.length >= 2) { siteName = partsB[0]; fixletId = partsB[1]; } else return res.status(500).json({ ok: false, error: "Unexpected baseline query shape" });

      // 2) Group lookup
      const qGroup = `(name of it, id of it, name of site of it, (if automatic flag of it then "Automatic" else if manual flag of it then "manual" else "server based")) of bes computer group whose (name of it is "${groupName.replace(/"/g, '\\"')}")`;
      const urlGroup = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(qGroup)}`;
      const groupResp = await axios.get(urlGroup, { ...bfAuthOpts, headers: { Accept: "application/json" }, validateStatus: () => true });
      if (groupResp.status < 200 || groupResp.status >= 300) return res.status(groupResp.status).send(groupResp.data);
      
      const groupRows = Array.isArray(groupResp.data?.result) ? groupResp.data.result : [];
      if (!groupRows.length) {
        const pool = await getPool();
        const dbCheck = await pool.request().input('Name', sql.NVarChar(255), groupName).query("SELECT BigFixID FROM dbo.AssetOwnership WHERE AssetName = @Name AND AssetType = 'Group'");
        if (dbCheck.recordset.length > 0) {
            await pool.request().input('Name', sql.NVarChar(255), groupName).query("DELETE FROM dbo.AssetOwnership WHERE AssetName = @Name AND AssetType = 'Group'");
            return res.status(404).json({ ok: false, error: `Group '${groupName}' was deleted from the BigFix Console. It has been removed from your list.` });
        } else return res.status(404).json({ ok: false, error: `Group not found: ${groupName}` });
      }

      let gName = "", gId = "", gSite = "", gType = "";
      const partsG = []; collectStrings(groupRows[0], partsG);
      if (partsG.length >= 4) [gName, gId, gSite, gType] = partsG; else return res.status(500).json({ ok: false, error: "Unexpected group query shape" });

      // 3) CSV & Patch Content Generation
      let csvContent = null;
      let patchesCsvContent = null;
      let baselinePatches = [];
      
      if (shouldMail) {
        try {
          const urlServers = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(`names of members of bes computer group whose (id of it = ${gId})`)}`;
          const serversResp = await axios.get(urlServers, { ...bfAuthOpts, headers: { Accept: "application/json" }, validateStatus: () => true });
          if (serversResp.status === 200) csvContent = toCSV(Array.isArray(serversResp.data?.result) ? serversResp.data.result : []);
          
          // FETCH PATCHES
          baselinePatches = await fetchBaselinePatches(ctx.bigfix, baselineName, bfAuthOpts);
          patchesCsvContent = patchesToCSV(baselinePatches);
        } catch (e) { }
      }

      // 4) Relevance & Timing
      const type = toLowerSafe(gType);
      const siteTokenForAutomatic = gSite === "ActionSite" ? `site "actionsite"` : `site "CustomSite_${gSite}"`;
      let customRelevance = type.includes("automatic") ? `exists true whose ( if true then ( member of group ${gId} of ${siteTokenForAutomatic} ) else false)` : type.includes("manual") ? `exists true whose ( if true then ( member of manual group "${gName}" of client ) else false)` : `exists true whose ( if true then ( member of server based group "${gName}" of client ) else false)`;
      
      const pwMs = getPatchWindowMs(patchWindow || endOffsetHours || enddatetimelocaloffset || endOffset);
      if (pwMs <= 0) return res.status(400).json({ ok: false, error: "Patch Window duration must be > 0" });
      
      const expiresAt = Date.now() + pwMs;

      // 5) Build & POST Action XML
      const envLabel = (forcedEnvironment || environment || "Sandbox").toString().trim();
      const actionTitle = `BPS_${baselineName}_${envLabel}`;
      
      const xml = `<?xml version="1.0" encoding="UTF-8"?><BES xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="BES.xsd"><SourcedFixletAction><SourceFixlet><Sitename>${escapeXML(siteName)}</Sitename><FixletID>${escapeXML(fixletId)}</FixletID><Action>Action1</Action></SourceFixlet><Target><CustomRelevance>${escapeXML(customRelevance)}</CustomRelevance></Target><Settings><UseUTCTime>true</UseUTCTime></Settings><Title>${escapeXML(actionTitle)}</Title></SourcedFixletAction></BES>`;

      const bfPostUrl = joinUrl(BIGFIX_BASE_URL, "/api/actions");
      const bfResp = await axios.post(bfPostUrl, xml, { ...bfAuthOpts, headers: { "Content-Type": "text/xml" }, validateStatus: () => true, responseType: "text" });
      if (bfResp.status < 200 || bfResp.status >= 300) return res.status(bfResp.status).send(typeof bfResp.data === "string" ? bfResp.data : JSON.stringify(bfResp.data));

      const actionId = extractActionIdFromXml(String(bfResp.data || ""));
      const smtpReady = !!(ctx.smtp && ctx.smtp.SMTP_HOST && ctx.smtp.SMTP_FROM);
      let emailError = null;

      if (actionId) {
        const metadata = { 
          id: actionId, createdAt: new Date().toISOString(), expiresAt, stage: envLabel, xml, baselineName, baselineSite: siteName, 
          baselineFixletId: fixletId, groupName: gName, groupId: gId, groupSite: gSite, groupType: gType, 
          preMail: shouldMail, smtpEnabled: smtpReady, postMailSent: false, triggeredBy: triggeredBy || "Unknown" 
        };
        actionStore.lastActionId = actionId; 
        actionStore.actions[actionId] = metadata;

        if (envLabel.toLowerCase() === "sandbox") {
            CONFIG.lastSandboxBaseline = baselineName;
            CONFIG.lastSandboxGroup = gName;
            try { await saveConfigToDB(CONFIG, req, log); } catch(e) {}
        }

        try {
          const pool = await getPool();
          await pool.request().input("ActionID", sql.Int, Number(actionId)).input("Metadata", sql.NVarChar(sql.MAX), JSON.stringify(metadata)).input("PostMailSent", sql.Bit, 0).query(`INSERT INTO dbo.ActionHistory (ActionID, Metadata, PostMailSent, CreatedAt) VALUES (@ActionID, @Metadata, @PostMailSent, SYSUTCDATETIME())`);
        } catch (dbErr) { }

        scheduleActionStop(ctx, actionId, metadata);
      }

      // 6) Send Pre-Patch Trigger Mail
      if (shouldMail && smtpReady) {
        try { 
            await sendTriggerMail(ctx.smtp, { environment: envLabel, baselineName, baselineSite: siteName, baselineFixletId: fixletId, groupName: gName, groupId: gId, groupSite: gSite, groupType: gType, actionId, emailTo: mailTo, emailFrom: mailFrom, emailCc: mailCc, emailBcc: mailBcc, SMTP_FROM, SMTP_TO, SMTP_CC, SMTP_BCC, csvContent, patchesCsvContent, baselinePatches }); 
            console.log(`[Sandbox] Pre-patch mail triggered successfully for ${actionId}`);
        } catch (e) { 
            emailError = e.message || String(e); 
            console.error(`[Sandbox] Pre-patch mail failed to send for ${actionId}:`, emailError);
        }
      } else if (shouldMail && !smtpReady) {
          emailError = "SMTP not properly configured (Missing HOST or FROM)";
          console.warn(`[Sandbox] Pre-patch mail skipped for ${actionId}:`, emailError);
      }

      return res.json({ ok: true, actionId, siteName, fixletId, group: gName, title: actionTitle, stage: envLabel, createdAt: new Date().toISOString(), preMail: shouldMail, preMailError: emailError });
    } catch (err) { return res.status(500).json({ ok: false, error: err?.response?.data || err.message }); }
  }

  app.post("/api/actions", (req, res) => triggerAction(req, res, undefined));
}

module.exports = { attachActionsRoutes };