// bigfix-backend/src/routes/deployments.js
const axios = require("axios");
const { joinUrl } = require("../utils/http");
const { logFactory } = require("../utils/log");
const { getBfAuthContext } = require("../utils/http");
const { getSessionUserLocal, getSessionData } = require("../middlewares/auth.middleware");
const { getRoleAssets } = require("../services/bigfix");

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
  const { BIGFIX_BASE_URL } = ctx.bigfix;

  app.get("/api/deployments/bps", async (req, res) => {
    try {
      // 1. Resolve the active user + role.
      //
      // Admin/MO status is determined by the DB-assigned role (immutable for the session) —
      // switching roles in the UI shouldn't grant or revoke admin privileges. For non-admins,
      // the role we use for team-visibility is the role the user is CURRENTLY operating as,
      // selected via the role switcher (x-user-role header) and reflected in session.role
      // after team-state load.
      //
      // Using session.dbRole here would silently look up the wrong role's operators for any
      // user whose DB row doesn't exactly match the role they pick in the UI — including
      // LDAP-group members who get roles via the role's <LDAPGroups> block rather than an
      // explicit DB seed. That's exactly the irish-on-WindowTeamRole case: irish is a
      // WindowTeamRole member via BGU-SrvAut LDAP group, so irish's dbRole != "WindowTeamRole"
      // and the old code looked up the wrong role's operators (or got an empty list).
      const username = getSessionUserLocal(req) || "";
      const session = getSessionData(req);
      // const dbRole = session ? (session.dbRole || "") : "";
      // const isAdmin = dbRole && dbRole.toLowerCase() === 'admin';
      // const activeRole = isAdmin
      //     ? 'Admin'
      //     : ((session ? session.role : "") || "");  /* Vuln 8 fix: no client header */
      const dbRole = session ? (session.dbRole || "") : "";
      const isAdmin = dbRole && dbRole.toLowerCase() === 'admin';
      
      let activeRole = 'No Role Assigned';
      if (isAdmin) {
          activeRole = 'Admin';
      } else if (session && session.role) {
          const assignedRoles = session.role.split(',').map(r => r.trim());
          let requestedRole = req.headers['x-user-role'] || (req.cookies && req.cookies.active_role);
          
          if (requestedRole && requestedRole.includes(',')) {
              requestedRole = requestedRole.split(',')[0].trim();
          }
          
          activeRole = (requestedRole && assignedRoles.includes(requestedRole)) ? requestedRole : assignedRoles[0];
      }

      // 2. Build the issuer filter. Admins see all BPS_ actions. Everyone else sees actions
      // issued by themselves OR by any teammate (another operator listed under their active role).
      // This gives the orchestration / deployment history a team-shared view, matching how
      // role-based work is actually organized.
      let issuerFilter = '';
      if (!isAdmin) {
          const teammates = new Set();
          teammates.add(username.toLowerCase());
          if (activeRole && activeRole !== 'No Role Assigned') {
              try {
                  const roleAssets = await getRoleAssets(req, ctx, activeRole);
                  for (const op of (roleAssets?.operators || [])) {
                      teammates.add(String(op).toLowerCase());
                  }
              } catch (e) { /* fall through with just self */ }
          }
          const issuerSet = Array.from(teammates).map(n => `"${n.replace(/"/g, '\\"')}"`).join(";");
          issuerFilter = ` and (name of issuer of it as lowercase is contained by set of (${issuerSet}))`;

          // One-line audit trail for debugging team-visibility issues — see what role was used
          // and which teammates were resolved. Cheap, no PII beyond what's already in BigFix.
          log(req, `GET /api/deployments/bps. User=[${username}] activeRole=[${activeRole}] teammates=[${Array.from(teammates).join(', ')}]`);
      }

      // 3. Inject the filter into the Relevance query
      const relevance =
        `((name of it as string | "N/A") & " | " & ` +
        `(id of it as string | "N/A") & " | " & ` +
        `(state of it as string | "N/A") & " | " & ` +
        `(time issued of it as string | "N/A") & " | " & ` +
        `((if exists end date of it then end date of it as string & " " & end time_of_day of it as string else "None") of it) & " | " & ` + 
        `(name of issuer of it as string | "N/A")) of bes actions whose (name of it starts with "BPS_"${issuerFilter})`;

      const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
      
      const bfAuthOpts = await getBfAuthContext(req, ctx); 

      const r = await axios.get(url, {
        ...bfAuthOpts,
        headers: { Accept: "application/json" },
        responseType: "json",
        timeout: 60_000,
        validateStatus: () => true,
      });

      if (r.status < 200 || r.status >= 300) return res.status(r.status).send(r.data);

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

      const items = flat.filter(Boolean).map(parseRow).sort((a,b) => (Number(b.id)||0) - (Number(a.id)||0));
      res.json({ ok: true, count: items.length, items });
    } catch (e) {
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });
}

module.exports = { attachDeploymentsRoutes };