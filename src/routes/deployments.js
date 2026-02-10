// bigfix-backend/src/routes/deployments.js
const axios = require("axios");
const { joinUrl } = require("../utils/http");
const { logFactory } = require("../utils/log");

/** Parse: "Name | Id | State | Issued | Stopped | Issuer" */
function parseRow(s) {
  const parts = String(s || "").split("|").map(x => x.trim());
  return {
    name:    parts[0] || "N/A",
    id:      parts[1] || "N/A",
    state:   parts[2] || "N/A",
    issued:  parts[3] || "N/A",
    stopped: parts[4] || "N/A",
    issuer:  parts[5] || "N/A", 
  };
}

function attachDeploymentsRoutes(app, ctx) {
  const log = logFactory(ctx.DEBUG_LOG);
  const { BIGFIX_BASE_URL, BIGFIX_USER, BIGFIX_PASS, httpsAgent } = ctx.bigfix;

  // GET /api/deployments/bps
  app.get("/api/deployments/bps", async (req, res) => {
    req._logStart = Date.now();
    try {
      // --- UPDATED RELEVANCE ---
      const relevance =
        `((name of it as string | "N/A") & " | " & ` +
        `(id of it as string | "N/A") & " | " & ` +
        `(state of it as string | "N/A") & " | " & ` +
        `(time issued of it as string | "N/A") & " | " & ` +
        `((if exists end date of it then end date of it as string & " " & end time_of_day of it as string else "None") of it) & " | " & ` + 
        `(name of issuer of it as string | "N/A")) of bes actions whose (name of it starts with "BPS_")`;

      const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
      log(req, "GET deployments →", url);

      const r = await axios.get(url, {
        httpsAgent,
        auth: { username: BIGFIX_USER, password: BIGFIX_PASS },
        headers: { Accept: "application/json" },
        responseType: "json",
        timeout: 60_000,
        validateStatus: () => true,
      });
      log(req, "GET deployments ←", r.status);

      if (r.status < 200 || r.status >= 300) {
        return res.status(r.status).send(r.data);
      }

      const rows = Array.isArray(r.data?.result) ? r.data.result : [];
      const flat = [];
      const collect = (n) => {
        if (n == null) return;
        if (typeof n === "string") { flat.push(n); return; }
        if (Array.isArray(n)) { n.forEach(collect); return; }
        if (typeof n === "object") {
          ["Answer","result","TupleResult","PluralResult"].forEach(k => k in n && collect(n[k]));
          Object.keys(n).forEach(k => !["Answer","result","TupleResult","PluralResult"].includes(k) && collect(n[k]));
        }
      };
      rows.forEach(collect);

      const items = flat
        .filter(Boolean)
        .map(parseRow)
        .sort((a,b) => (Number(b.id)||0) - (Number(a.id)||0));

      res.json({ ok: true, count: items.length, items });
    } catch (e) {
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });
}

module.exports = { attachDeploymentsRoutes };