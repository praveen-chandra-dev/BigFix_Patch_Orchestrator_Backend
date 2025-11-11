// src/routes/actions.js
const axios = require("axios");
const { joinUrl, toLowerSafe } = require("../utils/http");
const { collectStrings, extractActionIdFromXml } = require("../utils/query");
const { actionStore } = require("../state/store");
const { logFactory } = require("../utils/log");
const { sendTriggerMail } = require("../mail/transport");
const { sql, getPool } = require("../db/mssql"); // <-- NEW: Import SQL

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


  /** Return patch window in milliseconds (from {days,hours,minutes} OR legacy number hours) */
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

  /**
   * Format a signed millisecond delta to xs:duration.

   * e.g., -5h20m  => "-PT5H20M"
   * 2d 1m  => "P2DT1M"
   */
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

      // nothing non-zero → 0 seconds (shouldn't happen as we guard earlier)
      out = "T0S";
    }

    return (neg ? "-" : "") + "P" + out;
  }

  /** get local UTC offset in ms as a positive value for "ahead of UTC" zones (IST => +5:30 => +330 min) */
  function localUtcOffsetMs() {

    // getTimezoneOffset = minutes behind UTC. IST => -330.
    // Convert to "ahead of UTC" milliseconds: tzMs = -offsetMin * 60000.
    const offsetMin = new Date().getTimezoneOffset(); // IST => -330

    return -offsetMin * 60000; // IST => +19,800,000 ms
  }

  // --------------- Core trigger ---------------
  async function triggerAction(req, res, forcedEnvironment) {

    req._logStart = Date.now();
    let csvContent = null;
    let gName = "", gId = "", gSite = "", gType = "";
    let emailError = null;
    let siteName = "", fixletId = ""; // <-- Inhe bahar declare karein taaki store mein use kar sakein

    const shouldMail = ["true", "1", "yes", "on", true, 1].includes(

      String(req.body?.autoMail).toLowerCase()
    );

    try {
      const body = req.body || {};

      const {
        baselineName,
        groupName,

        autoMail,
        mailTo,
        mailFrom,

        mailCc,
        mailBcc,
        environment,

        patchWindow, // {days,hours,minutes}
        // legacy fallbacks (ignored for new calc, kept for compatibility if provided)
        enddatetimelocaloffset,

        endOffsetHours,
        endOffset,
      } = body;


      log(req, "POST trigger body:", body);

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
      // let siteName = "", fixletId = ""; // <-- Yahan se hata dein
      {

        const parts = [];
        collectStrings(baselineRows[0], parts);
        if (parts.length >= 2) { siteName = parts[0]; fixletId = parts[1]; }
        else return res.status(500).json({ ok: false, error: "Unexpected baseline query shape" });
      }

      // 2) Group lookup

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

      if (!groupRows.length) return res.status(404).json({ ok: false, error: `Group not found: ${groupName}` });
      {
        const parts = [];

        collectStrings(groupRows[0], parts);
        if (parts.length >= 4) [gName, gId, gSite, gType] = parts;
        else return res.status(500).json({ ok: false, error: "Unexpected group query shape" });

      }

      // 3) Optional server CSV for email
      if (shouldMail) {

        try {
          const siteRef = (gSite === "ActionSite") ? 'actionsite' : `site "CustomSite_${gSite}"`;
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

      // 5) Build EndDateTimeLocalOffset:

      //    delta = patchWindowMs - localUTCoffsetMs
      //    Example (IST): patch 10m => 600000ms; tz 5h30m => 19800000ms
      //    delta = 600000 - 19800000 = -19200000ms => "-PT5H20M"

      const timeInput =
        patchWindow ||
        endOffsetHours ||

        endDateTimeLocalOffset ||
        enddatetimelocaloffset ||
        endOffset;

      const pwMs = getPatchWindowMs(timeInput);

      if (pwMs <= 0) {
        return res.status(400).json({ ok: false, error: "Patch Window duration must be greater than zero. Please set a valid duration." });
      }
      const tzMs = localUtcOffsetMs(); // IST => +19800000

      const deltaMs = pwMs - tzMs;
      const endDateTimeLocalOffset = msToXSDuration(deltaMs);

      log(req, "Computed EndDateTimeLocalOffset:", endDateTimeLocalOffset, "(pwMs:", pwMs, "tzMs:", tzMs, ")");


      // 6) Build Action XML (NO <EndDateTime>, ONLY <EndDateTimeLocalOffset> + UseUTCTime)
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
        `      <EndDateTimeLocalOffset>${xmlEscape(endDateTimeLocalOffset)}</EndDateTimeLocalOffset>` +
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

        return res
          .status(bfResp.status)
          .send(typeof bfResp.data === "string" ? bfResp.data : JSON.stringify(bfResp.data));

      }

      const bodyText = String(bfResp.data || "");
      const actionId = extractActionIdFromXml(bodyText);
      
      // --- NEW: Save to both Cache and DB ---
      if (actionId) {
        const metadata = {
          id: actionId,
          createdAt: new Date().toISOString(),
          stage: envLabel, // 'envLabel' stage hai ("Sandbox")
          xml,
          baselineName,
          baselineSite: siteName,
          baselineFixletId: fixletId,
          groupName: gName,
          groupId: gId,
          groupSite: gSite,
          groupType: gType,
          endOffset: endDateTimeLocalOffset,
          preMail: !!shouldMail,
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
          log(req, `[${envLabel}] Action ${actionId} saved to DB.`);
        } catch (dbErr) {
          // Log DB error, but don't fail the request
          log(req, `[${envLabel}] FAILED to save Action ${actionId} to DB:`, dbErr.message);
        }
      }
      // --- End NEW ---

      // Optional pre-mail
      if (shouldMail) {

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

            endOffset: endDateTimeLocalOffset,
            emailTo: mailTo,
            emailFrom: mailFrom,

            emailCc: mailCc,
            emailBcc: mailBcc,
            SMTP_FROM, SMTP_TO, SMTP_CC, SMTP_BCC,

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
        endOffset: endDateTimeLocalOffset, // what we sent to BigFix
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
  // These routes are now handled by pilot.js, but we keep the "Sandbox" one here
  // app.post("/api/pilot/actions", (req, res) => triggerAction(req, res, "Pilot"));
  // app.post("/api/pilot/actions/force", (req, res) => triggerAction(req, res, "Pilot"));
  // app.post("/api/production/actions", (req, res) => triggerAction(req, res, "Production"));
  // app.post("/api/production/actions/force", (req, res) => triggerAction(req, res, "Production"));
}

module.exports = { attachActionsRoutes };