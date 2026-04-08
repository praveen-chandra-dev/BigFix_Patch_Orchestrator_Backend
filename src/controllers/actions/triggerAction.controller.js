const axios = require("axios");
// const { joinUrl, escapeXML, getBfAuthContext } = require("../../utils/http");
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


const { toCSV, getPatchWindowMs, msToXSDuration, localUtcOffsetMs, fetchBaselinePatches, patchesToCSV } = require("../../utils/deploymentHelpers");

async function triggerAction(req, res) {
  const ctx = getCtx();
  const log = logFactory(ctx.DEBUG_LOG);
  const { BIGFIX_BASE_URL } = ctx.bigfix;
  const { SMTP_FROM, SMTP_TO, SMTP_CC, SMTP_BCC } = ctx.smtp;

  const forcedEnvironment = undefined; 
  const body = req.body || {};
//   const { baselineName, groupName, autoMail, mailTo, mailFrom, mailCc, mailBcc, environment, patchWindow, enddatetimelocaloffset, endOffsetHours, endOffset, triggeredBy } = body;
  

  const { deployments, autoMail, mailTo, mailFrom, mailCc, mailBcc, environment, patchWindow, enddatetimelocaloffset, endOffsetHours, endOffset, triggeredBy } = body;
  
  const frontendAutoMail = ["true", "1", "yes", "on", true, 1].includes(String(autoMail).toLowerCase());
  const globalAutoMail = ["true", "1", "yes", "on", true, 1].includes(String(CONFIG.autoMail).toLowerCase());
  const shouldMail = frontendAutoMail || globalAutoMail;

//   try {
//     if (!baselineName || !groupName) return res.status(400).json({ ok: false, error: "baselineName and groupName are required" });

//     const bfAuthOpts = await getBfAuthContext(req, ctx); 

//     // 1) Baseline lookup
//     const qBaseline = `(name of site of it, id of it) of bes baseline whose (name of it is "${baselineName.replace(/"/g, '\\"')}")`;
//     const urlBaseline = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(qBaseline)}`;
//     const baselineResp = await axios.get(urlBaseline, { ...bfAuthOpts, headers: { Accept: "application/json" }, validateStatus: () => true });
//     if (baselineResp.status < 200 || baselineResp.status >= 300) return res.status(baselineResp.status).send(baselineResp.data);
    
//     const baselineRows = Array.isArray(baselineResp.data?.result) ? baselineResp.data.result : [];
//     if (!baselineRows.length) return res.status(404).json({ ok: false, error: `Baseline not found: ${baselineName}` });
    
//     let siteName = "", fixletId = "";
//     const partsB = []; collectStrings(baselineRows[0], partsB);
//     if (partsB.length >= 2) { siteName = partsB[0]; fixletId = partsB[1]; } else return res.status(500).json({ ok: false, error: "Unexpected baseline query shape" });

//     // 2) Group lookup 
//     const qGroup = `(name of it, id of it, name of site of it, (if automatic flag of it then "Automatic" else if manual flag of it then "manual" else "server based")) of bes computer group whose (name of it is "${groupName.replace(/"/g, '\\"')}")`;
//     const urlGroup = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(qGroup)}`;
//     const groupResp = await axios.get(urlGroup, { ...bfAuthOpts, headers: { Accept: "application/json" }, validateStatus: () => true });
//     if (groupResp.status < 200 || groupResp.status >= 300) return res.status(groupResp.status).send(groupResp.data);
    
//     const groupRows = Array.isArray(groupResp.data?.result) ? groupResp.data.result : [];
//     if (!groupRows.length) {
//       const pool = await getPool();
//       const dbCheck = await pool.request().input('Name', sql.NVarChar(255), groupName).query("SELECT BigFixID FROM dbo.AssetOwnership WHERE AssetName = @Name AND AssetType = 'Group'");
//       if (dbCheck.recordset.length > 0) {
//           await pool.request().input('Name', sql.NVarChar(255), groupName).query("DELETE FROM dbo.AssetOwnership WHERE AssetName = @Name AND AssetType = 'Group'");
//           return res.status(404).json({ ok: false, error: `Group '${groupName}' was deleted from the BigFix Console. It has been removed from your list.` });
//       } else return res.status(404).json({ ok: false, error: `Group not found: ${groupName}` });
//     }

//     let gName = "", gId = "", gSite = "", gType = "";
//     const partsG = []; collectStrings(groupRows[0], partsG);
//     if (partsG.length >= 4) [gName, gId, gSite, gType] = partsG; else return res.status(500).json({ ok: false, error: "Unexpected group query shape" });

//     // 3) Get specific Computer IDs
//     const activeUser = getSessionUser(req);
//     const activeRole = req.headers['x-user-role'] || getSessionRole(req);
//     const isMO = await isMasterOperator(req, ctx, activeUser);

//     let compFilter = "";
//     if (!isMO) {
//         if (!activeRole || activeRole === "No Role Assigned") {
//             return res.status(403).json({ ok: false, error: "No role assigned. Cannot trigger action." });
//         } else if (activeRole !== "Admin") {
//             const roleAssets = await getRoleAssets(req, ctx, activeRole);
//             if (roleAssets.found && roleAssets.compNames && roleAssets.compNames.length > 0) {
//                 const names = roleAssets.compNames.map(n => `"${n.toLowerCase()}"`).join(";");
//                 compFilter = ` whose (name of it as lowercase is contained by set of (${names}))`;
//             } else {
//                 return res.status(403).json({ ok: false, error: "You do not have access to any computers to deploy this action." });
//             }
//         }
//     }

//     // 🚀 Wrap members in parentheses and apply the compFilter to safely restrict the targeted IDs
//     const qMemberIds = `(id of it as string) of (members of bes computer group whose (id of it = ${gId}))${compFilter}`;
//     const urlMemberIds = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(qMemberIds)}`;
//     const membersResp = await axios.get(urlMemberIds, { ...bfAuthOpts, headers: { Accept: "application/json" }, validateStatus: () => true });
    
//     const memberIds = [];
//     if (membersResp.status === 200 && membersResp.data?.result) collectStrings(membersResp.data.result, memberIds);
//     if (memberIds.length === 0) return res.status(404).json({ ok: false, error: `No computers found in group '${gName}' or you do not have permission to deploy to them.` });
    
//     const targetXml = memberIds.map(id => `<ComputerID>${id}</ComputerID>`).join("");

//     // 4) CSV & Patch Content
//     let csvContent = null, patchesCsvContent = null, baselinePatches = [];
    
//     if (shouldMail) {
//       try {
//         const urlServers = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(`names of members of bes computer group whose (id of it = ${gId})`)}`;
//         const serversResp = await axios.get(urlServers, { ...bfAuthOpts, headers: { Accept: "application/json" }, validateStatus: () => true });
//         if (serversResp.status === 200) csvContent = toCSV(Array.isArray(serversResp.data?.result) ? serversResp.data.result : []);
        
//         baselinePatches = await fetchBaselinePatches(ctx.bigfix, baselineName, bfAuthOpts);
//         patchesCsvContent = patchesToCSV(baselinePatches);
//       } catch (e) { }
//     }

//     // 5) Timing
//     const timeInput = patchWindow || endOffsetHours || enddatetimelocaloffset || endOffset;
//     const pwMs = getPatchWindowMs(timeInput);
//     if (pwMs <= 0) return res.status(400).json({ ok: false, error: "Patch Window duration must be > 0" });
    
//     const tzMs = localUtcOffsetMs(); 
//     const deltaMs = pwMs - tzMs;
//     const endDateTimeLocalOffsetVal = msToXSDuration(deltaMs);
//     const expiresAt = Date.now() + pwMs;

//     // 6) Build XML
//     const envLabel = (forcedEnvironment || environment || "Sandbox").toString().trim();
//     const actionTitle = `BPS_${baselineName}_${envLabel}`;
    
//     const xml = `<?xml version="1.0" encoding="UTF-8"?><BES xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="BES.xsd"><SourcedFixletAction><SourceFixlet><Sitename>${escapeXML(siteName)}</Sitename><FixletID>${escapeXML(fixletId)}</FixletID><Action>Action1</Action></SourceFixlet><Target>${targetXml}</Target><Settings><HasEndTime>true</HasEndTime><EndDateTimeLocalOffset>${escapeXML(endDateTimeLocalOffsetVal)}</EndDateTimeLocalOffset><UseUTCTime>true</UseUTCTime></Settings><Title>${escapeXML(actionTitle)}</Title></SourcedFixletAction></BES>`;

//     const bfPostUrl = joinUrl(BIGFIX_BASE_URL, "/api/actions");
//     const bfResp = await axios.post(bfPostUrl, xml, { ...bfAuthOpts, headers: { "Content-Type": "text/xml" }, validateStatus: () => true, responseType: "text" });
//     if (bfResp.status < 200 || bfResp.status >= 300) {
//         log(req, "BigFix POST error:", String(bfResp.data).slice(0, 300));
//         return res.status(bfResp.status).send(typeof bfResp.data === "string" ? bfResp.data : JSON.stringify(bfResp.data));
//     }

//     const actionId = extractActionIdFromXml(String(bfResp.data || ""));
//     const smtpReady = !!(ctx.smtp && ctx.smtp.SMTP_HOST && ctx.smtp.SMTP_FROM);
//     let emailError = null;

//     if (actionId) {
//       const metadata = { 
//         id: actionId, createdAt: new Date().toISOString(), expiresAt, stage: envLabel, xml, baselineName, baselineSite: siteName, 
//         baselineFixletId: fixletId, groupName: gName, groupId: gId, groupSite: gSite, groupType: gType, 
//         endOffset: endDateTimeLocalOffsetVal, preMail: shouldMail, smtpEnabled: smtpReady, postMailSent: false, triggeredBy: triggeredBy || "Unknown" 
//       };
//       actionStore.lastActionId = actionId; 
//       actionStore.actions[actionId] = metadata;

//       if (envLabel.toLowerCase() === "sandbox") {
//           CONFIG.lastSandboxBaseline = baselineName;
//           CONFIG.lastSandboxGroup = gName;
//           try { await saveConfigToDB(CONFIG, req, log); } catch(e) {} 
//       }

//       try {
//         const pool = await getPool();
//         await pool.request().input("ActionID", sql.Int, Number(actionId)).input("Metadata", sql.NVarChar(sql.MAX), JSON.stringify(metadata)).input("PostMailSent", sql.Bit, 0).query(`INSERT INTO dbo.ActionHistory (ActionID, Metadata, PostMailSent, CreatedAt) VALUES (@ActionID, @Metadata, @PostMailSent, SYSUTCDATETIME())`);
//       } catch (dbErr) { }

//       scheduleActionStop(ctx, actionId, metadata);
//     }

//     // 7) Mail
//     if (shouldMail && smtpReady) {
//       try { 
//           await sendTriggerMail(ctx.smtp, { environment: envLabel, baselineName, baselineSite: siteName, baselineFixletId: fixletId, groupName: gName, groupId: gId, groupSite: gSite, groupType: gType, actionId, endOffset: endDateTimeLocalOffsetVal, emailTo: mailTo, emailFrom: mailFrom, emailCc: mailCc, emailBcc: mailBcc, SMTP_FROM, SMTP_TO, SMTP_CC, SMTP_BCC, csvContent, patchesCsvContent, baselinePatches }); 
//           console.log(`[${envLabel}] Pre-patch mail triggered successfully for ${actionId}`);
//       } catch (e) { 
//           emailError = e.message || String(e); 
//           console.error(`[${envLabel}] Pre-patch mail failed to send for ${actionId}:`, emailError);
//       }
//     } else if (shouldMail && !smtpReady) {
//         emailError = "SMTP not properly configured (Missing HOST or FROM)";
//         console.warn(`[${envLabel}] Pre-patch mail skipped for ${actionId}:`, emailError);
//     }

//     return res.json({ ok: true, actionId, siteName, fixletId, group: gName, title: actionTitle, stage: envLabel, endOffset: endDateTimeLocalOffsetVal, createdAt: new Date().toISOString(), preMail: shouldMail, preMailError: emailError });
//   } catch (err) { return res.status(500).json({ ok: false, error: err?.response?.data || err.message }); }
    try {
    
    if (!deployments || !Array.isArray(deployments) || deployments.length === 0) {
        return res.status(400).json({ ok: false, error: "deployments array is required" });
    }

    const bfAuthOpts = await getBfAuthContext(req, ctx); 

   
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
    // ==========================================

    const timeInput = patchWindow || endOffsetHours || enddatetimelocaloffset || endOffset;
    const pwMs = getPatchWindowMs(timeInput);
    if (pwMs <= 0) return res.status(400).json({ ok: false, error: "Patch Window duration must be > 0" });

    const tzMs = localUtcOffsetMs();
    const deltaMs = pwMs - tzMs;
    const endDateTimeLocalOffsetVal = msToXSDuration(deltaMs);
    const expiresAt = Date.now() + pwMs;
    const envLabel = (forcedEnvironment || environment || "Sandbox").toString().trim();
    const smtpReady = !!(ctx.smtp && ctx.smtp.SMTP_HOST && ctx.smtp.SMTP_FROM);

    // Arrays to store multi-deployment data
    const generatedActions = [];
    let combinedServersCsvRows = [];
    let combinedPatchesCsvRows = [];
    const baselinePatchesCache = {};

    
    for (const dep of deployments) {
        const { baseline: baselineName, group: groupName } = dep;
        if (!baselineName || !groupName) continue;

        // 1) Baseline lookup
        const qBaseline = `(name of site of it, id of it) of bes baseline whose (name of it is "${baselineName.replace(/"/g, '\\"')}")`;
        const urlBaseline = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(qBaseline)}`;
        const baselineResp = await axios.get(urlBaseline, { ...bfAuthOpts, headers: { Accept: "application/json" }, validateStatus: () => true });
        const baselineRows = Array.isArray(baselineResp.data?.result) ? baselineResp.data.result : [];
        if (!baselineRows.length) throw new Error(`Baseline not found: ${baselineName}`);
        
        let siteName = "", fixletId = "";
        const partsB = []; collectStrings(baselineRows[0], partsB);
        if (partsB.length >= 2) { siteName = partsB[0]; fixletId = partsB[1]; } 

        // 2) Group lookup 
        const qGroup = `(name of it, id of it, name of site of it, (if automatic flag of it then "Automatic" else if manual flag of it then "manual" else "server based")) of bes computer group whose (name of it is "${groupName.replace(/"/g, '\\"')}")`;
        const urlGroup = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(qGroup)}`;
        const groupResp = await axios.get(urlGroup, { ...bfAuthOpts, headers: { Accept: "application/json" }, validateStatus: () => true });
        const groupRows = Array.isArray(groupResp.data?.result) ? groupResp.data.result : [];
        if (!groupRows.length) throw new Error(`Group not found: ${groupName}`);

        let gName = "", gId = "", gSite = "", gType = "";
        const partsG = []; collectStrings(groupRows[0], partsG);
        if (partsG.length >= 4) [gName, gId, gSite, gType] = partsG;

        // 3) Get specific Computer IDs (Using your exact RBAC filter)
        const qMemberIds = `(id of it as string) of (members of bes computer group whose (id of it = ${gId}))${compFilter}`;
        const urlMemberIds = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(qMemberIds)}`;
        const membersResp = await axios.get(urlMemberIds, { ...bfAuthOpts, headers: { Accept: "application/json" }, validateStatus: () => true });
        
        const memberIds = [];
        if (membersResp.status === 200 && membersResp.data?.result) collectStrings(membersResp.data.result, memberIds);
        if (memberIds.length === 0) throw new Error(`No computers found in group '${gName}' or you do not have permission to deploy to them.`);
        
        const targetXml = memberIds.map(id => `<ComputerID>${id}</ComputerID>`).join("");

        // 4) CSV & Patch Content (Aggregated for 1 Summary Mail)
        if (shouldMail) {
          try {
            const urlServers = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(`names of (members of bes computer group whose (id of it = ${gId}))${compFilter}`)}`;
            const serversResp = await axios.get(urlServers, { ...bfAuthOpts, headers: { Accept: "application/json" }, validateStatus: () => true });
            if (serversResp.status === 200) {
                const srvs = Array.isArray(serversResp.data?.result) ? serversResp.data.result : [];
                srvs.forEach(s => combinedServersCsvRows.push(`${gName},${s}`)); 
            }
            if (!baselinePatchesCache[baselineName]) {
                baselinePatchesCache[baselineName] = await fetchBaselinePatches(ctx.bigfix, baselineName, bfAuthOpts);
            }
            const patches = baselinePatchesCache[baselineName] || [];
            patches.forEach(p => combinedPatchesCsvRows.push(`${baselineName},${p.id || ""},"${(p.name || "").replace(/"/g, '""')}"`));
          } catch (e) { }
        }

        // 5) Build XML & Execute
        const actionTitle = `BPS_${baselineName}_${envLabel}`;
        const xml = `<?xml version="1.0" encoding="UTF-8"?><BES xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="BES.xsd"><SourcedFixletAction><SourceFixlet><Sitename>${escapeXML(siteName)}</Sitename><FixletID>${escapeXML(fixletId)}</FixletID><Action>Action1</Action></SourceFixlet><Target>${targetXml}</Target><Settings><HasEndTime>true</HasEndTime><EndDateTimeLocalOffset>${escapeXML(endDateTimeLocalOffsetVal)}</EndDateTimeLocalOffset><UseUTCTime>true</UseUTCTime></Settings><Title>${escapeXML(actionTitle)}</Title></SourcedFixletAction></BES>`;

        const bfPostUrl = joinUrl(BIGFIX_BASE_URL, "/api/actions");
        const bfResp = await axios.post(bfPostUrl, xml, { ...bfAuthOpts, headers: { "Content-Type": "text/xml" }, validateStatus: () => true, responseType: "text" });
        if (bfResp.status < 200 || bfResp.status >= 300) throw new Error(`BigFix POST failed: HTTP ${bfResp.status}`);

        const actionId = extractActionIdFromXml(String(bfResp.data || ""));
        
        if (actionId) {
          const metadata = { 
            id: actionId, createdAt: new Date().toISOString(), expiresAt, stage: envLabel, xml, baselineName, baselineSite: siteName, 
            baselineFixletId: fixletId, groupName: gName, groupId: gId, groupSite: gSite, groupType: gType, 
            endOffset: endDateTimeLocalOffsetVal, preMail: shouldMail, smtpEnabled: smtpReady, postMailSent: false, triggeredBy: triggeredBy || "Unknown" 
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
          generatedActions.push({ actionId, siteName, fixletId, group: gName, baseline: baselineName, title: actionTitle });
        }
    } 

    // 6) Send 1 Single Consolidated Mail
    let emailError = null;
    if (shouldMail && smtpReady && generatedActions.length > 0) {
      try { 
          const csvContent = "Target Group,Computer Name\n" + combinedServersCsvRows.join("\n");
          const patchesCsvContent = "Baseline,Patch ID,Patch Name\n" + combinedPatchesCsvRows.join("\n");

          await sendTriggerMail(ctx.smtp, { environment: envLabel, baselineName: "Multiple Baselines (See Attached CSV)", baselineSite: "Multiple Sites", baselineFixletId: "Multiple IDs", groupName: "Multiple Groups (See Attached CSV)", groupId: "Multiple IDs", groupSite: "Multiple Sites", groupType: "Multiple Types", actionId: generatedActions.map(a => a.actionId).join(", "), endOffset: endDateTimeLocalOffsetVal, emailTo: mailTo, emailFrom: mailFrom, emailCc: mailCc, emailBcc: mailBcc, SMTP_FROM, SMTP_TO, SMTP_CC, SMTP_BCC, csvContent, patchesCsvContent, baselinePatches: [] }); 
      } catch (e) { emailError = e.message || String(e); }
    }

    
    return res.json({ ok: true, actions: generatedActions, stage: envLabel, endOffset: endDateTimeLocalOffsetVal, createdAt: new Date().toISOString(), preMail: shouldMail, preMailError: emailError });
  } catch (err) { return res.status(500).json({ ok: false, error: err?.response?.data || err.message }); }
}

module.exports = { triggerAction };