// src/controllers/team.controller.js
const { sql, getPool } = require('../db/mssql');
const { getCookieOptions, getSessionData } = require('../middlewares/auth.middleware');

async function getTeamState(req, res) {
    const session = getSessionData(req);
    if (!session) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    let activeRole = req.query.role || req.headers['x-user-role'] || session.role;
    if (!activeRole) return res.status(400).json({ ok: false, error: 'No active role provided' });

    const primaryRole = session.dbRole || session.role;
    if (primaryRole && primaryRole.toLowerCase() === 'admin') {
        session.role = 'Admin';
        activeRole = 'Admin'; 
    } else {
        session.role = activeRole;
    }
    res.cookie('auth_session', JSON.stringify(session), getCookieOptions());

    try {
        const pool = await getPool();
        const roleBucket = `Role_${activeRole}`;
        
        const stateRes = await pool.request().input('RoleKey', sql.NVarChar(50), roleBucket).query("SELECT StateValue FROM dbo.SystemState WHERE StateKey = @RoleKey");

        let rawState = "{}";
        if (stateRes.recordset.length > 0) rawState = stateRes.recordset[0].StateValue || "{}";
        else await pool.request().input('RoleKey', sql.NVarChar(50), roleBucket).query("INSERT INTO dbo.SystemState (StateKey, StateValue) VALUES (@RoleKey, '{}')");
        
        res.json({ ok: true, role: activeRole, state: JSON.parse(rawState) });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
}

async function updateTeamState(req, res) {
    const session = getSessionData(req);
    if (!session) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    let activeRole = req.query.role || req.headers['x-user-role'] || session.role;
    if (!activeRole) return res.status(400).json({ ok: false, error: 'No active role provided' });

    const primaryRole = session.dbRole || session.role;
    if (primaryRole && primaryRole.toLowerCase() === 'admin') {
        session.role = 'Admin';
        activeRole = 'Admin';
    } else {
        session.role = activeRole;
    }
    res.cookie('auth_session', JSON.stringify(session), getCookieOptions());

    try {
        const stateStr = JSON.stringify(req.body);
        const pool = await getPool();
        const roleBucket = `Role_${activeRole}`;

        const updateRes = await pool.request().input('Val', sql.NVarChar(sql.MAX), stateStr).input('RoleKey', sql.NVarChar(50), roleBucket).query("UPDATE dbo.SystemState SET StateValue = @Val WHERE StateKey = @RoleKey");
        if (updateRes.rowsAffected[0] === 0) await pool.request().input('Val', sql.NVarChar(sql.MAX), stateStr).input('RoleKey', sql.NVarChar(50), roleBucket).query("INSERT INTO dbo.SystemState (StateKey, StateValue) VALUES (@RoleKey, @Val)");
        
        res.json({ ok: true, saved: true, role: activeRole });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
}

module.exports = { getTeamState, updateTeamState };