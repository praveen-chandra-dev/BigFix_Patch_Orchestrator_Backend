const express = require("express");
const { prismRequest } = require("../services/prism");
const { getCtx } = require("../env");
const { getCache, setCache } = require("../services/prismCache");

const router = express.Router();

/* =========================================
   FETCH CVEs FOR A SINGLE PATCH
========================================= */

async function fetchCvesForPatch(patch, prismUrl) {

  const cacheKey = `patch:${patch.patch_id}:${patch.site_name}`;

  const cached = getCache(cacheKey);

  if (cached) {
    return cached;
  }

  let page = 1;
  let totalPages = 1;
  let results = [];

  while (page <= totalPages) {

    const response = await prismRequest({
      method: "POST",
      url: `${prismUrl}/api/v1/patches/cves`,
      data: { patches: [patch] },
      params: { page, limit: 100 },
    });

    const data = response.data.data;
    const pagination = response.data.pagination;

    data.forEach((cve) => {
      results.push({
        ...cve,
        patch_id: patch.patch_id,
        site_name: patch.site_name,
      });
    });

    totalPages = pagination.total_pages;
    page++;

  }

  /* store in cache */

  setCache(cacheKey, results);

  return results;

}

/* =========================================
   RUN TASKS WITH LIMITED CONCURRENCY
========================================= */

async function runWithConcurrency(tasks, limit = 10) {

  const results = [];
  let index = 0;

  async function worker() {

    while (true) {

      const current = index++;

      if (current >= tasks.length) break;

      const res = await tasks[current]();

      results.push(...res);

    }

  }

  const workers = [];

  for (let i = 0; i < limit; i++) {
    workers.push(worker());
  }

  await Promise.all(workers);

  return results;

}

/* =========================================
   PATCH → CVE LOOKUP ROUTE
========================================= */

router.post("/by-patches", async (req, res) => {

  try {

    const { patches } = req.body;

    if (!patches || !Array.isArray(patches) || patches.length === 0) {
      return res.status(400).json({ error: "No patches provided" });
    }

    const ctx = getCtx();
    const prismUrl = ctx.prism.PRISM_BASE_URL;

    /* create tasks */

    const tasks = patches.map((patch) => {
      return () => fetchCvesForPatch(patch, prismUrl);
    });

    const allCves = await runWithConcurrency(tasks, 5);

    return res.json({
      data: allCves,
      pagination: {
        total_records: allCves.length,
        total_pages: 1,
        page: 1,
        limit: allCves.length,
      },
    });

  } catch (err) {

    console.error(
      "Patch → CVE lookup failed:",
      err.response?.data || err.message
    );

    return res.status(500).json({
      error: "Failed to fetch CVEs",
      details: err.response?.data || err.message,
    });

  }

});

module.exports = router;