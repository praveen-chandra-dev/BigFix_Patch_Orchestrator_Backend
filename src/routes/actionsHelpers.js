// // src/routes/actionsHelpers.js
// const axios = require("axios");
// const { joinUrl, getBfAuthContext } = require("../utils/http");
// const { parseTupleRows } = require("../utils/query");
// const { actionStore } = require("../state/store");
// const { logFactory } = require("../utils/log");
// const { triggerEarlyStop } = require("../services/postpatchWatcher"); // Import the new instant trigger

// function pickTag(text, tag) {
//   const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i").exec(text);
//   return m ? m[1].trim() : null;
// }
// const pickStatusTop = (xml) => pickTag(xml, "Status");

// async function getActionStatusXml(bigfixCtx, id) {
//   const { BIGFIX_BASE_URL, BIGFIX_USER, BIGFIX_PASS, httpsAgent } = bigfixCtx;
//   const url = joinUrl(BIGFIX_BASE_URL, `/api/action/${id}/status`);
//   const r = await axios.get(url, {
//     httpsAgent,
//     auth: { username: BIGFIX_USER, password: BIGFIX_PASS },
//     headers: { Accept: "text/xml" },
//     timeout: 60_000,
//     validateStatus: () => true,
//     responseType: "text",
//   });
//   return { ok: r.status >= 200 && r.status < 300, text: String(r.data || "") };
// }

// // Global object to track when we last logged a specific Action ID
// const statusLogThrottle = {};

// function attachActionHelpers(app, ctx) {
//   const log = logFactory(ctx.DEBUG_LOG);
//   const { BIGFIX_BASE_URL } = ctx.bigfix;

//   app.get("/api/actions/last", (req, res) => {
//     req._logStart = Date.now();
//     log(req, "GET /api/actions/last →", actionStore.lastActionId);
//     res.json({ actionId: actionStore.lastActionId });
//   });

//   app.get("/api/actions/:id/status", async (req, res) => {
//     const { id } = req.params;
//     const now = Date.now();
    
//     // Log throttle (every 5 mins) to prevent spam
//     const lastLogged = statusLogThrottle[id] || 0;
//     const shouldLog = (now - lastLogged) > 300000; 

//     if (shouldLog) {
//       req._logStart = now;
//       log(req, "GET /api/actions/:id/status id=", id);
//       statusLogThrottle[id] = now; 
//     }
    
//     try {
//       if (!id || id === "null" || id === "undefined") {
//          return res.status(400).json({ ok: false, state: "Invalid ID", mailSent: false });
//       }
      
//       const { ok, text } = await getActionStatusXml(ctx.bigfix, id);
//       if (!ok) {
//         if (shouldLog) log(req, "BF GET status error:", text);
//         if (String(text).toLowerCase().includes("id not found")) {
//             return res.json({ ok: true, state: "expired", mailSent: true });
//         }
//         return res.status(500).json({ ok: false, state: "Error", mailSent: false });
//       }

//       const state = (pickStatusTop(text) || "Unknown").toLowerCase();
//       if (shouldLog) log(req, "Action state:", state);

//       // 🚀 INSTANT CATCHER: If UI polling notices it stopped early, fire the email immediately!
//       const entry = actionStore.actions[id];
//       if (entry && !entry.postMailSent && (state === 'stopped' || state === 'expired')) {
//           triggerEarlyStop(ctx, id, state === 'stopped' ? "Stopped Manually (Console)" : "Expired");
//       }

//       const mailSent = actionStore.actions[id]?.postMailSent || false;

//       res.json({ ok: true, state, mailSent: state === 'expired' || mailSent });
//     } catch (err) {
//       if (shouldLog) log(req, "Action status error:", err?.message || err);
//       res.status(500).json({ ok: false, error: String(err?.message || err), mailSent: false });
//     }
//   });

//   app.get("/api/actions/:id/results", async (req, res) => {
//     req._logStart = Date.now();
//     try {
//       const id = String(req.params.id || "").trim();
//       log(req, "GET /api/actions/:id/results id=", id);

//       if (!/^\d+$/.test(id)) {
//         log(req, "Invalid id");
//         return res.status(400).json({ error: "Invalid action id" });
//       }

//       const relevance =
//         `((if exists (name of computers of it) then name of computers of it else "N/A"),` +
//         ` (if exists (names of member actions of actions of it) then (names of member actions of actions of it) else "N/A"),` +
//         ` (detailed status of it as string | "N/A"),` +
//         ` (start time of it as string | "N/A"),` +
//         ` (end time of it as string | "N/A"), (name of issuer of action of it as string | "N/A")) of results of bes action whose (id of it = ${id})`;

//       const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
//       const bfAuthOpts = await getBfAuthContext(req, ctx);
//       const resp = await axios.get(url, {
//           ...bfAuthOpts,
//           headers: { Accept: "application/json" }
//       });

//       if (resp.status < 200 || resp.status >= 300) {
//         log(req, "BF GET error payload (first 300):", String(resp.data).slice(0, 300));
//         return res.status(resp.status).send(resp.data);
//       }

//       const rows = parseTupleRows(resp.data).map(parts => {
//         const [server, patch, status, start, end, issuer] = parts;
//         return { server, patch, status, start, end, issuer };
//       });

//       const total = rows.length;
//       const success = rows.filter(r => /executed successfully/i.test(r.status)).length;
//       log(req, "results summary:", { total, success });

//       res.json({ actionId: id, total, success, rows });
//     } catch (err) {
//       log(req, "Action results error:", err?.message || err);
//       res.status(500).json({ error: String(err?.message || err) });
//     }
//   });
// }

// module.exports = { attachActionHelpers };

// src/routes/actionsHelpers.js
const axios = require("axios");
const { joinUrl, getBfAuthContext } = require("../utils/http");
const { parseTupleRows } = require("../utils/query");
const { actionStore } = require("../state/store");
const { logFactory } = require("../utils/log");
const { triggerEarlyStop } = require("../services/postpatchWatcher"); 

function pickTag(text, tag) {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i").exec(text);
  return m ? m[1].trim() : null;
}
const pickStatusTop = (xml) => pickTag(xml, "Status");

async function getActionStatusXml(bigfixCtx, id) {
  const { BIGFIX_BASE_URL, BIGFIX_USER, BIGFIX_PASS, httpsAgent } = bigfixCtx;
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

// 🚀 FIX: Global objects to track when we last logged to prevent log spam
const statusLogThrottle = {};
const resultsLogThrottle = {};
let lastActionLogTime = 0;

function attachActionHelpers(app, ctx) {
  const log = logFactory(ctx.DEBUG_LOG);
  const { BIGFIX_BASE_URL } = ctx.bigfix;

  app.get("/api/actions/last", (req, res) => {
    const now = Date.now();
    // 🚀 Only log once every 5 minutes (300,000 ms)
    if (now - lastActionLogTime > 300000) { 
        req._logStart = now;
        log(req, "GET /api/actions/last →", actionStore.lastActionId);
        lastActionLogTime = now;
    }
    res.json({ actionId: actionStore.lastActionId });
  });

  app.get("/api/actions/:id/status", async (req, res) => {
    const { id } = req.params;
    const now = Date.now();
    
    const lastLogged = statusLogThrottle[id] || 0;
    const shouldLog = (now - lastLogged) > 300000; 

    if (shouldLog) {
      req._logStart = now;
      log(req, "GET /api/actions/:id/status id=", id);
      statusLogThrottle[id] = now; 
    }
    
    try {
      if (!id || id === "null" || id === "undefined") {
         return res.status(400).json({ ok: false, state: "Invalid ID", mailSent: false });
      }
      
      const { ok, text } = await getActionStatusXml(ctx.bigfix, id);
      if (!ok) {
        if (shouldLog) log(req, "BF GET status error:", text);
        if (String(text).toLowerCase().includes("id not found")) {
            return res.json({ ok: true, state: "expired", mailSent: true });
        }
        return res.status(500).json({ ok: false, state: "Error", mailSent: false });
      }

      const state = (pickStatusTop(text) || "Unknown").toLowerCase();
      if (shouldLog) log(req, "Action state:", state);

      const entry = actionStore.actions[id];
      if (entry && !entry.postMailSent && (state === 'stopped' || state === 'expired')) {
          triggerEarlyStop(ctx, id, state === 'stopped' ? "Stopped Manually (Console)" : "Expired");
      }

      const mailSent = actionStore.actions[id]?.postMailSent || false;

      res.json({ ok: true, state, mailSent: state === 'expired' || mailSent });
    } catch (err) {
      if (shouldLog) log(req, "Action status error:", err?.message || err);
      res.status(500).json({ ok: false, error: String(err?.message || err), mailSent: false });
    }
  });

  app.get("/api/actions/:id/results", async (req, res) => {
    const id = String(req.params.id || "").trim();
    const now = Date.now();

    // 🚀 FIX: Throttle the heavy results polling log
    const lastLogged = resultsLogThrottle[id] || 0;
    const shouldLog = (now - lastLogged) > 300000; 

    if (shouldLog) {
        req._logStart = now;
        log(req, "GET /api/actions/:id/results id=", id);
        resultsLogThrottle[id] = now;
    }

    try {
      if (!/^\d+$/.test(id)) {
        if (shouldLog) log(req, "Invalid id");
        return res.status(400).json({ error: "Invalid action id" });
      }

      const relevance =
        `((if exists (name of computers of it) then name of computers of it else "N/A"),` +
        ` (if exists (names of member actions of actions of it) then (names of member actions of actions of it) else "N/A"),` +
        ` (detailed status of it as string | "N/A"),` +
        ` (start time of it as string | "N/A"),` +
        ` (end time of it as string | "N/A"), (name of issuer of action of it as string | "N/A")) of results of bes action whose (id of it = ${id})`;

      const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
      const bfAuthOpts = await getBfAuthContext(req, ctx);
      const resp = await axios.get(url, {
          ...bfAuthOpts,
          headers: { Accept: "application/json" }
      });

      if (resp.status < 200 || resp.status >= 300) {
        if (shouldLog) log(req, "BF GET error payload (first 300):", String(resp.data).slice(0, 300));
        return res.status(resp.status).send(resp.data);
      }

      const rows = parseTupleRows(resp.data).map(parts => {
        const [server, patch, status, start, end, issuer] = parts;
        return { server, patch, status, start, end, issuer };
      });

      const total = rows.length;
      const success = rows.filter(r => /executed successfully/i.test(r.status)).length;
      
      if (shouldLog) log(req, "results summary:", { total, success });

      res.json({ actionId: id, total, success, rows });
    } catch (err) {
      if (shouldLog) log(req, "Action results error:", err?.message || err);
      res.status(500).json({ error: String(err?.message || err) });
    }
  });
}

module.exports = { attachActionHelpers };