const axios = require("axios");
const { joinUrl, escapeXML, getBfAuthContext, getSessionUser, getSessionRole } = require("../../utils/http");
const { collectStrings, extractActionIdFromXml } = require("../../utils/query"); 
const { actionStore, CONFIG } = require("../../state/store");
const { logFactory } = require("../../utils/log");
const { sendTriggerMail } = require("../../mail/transport");
const { sql, getPool } = require("../../db/mssql"); 
const { saveConfigToDB } = require("../../routes/config"); 
const { scheduleActionStop } = require("../../services/postpatchWatcher");
const { getCtx } = require("../../env");
const { getRoleAssets, isMasterOperator } = require("../../services/bigfix");

const { toCSV, getPatchWindowMs, msToXSDuration, localUtcOffsetMs, fetchBaselinePatches, patchesToCSV, validateChangeNumber } = require("../../utils/deploymentHelpers");

async function handleProductionTrigger(req, res, isForced) {
    const ctx = getCtx();
    const log = logFactory(ctx.DEBUG_LOG);
    req._logStart = Date.now();
    const { triggeredBy, baselineName, groupName, chgNumber, requireChg = true, autoMail, mailTo, mailFrom, mailCc, mailBcc, patchWindow } = req.body || {}; 
    const environment = "Production";
    
    log(req, `POST /api/production/actions${isForced ? '/force' : ''}. User: [${triggeredBy || 'Unknown'}].`);

    try {
      if (!baselineName || !groupName) return res.status(400).json({ ok: false, error: "baselineName and groupName are required" });

      if (requireChg && !isForced) {
        if (!chgNumber || !/^CHG/i.test(String(chgNumber))) return res.status(400).json({ ok: false, error: "Valid chgNumber required when requireChg=true and not forcing" });
        const chk = await validateChangeNumber(String(chgNumber).toUpperCase(), ctx);
        if (!chk.ok) return res.status(400).json({ ok: false, chgOk: false, code: chk.code || "CHG_INVALID", message: chk.message || "CHG validation failed" });
      }

      const frontendAutoMail = ["true", "1", "yes", "on", true, 1].includes(String(autoMail).toLowerCase());
      const globalAutoMail = ["true", "1", "yes", "on", true, 1].includes(String(CONFIG.autoMail).toLowerCase());
      const shouldMail = frontendAutoMail || globalAutoMail;

      const pwMs = getPatchWindowMs(patchWindow);
      if (pwMs <= 0) return res.status(400).json({ ok: false, error: "Patch Window duration must be greater than zero." });
      
      const tzMs = localUtcOffsetMs(); 
      const deltaMs = pwMs - tzMs;
      const endDateTimeLocalOffsetVal = msToXSDuration(deltaMs);
      const expiresAt = Date.now() + pwMs;

      // BigFix API Execution
      const { BIGFIX_BASE_URL } = ctx.bigfix;
      const bfAuthOpts = await getBfAuthContext(req, ctx);

      // Baseline Lookup
      const urlBaseline = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(`(name of site of it, id of it) of bes baseline whose (name of it is "${baselineName.replace(/"/g, '\\"')}")`)}`;
      const baselineResp = await axios.get(urlBaseline, { ...bfAuthOpts, headers: { Accept: "application/json" }, validateStatus: () => true });
      if (baselineResp.status < 200 || baselineResp.status >= 300) throw new Error(`Baseline lookup failed: HTTP ${baselineResp.status}`);
      const baselineRows = Array.isArray(baselineResp.data?.result) ? baselineResp.data.result : [];
      if (!baselineRows.length) throw new Error(`Baseline not found: ${baselineName}`);
      const partsB = []; collectStrings(baselineRows[0], partsB);
      const siteName = partsB[0]; const fixletId = partsB[1];

      // Group Lookup
      const urlGroup = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(`(name of it, id of it, name of site of it, (if automatic flag of it then "Automatic" else if manual flag of it then "manual" else "server based")) of bes computer group whose (name of it is "${groupName.replace(/"/g, '\\"')}")`)}`;
      const groupResp = await axios.get(urlGroup, { ...bfAuthOpts, headers: { Accept: "application/json" }, validateStatus: () => true });
      const groupRows = Array.isArray(groupResp.data?.result) ? groupResp.data.result : [];
      if (!groupRows.length) throw new Error(`Group '${groupName}' does not exist in BigFix.`);
      const partsG = []; collectStrings(groupRows[0], partsG);
      const gName = partsG[0], gId = partsG[1], gSite = partsG[2], gType = partsG[3];

      // Target Computers (WITH RBAC FILTERING)
      const activeUser = getSessionUser(req);
      const activeRole = req.headers['x-user-role'] || getSessionRole(req);
      const isMO = await isMasterOperator(req, ctx, activeUser);

      let compFilter = "";
      if (!isMO) {
          if (!activeRole || activeRole === "No Role Assigned") {
              return res.status(403).json({ ok: false, error: "No role assigned. Cannot trigger action." });
          } else if (activeRole !== "Admin") {
              const roleAssets = await getRoleAssets(req, ctx, activeRole);
              if (roleAssets.found && roleAssets.compNames && roleAssets.compNames.length > 0) {
                  const names = roleAssets.compNames.map(n => `"${n.toLowerCase()}"`).join(";");
                  compFilter = ` whose (name of it as lowercase is contained by set of (${names}))`;
              } else {
                  return res.status(403).json({ ok: false, error: "You do not have access to any computers to deploy this action." });
              }
          }
      }

      const urlMemberIds = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(`(id of it as string) of (members of bes computer group whose (id of it = ${gId}))${compFilter}`)}`;
      const membersResp = await axios.get(urlMemberIds, { ...bfAuthOpts, headers: { Accept: "application/json" }, validateStatus: () => true });
      const memberIds = [];
      if (membersResp.status === 200 && membersResp.data?.result) collectStrings(membersResp.data.result, memberIds);
      if (memberIds.length === 0) throw new Error(`No computers found in group '${gName}' or you do not have permission to deploy to them.`);
      const targetXml = memberIds.map(id => `<ComputerID>${id}</ComputerID>`).join("");

      // XML & Trigger
      const actionTitle = `BPS_${baselineName}_${environment}`;
      const xml = `<?xml version="1.0" encoding="UTF-8"?><BES xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="BES.xsd"><SourcedFixletAction><SourceFixlet><Sitename>${escapeXML(siteName)}</Sitename><FixletID>${escapeXML(fixletId)}</FixletID><Action>Action1</Action></SourceFixlet><Target>${targetXml}</Target><Settings><HasEndTime>true</HasEndTime><EndDateTimeLocalOffset>${escapeXML(endDateTimeLocalOffsetVal)}</EndDateTimeLocalOffset><UseUTCTime>true</UseUTCTime></Settings><Title>${escapeXML(actionTitle)}</Title></SourcedFixletAction></BES>`;

      const bfPostUrl = joinUrl(BIGFIX_BASE_URL, "/api/actions");
      const bfResp = await axios.post(bfPostUrl, xml, { ...bfAuthOpts, headers: { "Content-Type": "text/xml" }, validateStatus: () => true, responseType: "text" });
      if (bfResp.status < 200 || bfResp.status >= 300) throw new Error(`BigFix POST failed: HTTP ${bfResp.status}`);

      const actionId = extractActionIdFromXml(String(bfResp.data || ""));
      let emailError = null;

      if (actionId) {
        const smtpReady = !!(ctx.smtp && ctx.smtp.SMTP_HOST && ctx.smtp.SMTP_FROM);
        const metadata = { id: actionId, createdAt: new Date().toISOString(), expiresAt, stage: environment, xml, baselineName, baselineSite: siteName, baselineFixletId: fixletId, groupName: gName, groupId: gId, groupSite: gSite, groupType: gType, endOffset: endDateTimeLocalOffsetVal, preMail: shouldMail, smtpEnabled: smtpReady, postMailSent: false, triggeredBy: triggeredBy || "Unknown" };
        actionStore.lastActionId = actionId;
        actionStore.actions[actionId] = metadata;

        CONFIG.lastProdBaseline = baselineName; CONFIG.lastProdGroup = gName;
        try { await saveConfigToDB(CONFIG, req, log); } catch(e) {}
        try { const pool = await getPool(); await pool.request().input('ActionID', sql.Int, Number(actionId)).input('Metadata', sql.NVarChar(sql.MAX), JSON.stringify(metadata)).input('PostMailSent', sql.Bit, 0).query(`INSERT INTO dbo.ActionHistory (ActionID, Metadata, PostMailSent, CreatedAt) VALUES (@ActionID, @Metadata, @PostMailSent, SYSUTCDATETIME())`); } catch (dbErr) {}

        scheduleActionStop(ctx, actionId, metadata);

        if (shouldMail && smtpReady) { 
            let csvContent = null, patchesCsvContent = null, baselinePatches = [];
            try {
              const serversResp = await axios.get(`${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(`names of (members of bes computer group whose (id of it = ${gId}))${compFilter}`)}`, { ...bfAuthOpts, headers: { Accept: "application/json" } });
              csvContent = toCSV(Array.isArray(serversResp.data?.result) ? serversResp.data.result : []);
              baselinePatches = await fetchBaselinePatches(ctx.bigfix, baselineName, bfAuthOpts);
              patchesCsvContent = patchesToCSV(baselinePatches);
            } catch(e){}
            
            try {
              await sendTriggerMail(ctx.smtp, { environment, baselineName, baselineSite: siteName, baselineFixletId: fixletId, groupName: gName, groupId: gId, groupSite: gSite, groupType: gType, actionId, endOffset: endDateTimeLocalOffsetVal, emailTo: mailTo, emailFrom: mailFrom, emailCc: mailCc, emailBcc: mailBcc, SMTP_FROM: ctx.smtp.SMTP_FROM, SMTP_TO: ctx.smtp.SMTP_TO, SMTP_CC: ctx.smtp.SMTP_CC, SMTP_BCC: ctx.smtp.SMTP_BCC, csvContent, patchesCsvContent, baselinePatches });
            } catch (e) { emailError = e.message; }
        }
      }

      res.json({ ok: true, chgOk: !requireChg || isForced || true, forced: isForced, actionId, siteName, fixletId, group: gName, title: actionTitle, stage: environment, endOffset: endDateTimeLocalOffsetVal, createdAt: new Date().toISOString(), preMailError: emailError });

    } catch (err) { res.status(500).json({ ok: false, error: String(err?.message || err) }); }
}

const triggerProduction = (req, res) => handleProductionTrigger(req, res, false);
const triggerProductionForce = (req, res) => handleProductionTrigger(req, res, true);

module.exports = { triggerProduction, triggerProductionForce };