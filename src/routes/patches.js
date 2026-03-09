const express = require("express");
const { getPatches } = require("../services/prism");
const { getCache, setCache } = require("../services/prismCache");

const router = express.Router();

const CACHE_KEY = "patches";

router.get("/", async (req, res) => {

  try {

    /* =========================
       CHECK CACHE
    ========================= */

    const cached = getCache(CACHE_KEY);

    if (cached) {
      return res.json(cached);
    }

    /* =========================
       FETCH FROM PRISM
    ========================= */

    console.log("[PATCHES] Cache miss → fetching from Prism");

    const patches = await getPatches();

    /* =========================
       STORE CACHE
    ========================= */

    if (Array.isArray(patches) && patches.length > 0) {
      setCache(CACHE_KEY, patches);
    }

    res.json(patches);

  } catch (err) {

    console.error("[PATCHES] Fetch failed:", err.message);

    res.status(500).json({
      error: "Failed to fetch patches"
    });

  }

});

module.exports = router;