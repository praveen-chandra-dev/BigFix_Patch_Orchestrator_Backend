// src/controllers/team.controller.js
const { sql, getPool } = require('../db/mssql');
const { getCookieOptions, getSessionData } = require('../middlewares/auth.middleware');

async function getTeamState(req, res) {
    // const session = getSessionData(req);
    // if (!session) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    // Vulnerability 8 fix: role comes from server-validated session only
    // req.query.role is allowed as a view-selection hint (not a privilege escalation path)
    // because the actual privilege check is always done from session.dbRole/role.
    // let activeRole = req.query.role || session.role;
    // if (!activeRole) return res.status(400).json({ ok: false, error: 'No active role provided' });

    // const primaryRole = session.dbRole || session.role;
    // if (primaryRole && primaryRole.toLowerCase() === 'admin') {
    //     activeRole = 'Admin';
    // }
    const session = getSessionData(req);
    if (!session) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    const assignedRoles = (session.dbRole || session.role || "").split(',').map(r => r.trim());
    
    // Read from header, query, or the active_role cookie
    let requestedRole = req.headers['x-user-role'] || req.query.role || (req.cookies && req.cookies.active_role);
    if (requestedRole && requestedRole.includes(',')) {
        requestedRole = requestedRole.split(',')[0].trim();
    }

    let activeRole = 'No Role Assigned';

    // Strictly validate against the user's actual DB roles (Vuln 8 compliance)
    if (assignedRoles.includes('Admin')) {
        activeRole = 'Admin';
    } else if (requestedRole && assignedRoles.includes(requestedRole)) {
        activeRole = requestedRole;
    } else if (assignedRoles.length > 0) {
        activeRole = assignedRoles[0]; // fallback
    }

    if (!activeRole || activeRole === 'No Role Assigned') {
        return res.status(400).json({ ok: false, error: 'No active role provided' });
    }

    // Drop a secure cookie so the UI remembers this switch across hard page reloads
    res.cookie('active_role', activeRole, getCookieOptions());
    // Note: no longer re-writing the cookie here — session is server-side only

    try {
        const pool = await getPool();
        const roleBucket = `Role_${activeRole}`;
        
        const qSelect = "SELECT StateValue FROM dbo.SystemState WHERE StateKey = @RoleKey";
        const qInsert = "INSERT INTO dbo.SystemState (StateKey, StateValue) VALUES (@RoleKey, @EmptyState)";
        
        const stateRes = await pool.request()
            .input('RoleKey', sql.NVarChar(50), roleBucket)
            .query(qSelect);

        let rawState = "{}";
        if (stateRes.recordset.length > 0) {
            rawState = stateRes.recordset[0].StateValue || "{}";
        } else {
            await pool.request()
                .input('RoleKey', sql.NVarChar(50), roleBucket)
                .input('EmptyState', sql.NVarChar(sql.MAX), "{}")
                .query(qInsert);
        }
        
        res.json({ ok: true, role: activeRole, state: JSON.parse(rawState) });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
}

async function updateTeamState(req, res) {
    // const session = getSessionData(req);
    // if (!session) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    // Vulnerability 8 fix: role from session, not client header
    // let activeRole = req.query.role || session.role;
    // if (!activeRole) return res.status(400).json({ ok: false, error: 'No active role provided' });

    // const primaryRole = session.dbRole || session.role;
    // if (primaryRole && primaryRole.toLowerCase() === 'admin') {
    //     activeRole = 'Admin';
    // }
   const session = getSessionData(req);
    if (!session) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    const assignedRoles = (session.dbRole || session.role || "").split(',').map(r => r.trim());
    
    // Read from header, query, or the active_role cookie
    let requestedRole = req.headers['x-user-role'] || req.query.role || (req.cookies && req.cookies.active_role);
    if (requestedRole && requestedRole.includes(',')) {
        requestedRole = requestedRole.split(',')[0].trim();
    }

    let activeRole = 'No Role Assigned';

    // Strictly validate against the user's actual DB roles (Vuln 8 compliance)
    if (assignedRoles.includes('Admin')) {
        activeRole = 'Admin';
    } else if (requestedRole && assignedRoles.includes(requestedRole)) {
        activeRole = requestedRole;
    } else if (assignedRoles.length > 0) {
        activeRole = assignedRoles[0]; // fallback
    }

    if (!activeRole || activeRole === 'No Role Assigned') {
        return res.status(400).json({ ok: false, error: 'No active role provided' });
    }

    // Drop a secure cookie so the UI remembers this switch across hard page reloads
    res.cookie('active_role', activeRole, getCookieOptions());
    // Note: no longer re-writing the cookie here — session is server-side only

   try {
        const stateStr = JSON.stringify(req.body);
        const pool = await getPool();
        const roleBucket = `Role_${activeRole}`;

        const qUpdate = "UPDATE dbo.SystemState SET StateValue = @Val WHERE StateKey = @RoleKey";
        const qInsert = "INSERT INTO dbo.SystemState (StateKey, StateValue) VALUES (@RoleKey, @Val)";

        const updateRes = await pool.request()
            .input('Val', sql.NVarChar(sql.MAX), stateStr)
            .input('RoleKey', sql.NVarChar(50), roleBucket)
            .query(qUpdate);
            
        if (updateRes.rowsAffected[0] === 0) {
            await pool.request()
                .input('Val', sql.NVarChar(sql.MAX), stateStr)
                .input('RoleKey', sql.NVarChar(50), roleBucket)
                .query(qInsert);
        }
        
        res.json({ ok: true, saved: true, role: activeRole });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
}

// Server-side, role-scoped merge into the team-state JSON blob.
async function setTeamStateForRole(role, partialState) {
    if (!role || !partialState || typeof partialState !== 'object') return;
    try {
        const pool = await getPool();
        const roleBucket = `Role_${role}`;

        const rs = await pool.request()
            .input('RoleKey', sql.NVarChar(50), roleBucket)
            .query("SELECT StateValue FROM dbo.SystemState WHERE StateKey = @RoleKey");

        let existing = {};
        if (rs.recordset.length > 0) {
            try { existing = JSON.parse(rs.recordset[0].StateValue || "{}"); } catch { existing = {}; }
        }

        const merged = { ...existing, ...partialState };
        if (partialState.lastActions && typeof partialState.lastActions === 'object') {
            merged.lastActions = { ...(existing.lastActions || {}), ...partialState.lastActions };
        }

        const stateStr = JSON.stringify(merged);

        if (rs.recordset.length > 0) {
            await pool.request()
                .input('Val', sql.NVarChar(sql.MAX), stateStr)
                .input('RoleKey', sql.NVarChar(50), roleBucket)
                .query("UPDATE dbo.SystemState SET StateValue = @Val WHERE StateKey = @RoleKey");
        } else {
            await pool.request()
                .input('Val', sql.NVarChar(sql.MAX), stateStr)
                .input('RoleKey', sql.NVarChar(50), roleBucket)
                .query("INSERT INTO dbo.SystemState (StateKey, StateValue) VALUES (@RoleKey, @Val)");
        }
    } catch (e) {
        console.warn(`[TeamState] setTeamStateForRole('${role}') failed: ${e.message}`);
    }
}

module.exports = { getTeamState, updateTeamState, setTeamStateForRole };
