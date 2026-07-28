const workflowController = require("../controllers/workflow.controller");

function attachWorkflowRoutes(app) {
    app.post("/api/workflow/reset", workflowController.resetWorkflow);
}

module.exports = {
    attachWorkflowRoutes
};