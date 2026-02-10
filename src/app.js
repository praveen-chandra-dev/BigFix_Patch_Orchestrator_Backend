// src/app.js
const express = require("express");
const morgan  = require("morgan");
const cors    = require("cors");
const cookieParser = require("cookie-parser");
const path = require("path");
const fs = require("fs");
const { getCtx } = require("./env");
const { attachDeploymentsRoutes } = require("./routes/deployments");
const { attachBaselineRoutes } = require("./routes/baseline");
const { attachGroupRoutes } = require("./routes/groups");
const { logger } = require("./services/logger"); 

function tryRequire(p) { try { return require(p); } catch (e) { console.warn(`[skip] ${p}:`, e.message); return null; } }
function isRouter(mod) { return !!(mod && typeof mod.use === "function" && mod.handle); }

function attachFlexible(app, ctx, modulePath, namedExport, mountIfRouter = "/api") {
  const mod = tryRequire(modulePath);

  if (!mod) return;
  if (namedExport && typeof mod[namedExport] === "function") { mod[namedExport](app, ctx); return; }

  if (typeof mod === "function" && !isRouter(mod)) { mod(app, ctx); return; }
  if (isRouter(mod)) { app.use(mountIfRouter, mod); return; }

  const fn = Object.values(mod).find(v => typeof v === "function");
  if (fn) fn(app, ctx);
}

function buildApp() {

  const app = express();
  const ctx = getCtx();

  const feHost = String(ctx.cfg?.FRONTEND_URL || `http://localhost:5174`);
  
  app.use(cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (origin.includes("localhost")) return callback(null, true);
      if (origin === feHost) return callback(null, true);
      callback(null, true);
    },
    credentials: true,
  }));

  const morganStream = {
    write: (message) => {
      logger.info(message.trim());
    },
  };

  const morganFormat = ':method :url :status :res[content-length] - :response-time ms';
  app.use(morgan(morganFormat, { stream: morganStream }));

  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());

  // --- API ROUTES ---
  app.use(require("./routes/auth"));
  app.use(require("./routes/calendar")); 
  
  // --- NEW: Predict Route (FIXED) ---
  // This line was missing or not saved, causing the 404 error
  app.use(require("./routes/predict")); 

  const envRouterPath = require.resolve("./routes/env");
  console.log("[env-router] mounting:", envRouterPath);
  app.use("/api", require("./routes/env"));

  attachFlexible(app, ctx, "./routes/health",         "attachHealthRoutes");
  attachFlexible(app, ctx, "./routes/config",         "attachConfigRoutes");
  attachFlexible(app, ctx, "./routes/query",          "attachQueryProxy");
  attachFlexible(app, ctx, "./routes/pilot",          "attachPilotRoutes");
  attachFlexible(app, ctx, "./routes/actions",        "attachActionsRoutes");
  attachFlexible(app, ctx, "./routes/actionsHelpers", "attachActionHelpers");
  attachFlexible(app, ctx, "./routes/snValidate",     "attachSnValidate");
  attachDeploymentsRoutes(app, ctx, "./routes/deployments", "attachDeploymentsRoutes");
  attachBaselineRoutes(app, ctx, "./routes/baseline", "attachBaselineRoutes");
  attachFlexible(app, ctx, "./routes/groups", "attachGroupRoutes");
  attachFlexible(app, ctx, "./routes/vcenter",        "attachVcenterRoutes");

  app.get('/env.js', (req, res) => {
      const jsContent = `window.env = { VITE_API_BASE: window.location.origin };`;
      res.type('application/javascript').send(jsContent);
  });
  console.log(`[App] Registered dynamic route for /env.js`);

  const staticDir = ctx.frontend.FRONTEND_DIR;
  const staticIndex = path.join(staticDir, 'index.html');
  
  if (fs.existsSync(staticIndex)) {
    console.log(`[App] Serving static files from: ${staticDir}`);
    app.use(express.static(staticDir));
    app.get(/.*/, (req, res) => { 
      res.sendFile(staticIndex);
    });
  } else {
    console.warn(`[App] Dev Mode: Frontend 'index.html' not found at ${staticIndex}. Serving API only.`);
  }

  const { startPostPatchWatcher } = require("./services/postpatchWatcher");
  const intervalMs = Number(process.env.POSTPATCH_POLL_MS) || 60_000;

  startPostPatchWatcher(ctx, { intervalMs });

  return app;
}

module.exports = { buildApp };
