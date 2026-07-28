// src/services/roleService.js
const axios = require('axios');
const { sql, getPool } = require('../db/mssql');
const { getBfAuthContext, joinUrl } = require('../utils/http');
const { getRoleAssets, isMasterOperator } = require('./bigfix');

const roleCache = new Map();

function getSessionUser(req) {
    // Vuln 8 fix: read from server-validated session only
    if (req && req.session && req.session.Username) return req.session.Username;
    return null;
}

// function getSessionRole(req) {
//     // Vuln 8 fix: read from server-validated session only
//     if (req && req.session && req.session.Role) return req.session.Role;
//     return null;
// }

function getSessionRole(req) {
    if (req && req.session && req.session.Role) {
        const assignedRoles = req.session.Role.split(',').map(r => r.trim());
        let requestedRole = req.headers['x-user-role'] || (req.cookies && req.cookies.active_role);

        if (requestedRole) {
            if (requestedRole.includes(',')) requestedRole = requestedRole.split(',')[0].trim();
            if (assignedRoles.includes('Admin') || assignedRoles.includes(requestedRole)) {
                return requestedRole;
            }
        }
        return assignedRoles[0];
    }
    return null;
}

async function getAllowedSites(req, ctx) {
    try {
        let username = getSessionUser(req);
        // Vuln 8 fix: no x-active-user header fallback

        let activeRole = getSessionRole(req) || "Default";

        if (!username) return [];

        const cacheKey = `${username}_${activeRole}`;
        const cached = roleCache.get(cacheKey);
        if (cached && Date.now() < cached.expiry) return cached.sites;

        const isMO = await isMasterOperator(req, ctx, username);
        if (isMO || activeRole.toLowerCase() === 'admin') return ["__ALL__"];

        // Uses the aggressive parser 
        const roleAssets = await getRoleAssets(req, ctx, activeRole);
        const finalAllowedSites = [...new Set([...roleAssets.customSites, ...roleAssets.externalSites])];

        roleCache.set(cacheKey, { sites: finalAllowedSites, expiry: Date.now() + (10 * 60 * 1000) });
        return finalAllowedSites;

    } catch (e) {
        console.error("getAllowedSites ERROR:", e.message);
        return [];
    }
}

module.exports = { getAllowedSites };