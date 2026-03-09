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
       CVE CACHE
    ========================= */

    let allCves = [];

    for (const patch of patches) {

      let page = 1;
      let totalPages = 1;

      while (page <= totalPages) {

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

          allCves.push({
            ...cve,
            patch_id: patch.patch_id,
            site_name: patch.site_name
          });

        });

        totalPages = pagination.total_pages;
        page++;

      }

    }

    setCache("patch_cves", allCves);

    console.log(`[CacheWarmup] Cached ${allCves.length} CVE records`);

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