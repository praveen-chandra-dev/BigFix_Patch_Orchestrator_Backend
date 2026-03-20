const express = require("express");
const { getPatches, prismRequest } = require("../services/prism");
const { getCache, setCache } = require("../services/prismCache");
const { withCacheLock } = require("../services/prismCache");
const { getAllowedSites } = require("../services/roleService");

const router = express.Router();
const { getCtx } = require("../env");
const CACHE_KEY = "patches";

/* =====================================================
   GET PATCHES (unchanged)
===================================================== */
router.get("/", async (req, res) => {
  try {
    let patches = getCache(CACHE_KEY);

    /* =========================
       CACHE MISS → LOCKED FETCH
    ========================= */
    if (!patches) {
      console.log("[PATCHES] Cache miss → fetching from Prism");

      patches = await withCacheLock("patches_fetch", async () => {
        const fresh = await getPatches();

        if (Array.isArray(fresh) && fresh.length > 0) {
          setCache(CACHE_KEY, fresh);
        }

        return fresh;
      });
    }

    patches = Array.isArray(patches) ? patches : [];

    /* =========================
       RBAC FILTER
    ========================= */
    try {
      const allowedSites = await getAllowedSites(req, req.app.locals.ctx);

      //  MASTER → no filtering
      if (!allowedSites.includes("__ALL__")) {
        const allowedSet = new Set(
          allowedSites.map(s => s.toLowerCase().trim())
        );

        patches = patches.filter(p => {
          const site = String(p.site_name || "").toLowerCase().trim();
          return allowedSet.has(site);
        });
      }

    } catch (e) {
      console.warn("[RBAC] Patch filtering failed:", e.message);
    }

    res.json(patches);

  } catch (err) {
    console.error("[PATCHES] Fetch failed:", err.message);

    res.status(500).json({
      error: "Failed to fetch patches"
    });
  }
});


/* =====================================================
   UPDATE CACHE (PATCH-LEVEL, NOT FULL CLEAR)
===================================================== */
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
      return {
        ...p,
        status: match.status,
      };
    }

    return p;
  });

  setCache(CACHE_KEY, updated);
}


/* =====================================================
   APPROVE / UNAPPROVE PATCHES
===================================================== */
router.post("/approve", async (req, res) => {
  try {

    const allowedSites = await getAllowedSites(req, req.app.locals.ctx);

    if (!allowedSites.includes("__ALL__")) {
      return res.status(403).json({
        error: "Only Master Operator can approve/unapprove patches"
      });
    }
    
    const { patches, approve } = req.body;

    if (!patches || patches.length === 0) {
      return res.status(400).json({
        error: "No patches provided"
      });
    }

    if (!Array.isArray(patches)) {
      return res.status(400).json({
        error: "Invalid patches format"
      });
    }

    /* =========================
       CALL PYTHON API
    ========================= */
    const ctx = getCtx();
    console.log(
      "Calling Prism:",
      `${ctx.prism.PRISM_BASE_URL}/api/v1/patches/approve`
    );
    console.log("Payload:", { patches, approve });

    await prismRequest({
      method: "POST",
      url: `${ctx.prism.PRISM_BASE_URL}/api/v1/patches/approve`,
      data: {
        patches,
        approve,
      },
    });

    /* =========================
       UPDATE CACHE (NO CLEAR)
    ========================= */
    updatePatchesInCache(
      patches.map((p) => ({
        patch_id: p.patch_id,
        site_name: p.site_name,
        status: approve ? 1 : 0,
      }))
    );

    res.json({
      message: "Patch approval updated",
      updated_count: patches.length,
    });

  } catch (err) {
    console.error("[PATCHES] Approval failed:", err.message);

    res.status(500).json({
      error: "Approval failed"
    });
  }
});

module.exports = router;