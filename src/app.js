// src/app.js
const express = require("express");
const morgan  = require("morgan");
const cors    = require("cors");
const { getCtx } = require("./env");
const { attachDeploymentsRoutes } = require("./routes/deployments");

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

  app.use(cors({
    origin: [/^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/],
    credentials: false,
  }));
  app.use(morgan("dev"));
  app.use(express.json({ limit: "1mb" }));

  app.use(require("./routes/auth"));

  const envRouterPath = require.resolve("./routes/env");
  console.log("[env-router] mounting:", envRouterPath);
  app.use("/api", require("./routes/env"));

  attachFlexible(app, ctx, "./routes/health",         "attachHealthRoutes");
  attachFlexible(app, ctx, "./routes/config",         "attachConfigRoutes");
  attachFlexible(app, ctx, "./routes/query",          "attachQueryProxy");

  // Load Pilot/Production routes FIRST
  attachFlexible(app, ctx, "./routes/pilot",          "attachPilotRoutes");
  // Generic actions
  attachFlexible(app, ctx, "./routes/actions",        "attachActionsRoutes");


  attachFlexible(app, ctx, "./routes/actionsHelpers", "attachActionHelpers");
  attachFlexible(app, ctx, "./routes/snValidate",     "attachSnValidate");
  attachDeploymentsRoutes(app, ctx, "./routes/deployments", "attachDeploymentsRoutes");


    // ---- START POST-PATCH WATCHER (backend-only) ----
  const { startPostPatchWatcher } = require("./services/postpatchWatcher");
  const intervalMs = Number(process.env.POSTPATCH_POLL_MS) || 60_000;
  startPostPatchWatcher(ctx, { intervalMs });
  // -------------------------------------------------


  return app;
}

module.exports = { buildApp };
