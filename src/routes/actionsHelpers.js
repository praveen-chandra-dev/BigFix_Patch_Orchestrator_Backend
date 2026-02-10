// src/routes/actionsHelpers.js
const axios = require("axios");
const { joinUrl } = require("../utils/http");
const { parseTupleRows } = require("../utils/query");
const { actionStore } = require("../state/store");
const { logFactory } = require("../utils/log");

function pickTag(text, tag) {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i").exec(text);
  return m ? m[1].trim() : null;
}
const pickStatusTop = (xml) => pickTag(xml, "Status");

async function getActionStatusXml(bigfixCtx, id) {
  const { BIGFIX_BASE_URL, BIGFIX_USER, BIGFIX_PASS, httpsAgent } = bigfixCtx;//
  const url = joinUrl(BIGFIX_BASE_URL, `/api/action/${id}/status`);
  const r = await axios.get(url, {
    httpsAgent,
    auth: { username: BIGFIX_USER, password: BIGFIX_PASS },
    headers: { Accept: "text/xml" },
    timeout: 60_000,
    validateStatus: () => true,
    responseType: "text",
  });
  return { ok: r.status >= 200 && r.status < 300, text: String(r.data || "") };
}
// (Helper functions end)


function attachActionHelpers(app, ctx) {
  const log = logFactory(ctx.DEBUG_LOG);
  const { BIGFIX_BASE_URL, BIGFIX_USER, BIGFIX_PASS, httpsAgent } = ctx.bigfix;

  app.get("/api/actions/last", (req, res) => {
    req._logStart = Date.now();
    log(req, "GET /api/actions/last →", actionStore.lastActionId);
    res.json({ actionId: actionStore.lastActionId });
  });

  app.get("/api/actions/:id/status", async (req, res) => {
    req._logStart = Date.now();
    const { id } = req.params;
    log(req, "GET /api/actions/:id/status id=", id);
    
    try {
      if (!id || id === "null" || id === "undefined") {
         return res.status(400).json({ ok: false, state: "Invalid ID", mailSent: false });
      }
      
      const { ok, text } = await getActionStatusXml(ctx.bigfix, id);
      if (!ok) {
        log(req, "BF GET status error:", text);
        if (String(text).toLowerCase().includes("id not found")) {
            return res.json({ ok: true, state: "expired", mailSent: true });
        }
        return res.status(500).json({ ok: false, state: "Error", mailSent: false });
      }

      const state = (pickStatusTop(text) || "Unknown").toLowerCase();
      log(req, "Action state:", state);

      const mailSent = actionStore.actions[id]?.postMailSent || false;

      res.json({ ok: true, state, mailSent: state === 'expired' || mailSent });
    } catch (err) {
      log(req, "Action status error:", err?.message || err);
      res.status(500).json({ ok: false, error: String(err?.message || err), mailSent: false });
    }
  });


  app.get("/api/actions/:id/results", async (req, res) => {
    req._logStart = Date.now();
    try {
      const id = String(req.params.id || "").trim();
      log(req, "GET /api/actions/:id/results id=", id);

      if (!/^\d+$/.test(id)) {
        log(req, "Invalid id");
        return res.status(400).json({ error: "Invalid action id" });
      }

      const relevance =
        `((if exists (name of computers of it) then name of computers of it else "N/A"),` +
        ` (if exists (names of member actions of actions of it) then (names of member actions of actions of it) else "N/A"),` +
        ` (detailed status of it as string | "N/A"),` +
        ` (start time of it as string | "N/A"),` +
        ` (end time of it as string | "N/A"), (name of issuer of action of it as string | "N/A")) of results of bes action whose (id of it = ${id})`;

      const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
      log(req, "BF GET →", url);

      const resp = await axios.get(url, {
        httpsAgent,
        auth: { username: BIGFIX_USER, password: BIGFIX_PASS },
        headers: { Accept: "application/json" },
        responseType: "json",
        timeout: 60_000,
        validateStatus: () => true,
      });
      log(req, "BF GET ←", resp.status);

      if (resp.status < 200 || resp.status >= 300) {
        log(req, "BF GET error payload (first 300):", String(resp.data).slice(0, 300));
        return res.status(resp.status).send(resp.data);
      }

      const rows = parseTupleRows(resp.data).map(parts => {
        const [server, patch, status, start, end, issuer] = parts;
        return { server, patch, status, start, end, issuer };
      });

      const total = rows.length;
      const success = rows.filter(r => /executed successfully/i.test(r.status)).length;
      log(req, "results summary:", { total, success });

      res.json({ actionId: id, total, success, rows });
    } catch (err) {
      log(req, "Action results error:", err?.message || err);
      res.status(500).json({ error: String(err?.message || err) });
    }
  });
}

module.exports = { attachActionHelpers };