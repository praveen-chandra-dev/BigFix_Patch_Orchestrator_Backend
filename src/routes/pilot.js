const stageController = require("../controllers/pilot");

function attachPilotRoutes(app, ctx) {
  // Pilot Endpoints
  app.post("/api/pilot/actions", stageController.triggerPilot);
  app.post("/api/pilot/actions/force", stageController.triggerPilotForce);
  
  // Production Endpoints
  app.post("/api/production/actions", stageController.triggerProduction);
  app.post("/api/production/actions/force", stageController.triggerProductionForce);
}

module.exports = { attachPilotRoutes };

