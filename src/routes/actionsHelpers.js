// src/routes/actionsHelpers.js
const axios = require("axios");
const { joinUrl, getBfAuthContext, getSessionUser, getSessionRole } = require("../utils/http");
const { parseTupleRows } = require("../utils/query");
const { actionStore } = require("../state/store");
const { logFactory } = require("../utils/log");
const { triggerEarlyStop } = require("../services/postpatchWatcher"); 
const { isMasterOperator, getRoleAssets } = require("../services/bigfix");

// Returns true when `issuerName` is either the active user themselves or a teammate
// (another operator listed under the active user's role in BigFix). This unlocks team-based
// visibility for the BOLA checks on /api/actions/:id/status and /api/actions/:id/results so
// the Sandbox stage and Deployment History don't 403 for users who share a role with the
// person who triggered the action.
async function issuerInUserTeam(req, ctx, activeUser, activeRole, issuerName) {
    const userLc = String(activeUser || "").toLowerCase();
    const issuerLc = String(issuerName || "").toLowerCase();
    if (!issuerLc) return false;
    if (issuerLc === userLc) return true;
    if (!activeRole || activeRole === "No Role Assigned") return false;
    try {
        const roleAssets = await getRoleAssets(req, ctx, activeRole);
        const ops = Array.isArray(roleAssets?.operators) ? roleAssets.operators : [];
        // Both the current user AND the issuer must appear in the role's operator list for
        // visibility to be granted. Without checking the current user too, a role lookup
        // failure (returning [] for both) would silently allow everything.
        return ops.includes(userLc) && ops.includes(issuerLc);
    } catch (e) { return false; }
}

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

const statusLogThrottle = {};
const resultsLogThrottle = {};
let lastActionLogTime = 0;

function attachActionHelpers(app, ctx) {
  const log = logFactory(ctx.DEBUG_LOG);
  const { BIGFIX_BASE_URL } = ctx.bigfix;

  app.get("/api/actions/last", (req, res) => {
    const now = Date.now();
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
      if (!id || id === "null" || id === "undefined" || !/^\d+$/.test(id)) {
         return res.status(400).json({ ok: false, state: "Invalid ID", mailSent: false });
      }

      // BOLA: verify the user is allowed to see this action. The user can see it if:
      //   - they are a Master Operator, OR
      //   - they triggered it themselves, OR
      //   - they share an active role with the issuer (team visibility).
      // The in-memory actionStore is wiped on every Node restart, so we always confirm the
      // real issuer from BigFix when memory doesn't have it.
      //
      // We ALSO scope the endpoint to Patch Setu's own actions (BPS_-prefixed) — same as the
      // /results endpoint — to keep this from being used as a generic action-introspection API.
      // For in-memory entries this scope is implicit (actionStore only ever contains BPS_
      // actions we ourselves created); for the BigFix-fallback path we have to fetch and check.
      const activeUser = getSessionUser(req);
      const activeRole = getSessionRole(req)  /* Vuln 8 fix: role from session only */;
      const isMO = await isMasterOperator(req, ctx, activeUser);
      const entryForScope = actionStore.actions[id];

      if (!entryForScope) {
          // Fetch name + issuer from BigFix; needed both for scope check and BOLA check below.
          try {
              const scopeRelevance =
                  `((name of it as string | "N/A"), (name of issuer of it as string | "N/A"))` +
                  ` of bes action whose (id of it = ${id})`;
              const scopeUrl = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(scopeRelevance)}`;
              const bfAuthOpts = await getBfAuthContext(req, ctx);
              const scopeResp = await axios.get(scopeUrl, { ...bfAuthOpts, headers: { Accept: "application/json" }, validateStatus: () => true });

              const rows = parseTupleRows(scopeResp.data);
              if (!rows.length) {
                  // BigFix doesn't know the action either → it really doesn't exist (or is hidden from this user)
                  return res.json({ ok: true, state: "expired", mailSent: true });
              }
              const [scopeName, scopeIssuer] = rows[0];

              if (!String(scopeName || "").startsWith("BPS_")) {
                  if (shouldLog) log(req, "Out-of-scope action requested via status:", { id, scopeName });
                  return res.status(404).json({ ok: false, error: "Action not found." });
              }

              if (!isMO) {
                  const allowed = await issuerInUserTeam(req, ctx, activeUser, activeRole, scopeIssuer);
                  if (!allowed) {
                      return res.status(403).json({ ok: false, error: "Unauthorized access to action status." });
                  }
              }
          } catch (e) {
              if (shouldLog) log(req, "Status scope+ownership BF query failed:", e?.message || e);
              return res.status(500).json({ ok: false, error: "Could not verify action ownership." });
          }
      } else if (!isMO) {
          // Memory has it — entry.triggeredBy is authoritative for the issuer; BPS_ scope is implicit.
          const allowed = await issuerInUserTeam(req, ctx, activeUser, activeRole, entryForScope.triggeredBy);
          if (!allowed) {
              return res.status(403).json({ ok: false, error: "Unauthorized access to action status." });
          }
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

      const activeUser = getSessionUser(req);
      const activeRole = getSessionRole(req)  /* Vuln 8 fix: role from session only */;
      const isMO = await isMasterOperator(req, ctx, activeUser);
      const bfAuthOpts = await getBfAuthContext(req, ctx);

      // STEP 1: Verify the action exists and capture its name + issuer, separately from the
      // results query. We project the action's NAME alongside the issuer because we use it
      // immediately below to enforce the BPS_-prefix scope (the BOLA-hardening step). The
      // previous one-shot approach asked for `results of bes action whose (...issuer filter)`,
      // which returns empty both when the user has no permission AND when the action simply has
      // no results yet (just-triggered actions, actions stopped before clients reported, etc.) —
      // and surfaced both as a misleading 403.
      const existsRelevance =
        `((id of it as string | "N/A"), (name of it as string | "N/A"), (name of issuer of it as string | "N/A"))` +
        ` of bes action whose (id of it = ${id})`;
      const existsUrl = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(existsRelevance)}`;
      const existsResp = await axios.get(existsUrl, {
          ...bfAuthOpts,
          headers: { Accept: "application/json" },
          validateStatus: () => true,
      });

      if (existsResp.status < 200 || existsResp.status >= 300) {
        if (shouldLog) log(req, "BF action-exists query failed:", existsResp.status, String(existsResp.data).slice(0, 300));
        return res.status(existsResp.status).send(existsResp.data);
      }

      const existsRows = parseTupleRows(existsResp.data);
      if (!existsRows.length) {
        // Action genuinely doesn't exist (or BigFix RBAC hid it from this user's own creds entirely).
        return res.status(404).json({ error: "Action not found." });
      }

      const [, actionName, actionIssuer] = existsRows[0];

      // BOLA hardening: scope this endpoint strictly to Patch Setu's own actions (BPS_-prefixed).
      // The orchestration UI never displays or links to non-BPS actions, so any request for a
      // non-BPS action through this endpoint is either a mistake or path-tampering. Returning
      // 404 (rather than 200) closes the BOLA window even for Master Operators, who would
      // otherwise be able to use this endpoint as a generic action-introspection API — that's
      // BigFix Console's job, not Patch Setu's.
      if (!String(actionName || "").startsWith("BPS_")) {
          if (shouldLog) log(req, "Out-of-scope action requested:", { id, actionName });
          return res.status(404).json({ error: "Action not found." });
      }

      // STEP 2: Enforce BOLA — non-MO callers may inspect actions issued by themselves OR by
      // any teammate (another operator listed under the active role). This unlocks team-based
      // visibility while still blocking access for users in unrelated roles.
      if (!isMO) {
          const allowed = await issuerInUserTeam(req, ctx, activeUser, activeRole, actionIssuer);
          if (!allowed) {
              return res.status(403).json({ error: "You do not have permission to view this action." });
          }
      }

      // STEP 3: Now safely fetch results. An empty array here means "no results yet", not "forbidden".
      const relevance =
        `((if exists (name of computers of it) then name of computers of it else "N/A"),` +
        ` (if exists (names of member actions of actions of it) then (names of member actions of actions of it) else "N/A"),` +
        ` (detailed status of it as string | "N/A"),` +
        ` (start time of it as string | "N/A"),` +
        ` (end time of it as string | "N/A"), (name of issuer of action of it as string | "N/A")) of results of bes action whose (id of it = ${id})`;

      const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
      const resp = await axios.get(url, {
          ...bfAuthOpts,
          headers: { Accept: "application/json" },
          validateStatus: () => true,
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