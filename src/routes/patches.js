const express = require("express");
const { getPatches } = require("../services/prism");
const { getCache, setCache } = require("../services/prismCache");

const router = express.Router();

router.get("/", async (req, res) => {
  try {

    const cacheKey = "patches";

    // ----------------------------
    // Check cache first
    // ----------------------------
    const cached = getCache(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    // ----------------------------
    // Fetch patches from PRISM
    // ----------------------------
    const patches = await getPatches();

    // ----------------------------
    // Store in cache
    // ----------------------------
    setCache(cacheKey, patches);

    res.json(patches);

  } catch (err) {

    console.error("Patch fetch failed:", err.message);

    res.status(500).json({
      error: "Failed to fetch patches"
    });

  }
});

module.exports = router;