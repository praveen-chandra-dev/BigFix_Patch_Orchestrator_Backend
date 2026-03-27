// src/services/cacheWarmup.js
const { getPatches, prismRequest } = require("./prism");
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

    /* =========================
       CVE CACHE (OPTIMIZED & PARALLELIZED)
    ========================= */
    let allCves = [];
    
    // Process 25 patches at the exact same time instead of 1 by 1
    const CONCURRENCY_LIMIT = 25; 

    for (let i = 0; i < patches.length; i += CONCURRENCY_LIMIT) {
      const chunk = patches.slice(i, i + CONCURRENCY_LIMIT);

      // Create an array of simultaneous API requests
      const promises = chunk.map(async (patch) => {
        let page = 1;
        let totalPages = 1;
        let localCves = [];

        while (page <= totalPages) {
          try {
            const response = await prismRequest({
              method: "POST",
              url: `${prismUrl}/api/v1/patches/cves`,
              data: {
                patches: [{
                  patch_id: patch.patch_id,
                  site_name: patch.site_name
                }]
              },
              params: {
                page,
                limit: 100
              }
            });

            const data = response.data.data;
            const pagination = response.data.pagination;

            data.forEach(cve => {
              localCves.push({
                ...cve,
                patch_id: patch.patch_id,
                site_name: patch.site_name
              });
            });

            totalPages = pagination.total_pages;
            page++;
          } catch (err) {
            console.error(`[CacheWarmup] CVE fetch failed for patch ${patch.patch_id}:`, err.message);
            break; // Stop paginating this patch on error
          }
        }
        return localCves;
      });

      // Wait for the 25 concurrent requests to finish before grabbing the next 25
      const chunkResults = await Promise.all(promises);
      
      // Combine results
      chunkResults.forEach(res => {
          allCves.push(...res);
      });

      // Log progress every 500 patches so you know it hasn't frozen
      if ((i + CONCURRENCY_LIMIT) % 500 === 0 || (i + CONCURRENCY_LIMIT) >= patches.length) {
          console.log(`[CacheWarmup] Processed CVEs for ${Math.min(i + CONCURRENCY_LIMIT, patches.length)} / ${patches.length} patches...`);
      }
    }

    setCache("patch_cves", allCves);
    console.log(`[CacheWarmup] Cached ${allCves.length} CVE records successfully.`);

    const cveMap = {};
    allCves.forEach((cve) => {
      const key = `${cve.patch_id}|${cve.site_name}`;
      if (!cveMap[key]) {
        cveMap[key] = [];
      }
      cveMap[key].push(cve);
    });

    setCache("patch_cves_map", cveMap);

  } catch (err) {
    console.error("[CacheWarmup] Failed:", err.message);
  }
}

module.exports = { warmCache };