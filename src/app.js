const express = require("express");
const morgan = require("morgan");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const helmet = require("helmet");
const path = require("path");
const fs = require("fs");
const { getCtx } = require("./env");
const { attachDeploymentsRoutes } = require("./routes/deployments");
const { attachBaselineRoutes } = require("./routes/baseline");
const { attachGroupRoutes } = require("./routes/groups");
const { logger } = require("./services/logger");
const { sessionMiddleware, requireAdmin, requireAuth, purgeExpiredSessions } = require("./middlewares/session");


function tryRequire(p) { try { return require(p); } catch (e) { console.warn(`[skip] ${p}:`, e.message); return null; } }
function isRouter(mod) { return !!(mod && typeof mod.use === "function" && mod.handle); }

function attachFlexible(app, ctx, modulePath, namedExport, mountIfRouter = "/api", guard = null) {
  const mod = tryRequire(modulePath);
  if (!mod) return;
  if (namedExport && typeof mod[namedExport] === "function") { mod[namedExport](app, ctx, guard); return; }
  if (typeof mod === "function" && !isRouter(mod)) { mod(app, ctx); return; }
  if (isRouter(mod)) {
    if (guard) { app.use(mountIfRouter, guard, mod); } else { app.use(mountIfRouter, mod); }
    return;
  }
  const fn = Object.values(mod).find(v => typeof v === "function");
  if (fn) fn(app, ctx);
}

const SAML_CALLBACK_PATHS = new Set([
  '/api/auth/saml/callback',
]);

function buildApp() {
  const app = express();
  const ctx = getCtx();

  app.disable("x-powered-by");

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:"],
        frameAncestors: ["'none'"], // Prevents Clickjacking
        formAction: ["'self'"],
        requireTrustedTypesFor: ["'script'"],
        upgradeInsecureRequests: [],
      },
    },
    crossOriginEmbedderPolicy: { policy: "require-corp" },
    crossOriginOpenerPolicy: { policy: "same-origin" },
    crossOriginResourcePolicy: { policy: "same-origin" },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
    xContentTypeOptions: true,
    frameguard: { action: 'deny' }
  }));

  const config = ctx.cfg || require("./env").getCfg();
  const allowedOrigins = new Set(
    (config.FRONTEND_URL || "")
      .split(",")
      .map(u => u.trim())
      .filter(Boolean)
  );

  console.log("[CORS] Allowed origins:", [...allowedOrigins]);

  const corsMiddleware = cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.has(origin)) return callback(null, true);
      callback(new Error("CORS Policy Violation: Origin not allowed."));
    },
    credentials: true,
  });

  app.use((req, res, next) => {
    if (SAML_CALLBACK_PATHS.has(req.path)) {
      return next();
    }
    corsMiddleware(req, res, next);
  });

  app.use((err, req, res, next) => {
    if (err.message?.startsWith("CORS Policy Violation")) {
      logger.warn(`[CORS] Blocked request from origin: ${req.headers.origin || "unknown"} to ${req.method} ${req.path}`);
      return res.status(403).json({ ok: false, error: "Forbidden: CORS policy violation" });
    }
    next(err);
  });

  const morganStream = { write: (message) => logger.info(message.trim()) };
  const morganFormat = ':method :url :status :res[content-length] - :response-time ms';
  app.use(morgan(morganFormat, {
    stream: morganStream,
    skip: (req) => {
      const url = req.originalUrl || req.url;
      return url.includes("/status") || url.includes("/results") ||
        url.includes("/last") || url.includes("/health/") ||
        url.includes("/infra/");
    }
  }));

  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());

  // ── DB-backed session middleware (must run after cookieParser) ────────────
  // Validates the opaque session token on every request and attaches
  // req.session = { UserId, Username, Role } when the session is valid.
  app.use(sessionMiddleware);

  // Prevents browsers from caching sensitive API responses
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.set('Surrogate-Control', 'no-store');
    next();
  });

  // ── API routes ────────────────────────────────────────────────────────────
  app.use(require("./routes/auth"));
  app.use(require("./routes/calendar"));
  app.use(require("./routes/predict"));

  const envRouterPath = require.resolve("./routes/env");
  console.log("[env-router] mounting:", envRouterPath);
  // Vulnerability 1 fix: protect /api/env with Admin-only access
  app.use("/api/env", requireAdmin);
  app.use("/api", require("./routes/env"));

  attachFlexible(app, ctx, "./routes/health", "attachHealthRoutes");
  // Vulnerability 4 fix: protect /api/config with Admin-only access
  attachFlexible(app, ctx, "./routes/config", "attachConfigRoutes", "/api", requireAuth);
  attachFlexible(app, ctx, "./routes/workflow", "attachWorkflowRoutes", "/api", requireAuth);
  
  attachFlexible(app, ctx, "./routes/query", "attachQueryProxy");
  attachFlexible(app, ctx, "./routes/pilot", "attachPilotRoutes");
  attachFlexible(app, ctx, "./routes/actions", "attachActionsRoutes");
  attachFlexible(app, ctx, "./routes/actionsHelpers", "attachActionHelpers");
  attachFlexible(app, ctx, "./routes/snValidate", "attachSnValidate");
  attachDeploymentsRoutes(app, ctx, "./routes/deployments", "attachDeploymentsRoutes");
  attachBaselineRoutes(app, ctx, "./routes/baseline", "attachBaselineRoutes");
  attachFlexible(app, ctx, "./routes/groups", "attachGroupRoutes");
  attachFlexible(app, ctx, "./routes/vcenter", "attachVcenterRoutes");
  attachFlexible(app, ctx, "./routes/riskBaselines", "attachBaselineRoutes");
  attachFlexible(app, ctx, "./routes/groupUpdate", "attachGroupUpdateRoutes");
  attachFlexible(app, ctx, "./routes/policies", "attachPoliciesRoutes");
  attachFlexible(app, ctx, "./routes/roles", "attachRoleRoutes");

  const patchRouter = tryRequire("./routes/patches");
  const cveRouter = tryRequire("./routes/cves");
  const sitesRouter = tryRequire("./routes/sites");
  if (patchRouter) app.use("/api/patches", patchRouter);
  if (cveRouter) app.use("/api/cves", cveRouter);
  if (sitesRouter) app.use("/api/sites", sitesRouter);

  // ── Cache warmup ──────────────────────────────────────────────────────────
  const { warmCache } = require("./services/cacheWarmup");
  setTimeout(() => warmCache(), 5000);
  setInterval(() => {
    console.log("[App] Running scheduled background cache warmup...");
    warmCache();
  }, 5.5 * 60 * 60 * 1000);

  // ── UI serving ────────────────────────────────────────────────────────────
  app.get('/env.js', (req, res) => {
    // Also disable cache for dynamic env config
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.type('application/javascript')
      .send(`window.env = { VITE_API_BASE: window.location.origin };`);
  });
  console.log(`[App] Registered dynamic route for /env.js`);

  const staticDir = ctx.frontend.FRONTEND_DIR;
  const staticIndex = path.join(staticDir, 'index.html');

  if (fs.existsSync(staticIndex)) {
    console.log(`[App] Serving static files from: ${staticDir}`);
    app.use(express.static(staticDir));
    app.get(/.*/, (req, res) => res.sendFile(staticIndex));
  } else {
    console.warn(`[App] Dev Mode: Frontend 'index.html' not found at ${staticIndex}. Serving API only.`);
  }

  // ── Post-patch watcher ────────────────────────────────────────────────────
  const { startPostPatchWatcher } = require("./services/postpatchWatcher");
  startPostPatchWatcher(ctx, {
    intervalMs: Number(process.env.POSTPATCH_POLL_MS) || 60_000
  });

  // ── Scheduled expired-session purge (every 15 minutes) ───────────────────
  setInterval(() => purgeExpiredSessions(), 15 * 60 * 1000);

  // ── Global error handler (Vulnerability 11 fix) ───────────────────────────
  // Must be the LAST middleware registered. Catches any unhandled errors
  // (including JSON body-parser failures) and returns a generic message
  // instead of leaking stack traces / internal paths to the client.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    // Log the full detail server-side only
    logger.error(`[GlobalError] ${req.method} ${req.path} — ${err.message || err}`);
    if (err.stack) logger.error(err.stack);

    const status = (typeof err.status === 'number' && err.status >= 400 && err.status < 600)
      ? err.status
      : 500;

    // Never expose internal details to the client
    res.status(status).json({
      ok: false,
      error: 'request_failed',
      message: 'An error occurred processing the request.'
    });
  });


  return app;
}

module.exports = { buildApp };