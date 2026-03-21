// src/services/roleService.js
const axios = require('axios');
const { sql, getPool } = require('../db/mssql');
const { getBfAuthContext, joinUrl } = require('../utils/http');
const { getRoleAssets, isMasterOperator } = require('./bigfix');

const roleCache = new Map();

function getSessionUser(req) {
    if (!req || !req.cookies || !req.cookies.auth_session) return null;
    try { return JSON.parse(req.cookies.auth_session).username; } catch { return null; }
}

function getSessionRole(req) {
    if (!req || !req.cookies || !req.cookies.auth_session) return null;
    try { return JSON.parse(req.cookies.auth_session).role; } catch { return null; }
}

async function getAllowedSites(req, ctx) {
    try {
        let username = getSessionUser(req);
        if (!username && req && req.headers) username = req.headers['x-active-user'];

        let activeRole = req && req.headers ? req.headers['x-user-role'] : null;
        if (!activeRole) activeRole = getSessionRole(req) || "Default";

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