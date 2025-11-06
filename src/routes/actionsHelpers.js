// src/routes/actionsHelpers.js
const axios = require("axios");
const { joinUrl } = require("../utils/http");
const { parseTupleRows } = require("../utils/query");
const { actionStore } = require("../state/store");
const { logFactory } = require("../utils/log");

function attachActionHelpers(app, ctx) {
  const log = logFactory(ctx.DEBUG_LOG);
  const { BIGFIX_BASE_URL, BIGFIX_USER, BIGFIX_PASS, httpsAgent } = ctx.bigfix;

  app.get("/api/actions/last", (req, res) => {
    req._logStart = Date.now();
    log(req, "GET /api/actions/last →", actionStore.lastActionId);
    res.json({ actionId: actionStore.lastActionId });
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
        ` (end time of it as string | "N/A")) of results of bes action whose (id of it = ${id})`;

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
        const [server, patch, status, start, end] = parts;
        return { server, patch, status, start, end };
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
