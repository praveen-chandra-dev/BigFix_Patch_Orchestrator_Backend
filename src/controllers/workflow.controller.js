const {
    setWorkflowState,
    WORKFLOW_STATE
} = require("../services/workflowState");

async function resetWorkflow(req, res) {
    try {
        await setWorkflowState(WORKFLOW_STATE.RESET);

        return res.json({
            ok: true,
            state: WORKFLOW_STATE.RESET
        });
    } catch (err) {
        console.error(err);

        return res.status(500).json({
            ok: false,
            message: "Failed to reset workflow state."
        });
    }
}

module.exports = {
    resetWorkflow
};