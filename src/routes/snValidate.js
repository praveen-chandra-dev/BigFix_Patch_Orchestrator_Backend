// src/routes/snValidate.js
const https = require("https");
const axios = require("axios");
const { logFactory } = require("../utils/log");

function attachSnValidate(app, ctx) {
  const log = logFactory(ctx.DEBUG_LOG);
  const { SN_URL, SN_USER, SN_PASSWORD, SN_ALLOW_SELF_SIGNED } = ctx.servicenow;

  app.get("/api/sn/change/validate", async (req, res) => {
    req._logStart = Date.now();

    const allowSelfSigned = String(SN_ALLOW_SELF_SIGNED || "").toLowerCase() === "true";
    const agent = new https.Agent({ rejectUnauthorized: !allowSelfSigned });

    try {
      const number = String(req.query.number || "").trim().toUpperCase();
      log(req, "SN validate number:", number);

      if (!number || !/^CHG/.test(number)) {
        return res.status(400).json({ ok: false, error: "Invalid or missing change number (must start with CHG)" });
      }
      if (!SN_URL || !SN_USER || !SN_PASSWORD) {
        return res.status(500).json({ ok: false, error: "ServiceNow env not configured (SN_URL, SN_USER, SN_PASSWORD required)" });
      }

      let snBase = SN_URL.replace(/\/+$/, "");
      if (/\/api\/now$/i.test(snBase)) snBase = snBase.replace(/\/api\/now$/i, "");
      const endpoint =
        `${snBase}/api/now/table/change_request` +
        `?sysparm_query=number=${encodeURIComponent(number)}` +
        `&sysparm_fields=sys_id,number,state,stage,approval,work_start,work_end` +
        `&sysparm_display_value=true`;

      log(req, "SN GET →", endpoint);
      const resp = await axios.get(endpoint, {
        httpsAgent: agent,
        auth: { username: SN_USER, password: SN_PASSWORD },
        headers: { Accept: "application/json" },
        timeout: 30000,
        validateStatus: () => true,
      });
      log(req, "SN GET ←", resp.status);

      if (resp.status === 401 || resp.status === 403) {
        return res.json({ ok: false, code: "NOT_FOUND_OR_FORBIDDEN", message: "Change Request doesn't exist or user doesn't have required privileges." });
      }

      let result = resp?.data?.result;
      if (Array.isArray(result)) { /* ok */ }
      else if (result && typeof result === "object") { result = [result]; }
      else { result = []; }

      if (result.length === 0) {
        return res.json({ ok: false, code: "NOT_FOUND_OR_FORBIDDEN", message: "Change Request doesn't exist or user doesn't have required privileges." });
      }

      const rec = result[0] || {};
      const state = String(rec.state || "").trim();
      const isImplement = /^implement$/i.test(state);

      if (!isImplement) {
        return res.json({
          ok: false,
          code: "NOT_IMPLEMENT",
          message: "Change Request is not at Implement stage.",
          record: { sys_id: rec.sys_id, number: rec.number, state, approval: rec.approval, work_start: rec.work_start, work_end: rec.work_end }
        });
      }

      return res.json({
        ok: true, exists: true, implement: true,
        record: { sys_id: rec.sys_id, number: rec.number, state, approval: rec.approval, work_start: rec.work_start, work_end: rec.work_end }
      });
    } catch (err) {
      log(req, "SN validate error:", err?.message || err);
      res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });
}

module.exports = { attachSnValidate };
