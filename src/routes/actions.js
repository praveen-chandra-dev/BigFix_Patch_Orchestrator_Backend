// src/routes/actions.js
const axios = require("axios");
const { joinUrl, toLowerSafe } = require("../utils/http");
const { collectStrings, extractActionIdFromXml } = require("../utils/query");
const { actionStore } = require("../state/store");
const { logFactory } = require("../utils/log");
const { sendTriggerMail } = require("../mail/transport");
const { sql, getPool } = require("../db/mssql"); 

/** CSV helper */
function toCSV(serverList) {
  if (!serverList || serverList.length === 0) return null;
  const header = "ServerName";
  const rows = serverList.map((name) => `"${String(name).replace(/"/g, '""')}"`);
  return [header, ...rows].join("\r\n");
}

function attachActionsRoutes(app, ctx) {
  const log = logFactory(ctx.DEBUG_LOG);

  const { BIGFIX_BASE_URL, BIGFIX_USER, BIGFIX_PASS, httpsAgent } = ctx.bigfix;
  const { SMTP_FROM, SMTP_TO, SMTP_CC, SMTP_BCC } = ctx.smtp;

  const xmlEscape = (s) =>
    String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");

  // ---------------- Time helpers ----------------

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

    if (timeParts.length) {
      out += `T${timeParts.join("")}`;
    } else if (!days) {
      out = "T0S";
    }

    return (neg ? "-" : "") + "P" + out;
  }

  function localUtcOffsetMs() {
    const offsetMin = new Date().getTimezoneOffset(); 
    return -offsetMin * 60000; 
  }

  // --- RESTART SINGLE (Legacy support) ---
  app.post("/api/actions/restart", async (req, res) => {
    const { computerName } = req.body;
    if (!computerName) return res.status(400).json({ ok: false, error: "computerName is required" });
    return handleBulkRestart(req, res, [computerName]);
  });

  // --- NEW: BULK RESTART ENDPOINT ---
  app.post("/api/actions/restart-bulk", async (req, res) => {
    const { computerNames } = req.body;
    if (!Array.isArray(computerNames) || computerNames.length === 0) {
      return res.status(400).json({ ok: false, error: "computerNames array is required" });
    }
    return handleBulkRestart(req, res, computerNames);
  });

  // Shared Logic for Restart
  async function handleBulkRestart(req, res, computerNames) {
    req._logStart = Date.now();
    log(req, "Bulk Restart Request:", computerNames);

    try {
      const safeNames = computerNames.map(n => `"${n.toLowerCase().replace(/"/g, '\\"')}"`).join("; ");
      const relevance = `(id of it) of bes computers whose (name of it as lowercase is contained by set of (${safeNames}))`;
      
      const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
      log(req, "Restart: ComputerID query →", url);

      const resp = await axios.get(url, {
        httpsAgent,
        auth: { username: BIGFIX_USER, password: BIGFIX_PASS },
        headers: { Accept: "application/json" },
        responseType: "json",
        timeout: 60_000,
        validateStatus: () => true,
      });

      if (resp.status < 200 || resp.status >= 300) {
        throw new Error(`BigFix query failed: HTTP ${resp.status}`);
      }

      const ids = [];
      collectStrings(resp.data?.result, ids);

      if (ids.length === 0) {
        return res.status(404).json({ ok: false, error: "No valid Computer IDs found for provided names." });
      }

      const targetXml = ids.map(id => `<ComputerID>${id}</ComputerID>`).join("");
      const actionTitle = `BPS_Restart_Bulk_${ids.length}_Computers`;

      const xml = `<?xml version="1.0" encoding="utf-8"?>
<BES xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" SkipUI="true">
    <SingleAction>
        <Title>${xmlEscape(actionTitle)}</Title>
        <Relevance>true</Relevance>
        <ActionScript>restart 60</ActionScript>
		<SuccessCriteria Option="RunToCompletion"></SuccessCriteria>
		<Settings />
        <SettingsLocks />
        <Target>
			${targetXml}
		</Target>
    </SingleAction>
</BES>`;

      const bfPostUrl = joinUrl(BIGFIX_BASE_URL, "/api/actions");
      log(req, `Restart: Posting Action for ${ids.length} computers`);

      const bfResp = await axios.post(bfPostUrl, xml, {
        httpsAgent,
        auth: { username: BIGFIX_USER, password: BIGFIX_PASS },
        headers: { "Content-Type": "text/xml" },
        timeout: 60_000,
        validateStatus: () => true,
        responseType: "text",
      });

      if (bfResp.status < 200 || bfResp.status >= 300) {
        throw new Error(`BigFix POST failed: HTTP ${bfResp.status}`);
      }

      const bodyText = String(bfResp.data || "");
      const actionId = extractActionIdFromXml(bodyText); 
      
      log(req, `Restart Success. Action ID: ${actionId}`);
      res.json({ ok: true, actionId, count: ids.length, computerNames });

    } catch (err) {
      log(req, "Bulk Restart Error:", err?.message || err);
      res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  }

  // --- SERVICE RESTART ---
  app.post("/api/actions/service-restart", async (req, res) => {
    req._logStart = Date.now();
    const { computerName } = req.body;
    log(req, "POST /api/actions/service-restart body:", req.body);

    if (!computerName) {
      return res.status(400).json({ ok: false, error: "computerName is required" });
    }

    let computerId = null;
    try {
      const safeComputerName = computerName.toLowerCase().replace(/"/g, '\\"');
      const relevance = `(ids of it) of bes computers whose (name of it as lowercase = "${safeComputerName}")`;
      const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
      const resp = await axios.get(url, {
        httpsAgent,
        auth: { username: BIGFIX_USER, password: BIGFIX_PASS },
        headers: { Accept: "application/json" },
        responseType: "json",
        timeout: 60_000,
        validateStatus: () => true,
      });
      if (resp.status < 200 || resp.status >= 300) throw new Error(`BigFix query failed: HTTP ${resp.status}`);
      const parts = []; collectStrings(resp.data?.result, parts); 
      if (parts.length === 0 || !/^\d+$/.test(parts[0])) return res.status(404).json({ ok: false, error: "Computer not found." });
      computerId = parts[0];
      const xml = `<?xml version="1.0" encoding="utf-8"?><BES xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" SkipUI="true"><SingleAction><Title>BPS_Window_Update_Service_Restart-${xmlEscape(computerName)}</Title><Relevance>true</Relevance><ActionScript>waithidden cmd.exe /c sc config wuauserv start= autowaithidden cmd.exe /c sc start wuauserv</ActionScript><SuccessCriteria Option="RunToCompletion"></SuccessCriteria><Settings /><SettingsLocks /><Target><ComputerID>${computerId}</ComputerID></Target></SingleAction></BES>`;
      const bfPostUrl = joinUrl(BIGFIX_BASE_URL, "/api/actions");
      const bfResp = await axios.post(bfPostUrl, xml, {
        httpsAgent,
        auth: { username: BIGFIX_USER, password: BIGFIX_PASS },
        headers: { "Content-Type": "text/xml" },
        timeout: 60_000,
        validateStatus: () => true,
        responseType: "text",
      });
      if (bfResp.status < 200 || bfResp.status >= 300) throw new Error(`BigFix POST failed: HTTP ${bfResp.status}`);
      const bodyText = String(bfResp.data || "");
      const actionId = extractActionIdFromXml(bodyText); 
      res.json({ ok: true, actionId, computerId, computerName });
    } catch (err) {
      log(req, "POST /api/actions/service-restart error:", err?.message || err);
      res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });


  // --------------- Core trigger ---------------
  async function triggerAction(req, res, forcedEnvironment) {
    req._logStart = Date.now();
    let csvContent = null;
    let gName = "", gId = "", gSite = "", gType = "";
    let emailError = null;
    let siteName = "", fixletId = ""; 

    const body = req.body || {};
    const {
      baselineName, groupName, autoMail, mailTo, mailFrom, mailCc, mailBcc, environment,
      patchWindow, enddatetimelocaloffset, endOffsetHours, endOffset, triggeredBy // <--- NEW Extract
    } = body;

    const shouldMail = ["true", "1", "yes", "on", true, 1].includes(String(autoMail).toLowerCase());

    // --- AUDIT LOGGING ---
    log(req, `POST trigger action. User: [${triggeredBy || 'Unknown'}]. Body:`, body);

    try {
      if (!baselineName || !groupName) {
        return res.status(400).json({ ok: false, error: "baselineName and groupName are required" });
      }

      // 1) Baseline lookup
      const qBaseline = `(name of site of it, id of it) of bes baseline whose (name of it is "${baselineName.replace(/"/g, '\\"')}")`;
      const urlBaseline = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(qBaseline)}`;
      const baselineResp = await axios.get(urlBaseline, {
        httpsAgent,
        auth: { username: BIGFIX_USER, password: BIGFIX_PASS },
        headers: { Accept: "application/json" },
        responseType: "json",
        timeout: 60_000,
        validateStatus: () => true,
      });
      if (baselineResp.status < 200 || baselineResp.status >= 300) {
        return res.status(baselineResp.status).send(baselineResp.data);
      }
      const baselineRows = Array.isArray(baselineResp.data?.result) ? baselineResp.data.result : [];

      if (!baselineRows.length) return res.status(404).json({ ok: false, error: `Baseline not found: ${baselineName}` });
      {
        const parts = [];
        collectStrings(baselineRows[0], parts);
        if (parts.length >= 2) {
          siteName = parts[0];
          fixletId = parts[1];
        } else
          return res.status(500).json({ ok: false, error: "Unexpected baseline query shape" });
      }

      // 2) Group lookup (WITH SELF-HEALING)
      const qGroup = `(name of it, id of it, name of site of it, (if automatic flag of it then "Automatic" else if manual flag of it then "manual" else "server based")) of bes computer group whose (name of it is "${groupName.replace(/"/g, '\\"')}")`;
      const urlGroup = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(qGroup)}`;
      const groupResp = await axios.get(urlGroup, {
        httpsAgent,
        auth: { username: BIGFIX_USER, password: BIGFIX_PASS },
        headers: { Accept: "application/json" },
        responseType: "json",
        timeout: 60_000,
        validateStatus: () => true,
      });
      if (groupResp.status < 200 || groupResp.status >= 300) {
        return res.status(groupResp.status).send(groupResp.data);
      }
      const groupRows = Array.isArray(groupResp.data?.result) ? groupResp.data.result : [];

      if (!groupRows.length) {
        // --- SELF-HEALING START ---
        console.log(`[ActionsSync] Group '${groupName}' not found in BigFix. Checking local DB...`);
        const pool = await getPool();
        
        // Check if this group exists in our AssetOwnership table
        const dbCheck = await pool.request()
            .input('Name', sql.NVarChar(255), groupName)
            .query("SELECT BigFixID FROM dbo.AssetOwnership WHERE AssetName = @Name AND AssetType = 'Group'");
        
        if (dbCheck.recordset.length > 0) {
            // It exists in DB but NOT in BigFix -> It was deleted from Console.
            console.log(`[ActionsSync] 'Ghost' group detected. Removing '${groupName}' from database.`);
            
            // Instantly delete from DB
            await pool.request()
               .input('Name', sql.NVarChar(255), groupName)
               .query("DELETE FROM dbo.AssetOwnership WHERE AssetName = @Name AND AssetType = 'Group'");
               
            // Return clear error
            return res.status(404).json({ ok: false, error: `Group '${groupName}' was deleted from the BigFix Console. It has been removed from your list. Please create it again.` });
        } else {
            return res.status(404).json({ ok: false, error: `Group not found: ${groupName}` });
        }
        // --- SELF-HEALING END ---
      }

      {
        const parts = [];
        collectStrings(groupRows[0], parts);
        if (parts.length >= 4) [gName, gId, gSite, gType] = parts;
        else return res.status(500).json({ ok: false, error: "Unexpected group query shape" });
      }

      // 3) Optional server CSV for email
      if (shouldMail) {
        try {
          const qServers = `names of members of bes computer group whose (id of it = ${gId})`;
          const urlServers = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(qServers)}`;
          const serversResp = await axios.get(urlServers, {
            httpsAgent,
            auth: { username: BIGFIX_USER, password: BIGFIX_PASS },
            headers: { Accept: "application/json" },
            responseType: "json",
            timeout: 60_000,
            validateStatus: () => true,
          });

          if (serversResp.status === 200) {
            const serverNames = Array.isArray(serversResp.data?.result) ? serversResp.data.result : [];
            csvContent = toCSV(serverNames);
          }
        } catch (e) {
          log(req, "Failed to get server list for CSV:", e.message);
        }
      }

      // 4) Target relevance
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

      // 5) Build EndDateTimeLocalOffset
      const timeInput = patchWindow || endOffsetHours || endDateTimeLocalOffset || enddatetimelocaloffset || endOffset;
      const pwMs = getPatchWindowMs(timeInput);

      if (pwMs <= 0) {
        return res.status(400).json({ ok: false, error: "Patch Window duration must be greater than zero. Please set a valid duration." });
      }
      const tzMs = localUtcOffsetMs(); 
      const deltaMs = pwMs - tzMs;
      const endDateTimeLocalOffsetVal = msToXSDuration(deltaMs);

      log(req, "Computed EndDateTimeLocalOffset:", endDateTimeLocalOffsetVal, "(pwMs:", pwMs, "tzMs:", tzMs, ")");

      // 6) Build Action XML
      const envLabel = (forcedEnvironment || environment || "Sandbox").toString().trim();
      const actionTitle = `BPS_${baselineName}_${envLabel}`;

      const xml =
        `<?xml version="1.0" encoding="UTF-8"?>` +
        `<BES xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="BES.xsd">` +
        `  <SourcedFixletAction>` +
        `    <SourceFixlet>` +
        `      <Sitename>${xmlEscape(siteName)}</Sitename>` +
        `      <FixletID>${xmlEscape(fixletId)}</FixletID>` +
        `      <Action>Action1</Action>` +
        `    </SourceFixlet>` +
        `    <Target>` +
        `      <CustomRelevance>${xmlEscape(customRelevance)}</CustomRelevance>` +
        `    </Target>` +
        `    <Settings>` +
        `      <HasEndTime>true</HasEndTime>` +
        `      <EndDateTimeLocalOffset>${xmlEscape(endDateTimeLocalOffsetVal)}</EndDateTimeLocalOffset>` +
        `      <UseUTCTime>true</UseUTCTime>` +
        `    </Settings>` +
        `    <Title>${xmlEscape(actionTitle)}</Title>` +
        `  </SourcedFixletAction>` +
        `</BES>`;

      const bfPostUrl = joinUrl(BIGFIX_BASE_URL, "/api/actions");
      const bfResp = await axios.post(bfPostUrl, xml, {
        httpsAgent,
        auth: { username: BIGFIX_USER, password: BIGFIX_PASS },
        headers: { "Content-Type": "text/xml" },
        timeout: 60_000,
        validateStatus: () => true,
        responseType: "text",
      });
      if (bfResp.status < 200 || bfResp.status >= 300) {
        log(req, "BigFix POST error body (first 300):", String(bfResp.data).slice(0, 300));
        return res.status(bfResp.status).send(typeof bfResp.data === "string" ? bfResp.data : JSON.stringify(bfResp.data));
      }

      const bodyText = String(bfResp.data || "");
      const actionId = extractActionIdFromXml(bodyText);

      // Determine if SMTP is ready at this moment
      const smtpReady = !!(ctx.smtp && ctx.smtp.SMTP_HOST && ctx.smtp.SMTP_FROM);

      // Save to both Cache and DB
      if (actionId) {
        const metadata = {
          id: actionId,
          createdAt: new Date().toISOString(),
          stage: envLabel, 
          xml,
          baselineName,
          baselineSite: siteName,
          baselineFixletId: fixletId,
          groupName: gName,
          groupId: gId,
          groupSite: gSite,
          groupType: gType,
          endOffset: endDateTimeLocalOffsetVal,
          preMail: !!shouldMail,
          smtpEnabled: smtpReady,
          postMailSent: false,
          triggeredBy: triggeredBy || "Unknown", // <--- SAVE TRIGGER USER
        };

        actionStore.lastActionId = actionId;
        actionStore.actions[actionId] = metadata;

        try {
          const pool = await getPool();
          await pool.request()
            .input("ActionID", sql.Int, Number(actionId))
            .input("Metadata", sql.NVarChar(sql.MAX), JSON.stringify(metadata))
            .input("PostMailSent", sql.Bit, 0)
            .query(`
              INSERT INTO dbo.ActionHistory (ActionID, Metadata, PostMailSent, CreatedAt)
              VALUES (@ActionID, @Metadata, @PostMailSent, SYSUTCDATETIME())
            `);
          log(req, `[${envLabel}] Action ${actionId} saved to DB.`);
        } catch (dbErr) {
          log(req, `[${envLabel}] FAILED to save Action ${actionId} to DB:`, dbErr.message);
        }
      }

      if (shouldMail && smtpReady) {
        try {
          const smtpCtx = ctx.smtp;
          const info = await sendTriggerMail(smtpCtx, {
            environment: envLabel,
            baselineName,
            baselineSite: siteName,
            baselineFixletId: fixletId,
            groupName: gName,
            groupId: gId,
            groupSite: gSite,
            groupType: gType,
            actionId,
            endOffset: endDateTimeLocalOffsetVal,
            emailTo: mailTo,
            emailFrom: mailFrom,
            emailCc: mailCc,
            emailBcc: mailBcc,
            SMTP_FROM,
            SMTP_TO,
            SMTP_CC,
            SMTP_BCC,
            csvContent,
          });
          log(req, `[${envLabel}-mail] sent`, info);
        } catch (e) {
          emailError = e.message || String(e);
          log(req, `[${envLabel}-mail] send failed:`, emailError);
        }
      }

      return res.json({
        ok: true,
        actionId,
        siteName,
        fixletId,
        group: gName,
        title: actionTitle,
        stage: envLabel,
        endOffset: endDateTimeLocalOffsetVal, 
        createdAt: new Date().toISOString(),
        preMail: shouldMail,
        preMailError: emailError,
      });
    } catch (err) {
      log(req, "POST /api/actions error:", err?.message || err);
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  }

  // ---- routes -------------------------------------------------------------
  app.post("/api/actions", (req, res) => triggerAction(req, res, undefined));
}

module.exports = { attachActionsRoutes };