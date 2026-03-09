const { getPatches } = require("./prism");
const { setCache } = require("./prismCache");
const { getCtx } = require("../env");

async function warmCache() {

  try {

    console.log("[CacheWarmup] Starting cache warmup...");

    const ctx = getCtx();
    const prismUrl = ctx.prism.PRISM_BASE_URL;

    // ----------------------------
    // Warm PATCH CACHE
    // ----------------------------

    const patches = await getPatches();

    setCache("patches", patches);

    console.log(`[CacheWarmup] Cached ${patches.length} patches`);

    // ----------------------------
    // Optional: warm CVE cache later
    // (we skip it for now to avoid heavy startup)
    // ----------------------------

  } catch (err) {

    console.error("[CacheWarmup] Failed:", err.message);

  }

}

module.exports = { warmCache };