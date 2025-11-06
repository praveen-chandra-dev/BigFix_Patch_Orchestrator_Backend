// src/routes/actions.js
const axios = require("axios");
const { joinUrl, toLowerSafe } = require("../utils/http");
const { collectStrings, extractActionIdFromXml } = require("../utils/query");
const { actionStore } = require("../state/store");
const { logFactory } = require("../utils/log");
const { sendSandboxMail } = require("../mail/transport");

function attachActionsRoutes(app, ctx) {
  const log = logFactory(ctx.DEBUG_LOG);
  const { BIGFIX_BASE_URL, BIGFIX_USER, BIGFIX_PASS, httpsAgent } = ctx.bigfix;
  const { SMTP_FROM, SMTP_TO, SMTP_CC, SMTP_BCC } = process.env;

  app.post("/api/actions", async (req, res) => {
    req._logStart = Date.now();
    try {
      const { baselineName, groupName, autoMail, mailTo, mailFrom, mailCc, mailBcc } = req.body || {};
      log(req, "POST /api/actions body:", req.body);

      if (!baselineName || !groupName) {
        log(req, "400 missing baseline/group");
        return res.status(400).json({ ok: false, error: "baselineName and groupName are required" });
      }

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
      log(req, "Baseline lookup ←", baselineResp.status);
      if (baselineResp.status < 200 || baselineResp.status >= 300) return res.status(baselineResp.status).send(baselineResp.data);

      const baselineRows = Array.isArray(baselineResp.data?.result) ? baselineResp.data.result : [];
      if (!baselineRows.length) return res.status(404).json({ ok: false, error: `Baseline not found: ${baselineName}` });

      let siteName = "", fixletId = "";
      {
        const parts = [];
        collectStrings(baselineRows[0], parts);
        if (parts.length >= 2) { siteName = parts[0]; fixletId = parts[1]; }
        else return res.status(500).json({ ok: false, error: "Unexpected baseline query shape" });
      }

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
      log(req, "Group lookup ←", groupResp.status);
      if (groupResp.status < 200 || groupResp.status >= 300) return res.status(groupResp.status).send(groupResp.data);

      const groupRows = Array.isArray(groupResp.data?.result) ? groupResp.data.result : [];
      if (!groupRows.length) return res.status(404).json({ ok: false, error: `Group not found: ${groupName}` });

      let gName = "", gId = "", gSite = "", gType = "";
      {
        const parts = [];
        collectStrings(groupRows[0], parts);
        if (parts.length >= 4) [gName, gId, gSite, gType] = parts;
        else return res.status(500).json({ ok: false, error: "Unexpected group query shape" });
      }

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
      if (bfResp.status < 200 || bfResp.status >= 300) {
        log(req, "BigFix POST error body (first 300):", String(bfResp.data).slice(0, 300));
        return res.status(bfResp.status).send(typeof bfResp.data === "string" ? bfResp.data : JSON.stringify(bfResp.data));
      }

      const bodyText = String(bfResp.data || "");
      const actionId = extractActionIdFromXml(bodyText);

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
        } catch (e) {
          log(req, "Email send failed:", e?.message || e);
        }
      }

      const payload = { ok: true, actionId, siteName, fixletId, group: gName, createdAt: new Date().toISOString() };
      log(req, "POST /api/actions success →", payload);
      res.json(payload);
    } catch (err) {
      log(req, "POST /api/actions error:", err?.message || err);
      res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });
}

module.exports = { attachActionsRoutes };
