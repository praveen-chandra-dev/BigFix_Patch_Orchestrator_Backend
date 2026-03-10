// const express = require("express");
// const { prismRequest } = require("../services/prism");
// const { getCtx } = require("../env");
// const { getCache, setCache } = require("../services/prismCache");

// const router = express.Router();

// /* =========================================
//    PATCH → CVE WITH CACHE
// ========================================= */

// router.post("/by-patches", async (req, res) => {

//   try {

//     const { patches } = req.body;

//     if (!patches || !Array.isArray(patches) || patches.length === 0) {
//       return res.status(400).json({ error: "No patches provided" });
//     }

//     const ctx = getCtx();
//     const prismUrl = ctx.prism.PRISM_BASE_URL;

//     let allCves = [];

//     for (const patch of patches) {

//       const cacheKey = `cves_${patch.patch_id}_${patch.site_name}`;

//       /* =========================
//          CHECK CACHE
//       ========================= */

//       const cached = getCache(cacheKey);

//       if (cached) {
//         allCves.push(...cached);
//         continue;
//       }

//       /* =========================
//          FETCH FROM PRISM
//       ========================= */

//       let page = 1;
//       let totalPages = 1;
//       let patchCves = [];

//       while (page <= totalPages) {

//         const response = await prismRequest({
//           method: "POST",
//           url: `${prismUrl}/api/v1/patches/cves`,
//           data: {
//             patches: [{
//               patch_id: patch.patch_id,
//               site_name: patch.site_name
//             }]
//           },
//           params: {
//             page,
//             limit: 100
//           }
//         });

//         const data = response.data.data;
//         const pagination = response.data.pagination;

//         data.forEach((cve) => {
//           patchCves.push({
//             ...cve,
//             patch_id: patch.patch_id,
//             site_name: patch.site_name
//           });
//         });

//         totalPages = pagination.total_pages;
//         page++;

//       }

//       /* =========================
//          STORE CACHE
//       ========================= */

//       if (patchCves.length > 0) {
//         setCache(cacheKey, patchCves);
//       }

//       allCves.push(...patchCves);

//     }

//     return res.json({
//       data: allCves,
//       pagination: {
//         total_records: allCves.length,
//         total_pages: 1,
//         page: 1,
//         limit: allCves.length
//       }
//     });

//   } catch (err) {

//     console.error(
//       "Patch → CVE lookup failed:",
//       err.response?.data || err.message
//     );

//     return res.status(500).json({
//       error: "Failed to fetch CVEs",
//       details: err.response?.data || err.message
//     });

//   }

// });

// module.exports = router;


const express = require("express");
const { getCache } = require("../services/prismCache");

const router = express.Router();

/* =========================================
   PATCH → CVE LOOKUP FROM CACHE
========================================= */

router.get("/", (req, res) => {

  try {

    const cached = getCache("patch_cves");

    if (!cached) {
      return res.status(503).json({
        error: "CVE cache not ready"
      });
    }

    res.json({
      data: cached,
      total: cached.length
    });

  } catch (err) {

    console.error("CVE fetch failed:", err.message);

    res.status(500).json({
      error: "Failed to fetch CVEs"
    });

  }

});

router.post("/by-patches", async (req, res) => {

  try {

    const { patches } = req.body;

    if (!patches || !Array.isArray(patches) || patches.length === 0) {
      return res.status(400).json({ error: "No patches provided" });
    }

    /* =========================
       LOAD GLOBAL CVE CACHE
    ========================= */

    const cveMap = getCache("patch_cves_map");

    if (!cveMap) {
      return res.status(503).json({
        error: "CVE cache not ready"
      });
    }

    let allCves = [];

    /* =========================
       LOOKUP CVES BY PATCH
    ========================= */

    for (const patch of patches) {

      const key = `${patch.patch_id}|${patch.site_name}`;

      const patchCves = cveMap[key];

      if (patchCves) {
        allCves.push(...patchCves);
      }

    }

    return res.json({
      data: allCves,
      pagination: {
        total_records: allCves.length,
        total_pages: 1,
        page: 1,
        limit: allCves.length
      }
    });

  } catch (err) {

    console.error("Patch → CVE lookup failed:", err.message);

    return res.status(500).json({
      error: "Failed to fetch CVEs"
    });

  }

});

module.exports = router;