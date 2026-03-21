// src/routes/patches.js
const express = require("express");
const axios = require("axios");
const { getPatches, prismRequest } = require("../services/prism");
const { getCache, setCache, withCacheLock } = require("../services/prismCache");
const { getAllowedSites } = require("../services/roleService");
const { isMasterOperator, getRoleAssets } = require("../services/bigfix"); 
const { getBfAuthContext, joinUrl } = require("../utils/http"); 
const { getCtx } = require("../env");

const router = express.Router();
const CACHE_KEY = "patches";

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

router.get("/", async (req, res) => {
  try {
    let patches = getCache(CACHE_KEY);

    if (!patches) {
      console.log("[PATCHES] Cache miss → fetching from Prism");
      patches = await withCacheLock("patches_fetch", async () => {
        const fresh = await getPatches();
        if (Array.isArray(fresh) && fresh.length > 0) setCache(CACHE_KEY, fresh);
        return fresh;
      });
    }

    patches = Array.isArray(patches) ? patches : [];

    try {
      const activeUser = getSessionUser(req);
      const activeRole = req.headers['x-user-role'] || getSessionRole(req);
      const ctx = req.app.locals.ctx || getCtx();
      const isMO = await isMasterOperator(req, ctx, activeUser);

      if (!isMO) {
        // 1. Filter out Sites the user doesn't have access to
        const allowedSites = await getAllowedSites(req, ctx);
        if (!allowedSites.includes("__ALL__")) {
          const allowedSet = new Set(allowedSites.map(s => s.toLowerCase().trim()));
          patches = patches.filter(p => {
            const site = String(p.site_name || "").toLowerCase().trim();
            return allowedSet.has(site);
          });
        }

        // 2. Filter applicable computers strictly based on the Role assignment
        try {
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
            
            patches = patches.map(p => {
                const filteredComps = (p.applicable_computers || []).filter(c => compSet.has(String(c).toLowerCase().trim()));
                return { 
                  ...p, 
                  applicable_computers: filteredComps,
                  applicable_count: filteredComps.length
                };
            });

            // Remove patches that have 0 applicable computers for this specific role
            patches = patches.filter(p => p.applicable_count > 0);

        } catch(e) {
            console.warn("Failed to natively resolve NMO computers:", e.message);
        }
      }
    } catch (e) {
      console.warn("[RBAC] Patch filtering failed:", e.message);
    }

    // REQUIRED: Standardize output so Frontend DataGrids don't crash
    res.json({
        data: patches,
        pagination: {
            total_records: patches.length,
            total_pages: 1,
            page: 1,
            limit: patches.length || 100
        }
    });

  } catch (err) {
    console.error("[PATCHES] Fetch failed:", err.message);
    res.status(500).json({ error: "Failed to fetch patches" });
  }
});

function updatePatchesInCache(patchesToUpdate) {
  const cached = getCache(CACHE_KEY);
  if (!cached) return;

  const updated = cached.map((p) => {
    const match = patchesToUpdate.find(
      (x) =>
        x.patch_id === p.patch_id &&
        String(x.site_name).toLowerCase().trim() ===
        String(p.site_name).toLowerCase().trim()
    );

    if (match) {
      return { ...p, status: match.status };
    }
    return p;
  });

  setCache(CACHE_KEY, updated);
}

router.post("/approve", async (req, res) => {
  try {
    const allowedSites = await getAllowedSites(req, req.app.locals.ctx);

    if (!allowedSites.includes("__ALL__")) {
      return res.status(403).json({ error: "Only Master Operator can approve/unapprove patches" });
    }
    
    const { patches, approve } = req.body;

    if (!patches || patches.length === 0 || !Array.isArray(patches)) {
      return res.status(400).json({ error: "Invalid patches format" });
    }

    const ctx = getCtx();
    await prismRequest({
      method: "POST",
      url: `${ctx.prism.PRISM_BASE_URL}/api/v1/patches/approve`,
      data: { patches, approve },
    });

    updatePatchesInCache(
      patches.map((p) => ({
        patch_id: p.patch_id,
        site_name: p.site_name,
        status: approve ? 1 : 0,
      }))
    );

    res.json({ message: "Patch approval updated", updated_count: patches.length });
  } catch (err) {
    console.error("[PATCHES] Approval failed:", err.message);
    res.status(500).json({ error: "Approval failed" });
  }
});

module.exports = router;