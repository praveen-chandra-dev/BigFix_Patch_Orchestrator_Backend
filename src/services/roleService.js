const axios = require('axios');
const { sql, getPool } = require('../db/mssql');
const { getBfAuthContext, joinUrl } = require('../utils/http');
const { parseRoleXml } = require('../utils/roleParser');

const roleCache = new Map();
// helper to extract username from cookie
function getSessionUser(req) {
    if (!req.cookies || !req.cookies.auth_session) return null;
    try {
        return JSON.parse(req.cookies.auth_session).username;
    } catch {
        return null;
    }
}

async function getAllowedSites(req, ctx) {
    try {


        // =========================
        // STEP 1: USERNAME
        // =========================
        let username = getSessionUser(req);

        if (!username) {
            username = req.headers['x-active-user'];
        }

        console.log("===== DEBUG START =====");
        console.log("USERNAME:", username);

        if (!username) {
            console.log("No username found");
            return [];
        }
        /* =========================
         CACHE CHECK 
        ========================= */
        const cached = roleCache.get(username);

        if (cached && Date.now() < cached.expiry) {
            console.log("RBAC CACHE HIT");
            return cached.sites;
        }

        // ALWAYS use SERVICE ACCOUNT 
        const bfAuthOpts = await getBfAuthContext(null, ctx);
        const { BIGFIX_BASE_URL } = ctx.bigfix;

        // =========================
        // STEP 2: OPERATOR API
        // =========================
        const opUrl = joinUrl(
            BIGFIX_BASE_URL,
            `/api/operator/${encodeURIComponent(username)}`
        );

        let opResp;
        try {
            opResp = await axios.get(opUrl, {
                ...bfAuthOpts,
                timeout: 10000
            });
        } catch (e) {
            console.log("❌ Operator API FAILED:", e.message);
            return [];
        }

        console.log("OPERATOR RAW XML:");
        console.log(opResp.data);

        const xml = String(opResp.data);

        // =========================
        // MASTER CHECK
        // =========================
        const moMatch = xml.match(/<MasterOperator>(.*?)<\/MasterOperator>/i);

        if (moMatch) {
            const val = moMatch[1].trim().toLowerCase();

            if (val === "true" || val === "1") {
                console.log("MASTER OPERATOR → NO FILTER");
                return ["__ALL__"];
            }
        }

        // =========================
        // STEP 3: FETCH USER ROLES
        // =========================
        const rolesUrl = joinUrl(
            BIGFIX_BASE_URL,
            `/api/operator/${encodeURIComponent(username)}/roles`
        );

        let rolesResp;
        try {
            rolesResp = await axios.get(rolesUrl, {
                ...bfAuthOpts,
                timeout: 10000
            });
        } catch (e) {
            console.log("Roles API FAILED:", e.message);
            return [];
        }

        const rolesXml = String(rolesResp.data);

        console.log("ROLES XML:");
        console.log(rolesXml);

        // =========================
        // STEP 4: EXTRACT ROLE ID
        // =========================
        const roleMatch = rolesXml.match(/\/api\/role\/(\d+)/i);

        if (!roleMatch) {
            console.log(" No role assigned to user");
            return [];
        }

        const roleId = parseInt(roleMatch[1]);
        console.log("ROLE ID:", roleId);

        // =========================
        // STEP 5: FETCH ROLE XML
        // =========================
        const roleUrl = joinUrl(BIGFIX_BASE_URL, `/api/role/${roleId}`);

        let roleResp;
        try {
            roleResp = await axios.get(roleUrl, {
                ...bfAuthOpts,
                timeout: 10000
            });
        } catch (e) {
            console.log(" Role API FAILED:", e.message);
            return [];
        }

        console.log("ROLE XML:");
        console.log(roleResp.data);

        // =========================
        // STEP 6: PARSE SITES
        // =========================
        const parsed = parseRoleXml(String(roleResp.data));

        console.log("PARSED SITES:", parsed.sites);

        const sites = [
            ...new Set(
                parsed.sites.map(s => s.name.toLowerCase().trim())
            )
        ];

        console.log("FINAL SITES:", sites);
        console.log("===== DEBUG END =====");

        // =========================
        // STEP 7: STORE IN DB
        // =========================
        const pool = await getPool();

        await pool.request()
            .input('RoleID', sql.Int, roleId)
            .query(`DELETE FROM dbo.BES_ROLE_SITES WHERE RoleID = @RoleID`);

        for (const site of sites) {

            try {

                await pool.request()
                    .input('RoleID', sql.Int, roleId)
                    .input('SiteName', sql.NVarChar, site)
                    .query(`
                INSERT INTO dbo.BES_ROLE_SITES (RoleID, SiteName)
                VALUES (@RoleID, @SiteName)
            `);

            } catch (e) {

                // ignore duplicate key error only
                if (e.message.includes("uq_role_site")) {
                    console.warn("[RBAC] Duplicate skipped:", site);
                } else {
                    throw e; // rethrow real errors
                }

            }

        }

        roleCache.set(username, {
            sites,
            expiry: Date.now() + (10 * 60 * 1000) // 10 min
        });

        return sites;

    } catch (e) {
        console.error("getAllowedSites ERROR:", e.message);
        return [];
    }
}

module.exports = { getAllowedSites };