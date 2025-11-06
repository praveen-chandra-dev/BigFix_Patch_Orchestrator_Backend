// src/app.js
const express = require("express");
const morgan  = require("morgan");
const cors    = require("cors");
const { getCtx } = require("./env");

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

  app.use(cors());
  app.use(morgan("dev"));
  app.use(express.json({ limit: "1mb" }));

  // ✅ Mount *our* env router and log exactly which file got mounted
  const envRouterPath = require.resolve("./routes/env");
  console.log("[env-router] mounting:", envRouterPath);
  app.use("/api", require("./routes/env"));

  // Rest routes
  attachFlexible(app, ctx, "./routes/health",         "attachHealthRoutes");
  attachFlexible(app, ctx, "./routes/config",         "attachConfigRoutes");
  attachFlexible(app, ctx, "./routes/query",          "attachQueryProxy");
  attachFlexible(app, ctx, "./routes/actions",        "attachActionsRoutes");
  attachFlexible(app, ctx, "./routes/actionsHelpers", "attachActionHelpers");
  attachFlexible(app, ctx, "./routes/snValidate",     "attachSnValidate");
  attachFlexible(app, ctx, "./routes/pilot",          "attachPilotRoutes");

  return app;
}

module.exports = { buildApp };
