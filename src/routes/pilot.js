// src/routes/pilot.js
const https = require("https");
const axios = require("axios");
const { joinUrl, toLowerSafe } = require("../utils/http");
const { collectStrings, extractActionIdFromXml } = require("../utils/query");
const { actionStore } = require("../state/store");
const { logFactory } = require("../utils/log");
const { sendSandboxMail } = require("../mail/transport");

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

async function triggerBaselineAction(req, ctx, { baselineName, groupName, autoMail, mailTo, mailFrom, mailCc, mailBcc }) {
  const { BIGFIX_BASE_URL, BIGFIX_USER, BIGFIX_PASS, httpsAgent } = ctx.bigfix;

  const qBaseline = `(name of site of it, id of it) of bes baseline whose (name of it is "${baselineName.replace(/"/g, '\\"')}")`;
  const urlBaseline = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(qBaseline)}`;
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

  const qGroup = `(name of it, id of it, name of site of it, (if automatic flag of it then "Automatic" else if manual flag of it then "manual" else "server based")) of bes computer group whose (name of it is "${groupName.replace(/"/g, '\\"')}")`;
  const urlGroup = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(qGroup)}`;
  const groupResp = await axios.get(urlGroup, {
    httpsAgent,
    auth: { username: BIGFIX_USER, password: BIGFIX_PASS },
    headers: { Accept: "application/json" },
    responseType: "json",
    timeout: 60_000,
    validateStatus: () => true
  });
  if (groupResp.status < 200 || groupResp.status >= 300) throw new Error(`Group lookup failed: HTTP ${groupResp.status}`);
  const groupRows = Array.isArray(groupResp.data?.result) ? groupResp.data.result : [];
  if (!groupRows.length) throw new Error(`Group not found: ${groupName}`);
  const partsG = []; collectStrings(groupRows[0], partsG);
  if (partsG.length < 4) throw new Error("Unexpected group query shape");
  const gName = partsG[0], gId = partsG[1], gSite = partsG[2], gType = partsG[3];

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

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<BES xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="BES.xsd">` +
    `  <SourcedFixletAction>` +
    `    <SourceFixlet>` +
    `      <Sitename>${siteName}</Sitename>` +
    `      <FixletID>${fixletId}</FixletID>` +
    `      <Action>Action1</Action>` +
    `    </SourceFixlet>` +
    `    <Target>` +
    `      <CustomRelevance>${customRelevance}</CustomRelevance>` +
    `    </Target>` +
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
  if (bfResp.status < 200 || bfResp.status >= 300) throw new Error(`BigFix POST failed: HTTP ${bfResp.status} ${String(bfResp.data).slice(0, 200)}`);

  const actionId = extractActionIdFromXml(String(bfResp.data || ""));
  if (actionId) {
    actionStore.lastActionId = actionId;
    actionStore.actions[actionId] = { id: actionId, createdAt: new Date().toISOString(), xml };
  }

  if (autoMail) {
    try {
      await sendSandboxMail(ctx.smtp, {
        baselineName, baselineSite: siteName, baselineFixletId: fixletId,
        groupName: gName, groupId: gId, groupSite: gSite, groupType: gType,
        customRelevance, actionXml: xml, actionId,
        emailTo: mailTo, emailFrom: mailFrom, emailCc: mailCc, emailBcc: mailBcc,
        SMTP_FROM: process.env.SMTP_FROM, SMTP_TO: process.env.SMTP_TO,
        SMTP_CC: process.env.SMTP_CC, SMTP_BCC: process.env.SMTP_BCC,
      });
    } catch (e) { /* ignore mail errors */ }
  }

  return { actionId, siteName, fixletId, group: gName };
}

function attachPilotRoutes(app, ctx) {
  const log = logFactory(ctx.DEBUG_LOG);

  app.post("/api/pilot/actions", async (req, res) => {
    req._logStart = Date.now();
    try {
      const { baselineName, groupName, chgNumber, requireChg = true, autoMail, mailTo, mailFrom, mailCc, mailBcc } = req.body || {};
      if (!baselineName || !groupName) return res.status(400).json({ ok: false, error: "baselineName and groupName are required" });

      if (requireChg) {
        if (!chgNumber || !/^CHG/i.test(String(chgNumber))) {
          return res.status(400).json({ ok: false, error: "Valid chgNumber required when requireChg=true" });
        }
        const chk = await validateChangeNumber(String(chgNumber).toUpperCase(), ctx);
        if (!chk.ok) {
          return res.status(400).json({
            ok: false, chgOk: false, code: chk.code || "CHG_INVALID", message: chk.message || "CHG validation failed"
          });
        }
      }

      const out = await triggerBaselineAction(req, ctx, { baselineName, groupName, autoMail, mailTo, mailFrom, mailCc, mailBcc });
      return res.json({ ok: true, chgOk: !requireChg || true, ...out });
    } catch (err) {
      log(req, "POST /api/pilot/actions error:", err?.message || err);
      res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  app.post("/api/pilot/actions/force", async (req, res) => {
    req._logStart = Date.now();
    try {
      const { baselineName, groupName, autoMail, mailTo, mailFrom, mailCc, mailBcc } = req.body || {};
      if (!baselineName || !groupName) return res.status(400).json({ ok: false, error: "baselineName and groupName are required" });

      const out = await triggerBaselineAction(req, ctx, { baselineName, groupName, autoMail, mailTo, mailFrom, mailCc, mailBcc });
      return res.json({ ok: true, forced: true, ...out });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });
}

module.exports = { attachPilotRoutes };
