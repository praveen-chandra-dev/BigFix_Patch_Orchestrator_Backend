// src/routes/query.js
const axios = require("axios");
const { joinUrl } = require("../utils/http");
const { logFactory } = require("../utils/log");

function attachQueryProxy(app, ctx) {
  const log = logFactory(ctx.DEBUG_LOG);
  const { BIGFIX_BASE_URL, BIGFIX_USER, BIGFIX_PASS, httpsAgent } = ctx.bigfix;

  app.get("/api/query", async (req, res) => {
    req._logStart = Date.now();
    const { relevance } = req.query;
    log(req, "Proxy /api/query relevance:", relevance);

    try {
      if (!relevance || !String(relevance).trim()) {
        log(req, "Missing relevance");
        return res.status(400).json({ error: "Missing 'relevance' query param" });
      }

      const bfUrl = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
      log(req, "BF GET →", bfUrl);

      const resp = await axios.get(bfUrl, {
        httpsAgent,
        auth: BIGFIX_USER && BIGFIX_PASS ? { username: BIGFIX_USER, password: BIGFIX_PASS } : undefined,
        headers: { Accept: "application/json" },
        responseType: "text",
        timeout: 60_000,
        validateStatus: () => true,
      });

      log(req, `BF GET ← ${resp.status}`);

      if (resp.status < 200 || resp.status >= 300) {
        log(req, "Proxy /api/query error payload (first 300):", String(resp.data).slice(0, 300));
        return res.status(resp.status).send(typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data));
      }

      let data;
      try { data = typeof resp.data === "string" ? JSON.parse(resp.data) : resp.data; }
      catch (e) {
        log(req, "Proxy /api/query JSON parse error:", String(e?.message || e));
        return res.status(502).send(`Unexpected BigFix response (not JSON): ${String(resp.data).slice(0, 500)}`);
      }

      log(req, "Proxy /api/query success");
      res.json(data);
    } catch (err) {
      log(req, "Proxy error:", err?.message);
      res.status(500).json({ error: "Proxy failure", detail: String(err?.message || err) });
    }
  });
}

module.exports = { attachQueryProxy };
/* *///