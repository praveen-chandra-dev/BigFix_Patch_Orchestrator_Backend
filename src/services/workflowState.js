//src\services\workflowState.js
const { sql, getPool } = require("../db/mssql");

const WORKFLOW_STATE = {
    NEW: "NEW",
    RUNNING: "RUNNING",
    RESET: "RESET",
    COMPLETED: "COMPLETED"
};

const KEY = "PatchWorkflowState";
const VALID_STATES = new Set(Object.values(WORKFLOW_STATE));

async function getWorkflowState() {
    const pool = await getPool();

    const result = await pool.request()
        .input("Key", sql.NVarChar(50), KEY)
        .query(`
            SELECT StateValue
            FROM dbo.SystemState
            WHERE StateKey = @Key
        `);

    if (!result.recordset.length) {
        return { state: WORKFLOW_STATE.NEW, stage: null };
    }

    const raw = result.recordset[0].StateValue;

    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && parsed.state) {
            return { state: parsed.state, stage: parsed.stage || null };
        }
    } catch {
        // Not JSON — fall through to legacy handling below.
    }

    return { state: raw, stage: null };
}

async function setWorkflowState(state, stage = null) {

    if (!VALID_STATES.has(state)) {
        throw new Error(`Invalid workflow state: ${state}`);
    }

    const pool = await getPool();
    const value = JSON.stringify({ state, stage });

    await pool.request()
        .input("Key", sql.NVarChar(50), KEY)
        .input("Value", sql.NVarChar(200), value)
        .query(`
MERGE dbo.SystemState AS t
USING (SELECT @Key AS StateKey) AS s
ON t.StateKey = s.StateKey

WHEN MATCHED THEN
    UPDATE SET
        StateValue = @Value,
        UpdatedAt = SYSUTCDATETIME()

WHEN NOT MATCHED THEN
    INSERT (StateKey, StateValue)
    VALUES (@Key, @Value);
`);
}

module.exports = {
    WORKFLOW_STATE,
    getWorkflowState,
    setWorkflowState
};