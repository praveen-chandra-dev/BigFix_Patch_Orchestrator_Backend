// src/routes/query.js
const axios = require("axios");
const { joinUrl } = require("../utils/http");
const { logFactory } = require("../utils/log");
const { getBfAuthContext } = require("../utils/http");

function attachQueryProxy(app, ctx) {
  const log = logFactory(ctx.DEBUG_LOG);
  const { BIGFIX_BASE_URL } = ctx.bigfix;

  app.get("/api/query", async (req, res) => {
    try {
      const { relevance } = req.query;
      if (!relevance || !String(relevance).trim()) return res.status(400).json({ error: "Missing 'relevance' query param" });

      const bfUrl = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
      const bfAuthOpts = await getBfAuthContext(req, ctx); // SECURE CONTEXT

      const resp = await axios.get(bfUrl, {
          ...bfAuthOpts,
          headers: { Accept: "application/json" }
      });

      if (resp.status < 200 || resp.status >= 300) {
        return res.status(resp.status).send(typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data));
      }

      let data;
      try { data = typeof resp.data === "string" ? JSON.parse(resp.data) : resp.data; }
      catch (e) { return res.status(502).send(`Unexpected BigFix response (not JSON)`); }

      res.json(data);
    } catch (err) {
      res.status(500).json({ error: "Proxy failure", detail: String(err?.message || err) });
    }
  });
}

module.exports = { attachQueryProxy };