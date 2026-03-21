// src/routes/cves.js
const express = require("express");
const { getCache } = require("../services/prismCache");
const { getAllowedSites } = require("../services/roleService");
const { isMasterOperator, getRoleAssets } = require("../services/bigfix");
const { getCtx } = require("../env");

const router = express.Router();

const nmoComputerCache = new Map();

function getSessionUser(req) {
    if (req && req.cookies && req.cookies.auth_session) {
        try { return JSON.parse(req.cookies.auth_session).username; } catch(e){}
    }
    return req.headers['x-active-user'] || "unknown";
}

function getSessionRole(req) {
    if (req && req.cookies && req.cookies.auth_session) {
        try { return JSON.parse(req.cookies.auth_session).role; } catch(e){}
    }
    return null;
}

/* =========================================
   PATCH → CVE LOOKUP FROM CACHE (WITH RBAC & DEDUPLICATION)
========================================= */

router.get("/", async (req, res) => {
  try {
    const cachedCves = getCache("patch_cves");
    const cachedPatches = getCache("patches");

    if (!cachedCves || !cachedPatches) {
      return res.status(503).json({ error: "CVE cache not ready" });
    }

    const activeUser = getSessionUser(req);
    const activeRole = req.headers['x-user-role'] || getSessionRole(req);
    const ctx = req.app.locals.ctx || getCtx();
    const isMO = await isMasterOperator(req, ctx, activeUser);

    // 1. Identify which patches the user is actually allowed to see
    let validPatchKeys = new Set();
    let validPatchIds = new Set();

    if (isMO) {
        cachedPatches.forEach(p => {
            if (p.applicable_computers && p.applicable_computers.length > 0) {
                validPatchKeys.add(`${p.patch_id}|${String(p.site_name).toLowerCase().trim()}`);
                validPatchIds.add(String(p.patch_id));
            }
        });
    } else {
        // Apply RBAC Filtering for Non-Master Operators
        const allowedSites = await getAllowedSites(req, ctx);
        let allowedSet = null;
        if (!allowedSites.includes("__ALL__")) {
            allowedSet = new Set(allowedSites.map(s => s.toLowerCase().trim()));
        }

        const cacheKey = `${activeUser}_${activeRole}_comps`;
        let allowedComps = [];
        const cachedComps = nmoComputerCache.get(cacheKey);

        if (cachedComps && Date.now() < cachedComps.expiry) {
            allowedComps = cachedComps.comps;
        } else {
            const roleAssets = await getRoleAssets(req, ctx, activeRole);
            if (roleAssets.found) {
                allowedComps = roleAssets.compNames.map(c => String(c).toLowerCase().trim());
            }
            nmoComputerCache.set(cacheKey, { comps: allowedComps, expiry: Date.now() + 5 * 60 * 1000 });
        }

        const compSet = new Set(allowedComps);

        cachedPatches.forEach(p => {
            const site = String(p.site_name || "").toLowerCase().trim();
            if (allowedSet && !allowedSet.has(site)) return;

            const filteredComps = (p.applicable_computers || []).filter(c => compSet.has(String(c).toLowerCase().trim()));
            if (filteredComps.length > 0) {
                validPatchKeys.add(`${p.patch_id}|${site}`);
                validPatchIds.add(String(p.patch_id));
            }
        });
    }

    // 2. Filter the cached CVEs based on authorized patches
    // Fallback: If site name parsing fails, match by ID alone
    const filteredCves = cachedCves.filter(cve => {
        const site = String(cve.site_name || "").toLowerCase().trim();
        const key = `${cve.patch_id}|${site}`;
        return validPatchKeys.has(key) || validPatchIds.has(String(cve.patch_id));
    });

    // 3. Deduplicate the CVEs so the table matches the overview card
    const uniqueCvesMap = new Map();
    for (const cve of filteredCves) {
         if (cve.cve_id && !uniqueCvesMap.has(cve.cve_id)) {
             uniqueCvesMap.set(cve.cve_id, cve);
         }
    }
    const uniqueCves = Array.from(uniqueCvesMap.values());

    // REQUIRED: Structured layout for DataGrids
    res.json({
      data: uniqueCves,
      pagination: {
          total_records: uniqueCves.length,
          total_pages: 1,
          page: 1,
          limit: uniqueCves.length || 100
      }
    });

  } catch (err) {
    console.error("CVE fetch failed:", err.message);
    res.status(500).json({ error: "Failed to fetch CVEs" });
  }
});

router.post("/by-patches", async (req, res) => {
  try {
    const { patches } = req.body;

    if (!patches || !Array.isArray(patches) || patches.length === 0) {
      return res.status(400).json({ error: "No patches provided" });
    }

    const cachedCves = getCache("patch_cves");

    if (!cachedCves) {
      return res.status(503).json({ error: "CVE cache not ready" });
    }

    // Safe case-insensitive lookup
    const requestPatchKeys = new Set(patches.map(p => `${p.patch_id}|${String(p.site_name).toLowerCase().trim()}`));
    const requestPatchIdsOnly = new Set(patches.map(p => String(p.patch_id)));

    const matchedCves = cachedCves.filter(cve => {
         const key = `${cve.patch_id}|${String(cve.site_name).toLowerCase().trim()}`;
         if (requestPatchKeys.has(key)) return true;
         // FALLBACK: Prevent empty CVEs if Site Name formatting misaligned 
         if (requestPatchIdsOnly.has(String(cve.patch_id))) return true;
         return false;
    });

    // Deduplicate the results
    const uniqueMap = new Map();
    for (const cve of matchedCves) {
        if (cve.cve_id && !uniqueMap.has(cve.cve_id)) {
            uniqueMap.set(cve.cve_id, cve);
        }
    }
    const uniqueResult = Array.from(uniqueMap.values());

    return res.json({
      data: uniqueResult,
      pagination: {
        total_records: uniqueResult.length,
        total_pages: 1,
        page: 1,
        limit: uniqueResult.length || 100
      }
    });

  } catch (err) {
    console.error("Patch → CVE lookup failed:", err.message);
    return res.status(500).json({ error: "Failed to fetch CVEs" });
  }
});

module.exports = router;