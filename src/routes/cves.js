const express = require("express");
const { prismRequest } = require("../services/prism");

const router = express.Router();

router.post("/by-patches", async (req, res) => {
  try {
    const { patches } = req.body;
    if (!patches || !Array.isArray(patches) || patches.length === 0) {
      return res.status(400).json({ error: "No patches provided" });
    }

    let allCves = [];
    for (const patch of patches) {
      let page = 1;
      let totalPages = 1;

      while (page <= totalPages) {
        const response = await prismRequest({
          method: "POST",
          url: `${process.env.PRISM_BASE_URL}/api/v1/patches/cves`,
          data: { patches: [patch] }, 
          params: { page, limit: 100 },
        });

        const data = response.data.data;
        const pagination = response.data.pagination;

        data.forEach((cve) => {
          allCves.push({
            ...cve,
            patch_id: patch.patch_id,
            site_name: patch.site_name,
          });
        });
        totalPages = pagination.total_pages;
        page++;
      }
    }

    return res.json({
      data: allCves,
      pagination: { total_records: allCves.length, total_pages: 1, page: 1, limit: allCves.length },
    });
  } catch (err) {
    console.error("Patch → CVE lookup failed:", err.response?.data || err.message);
    return res.status(500).json({ error: "Failed to fetch CVEs", details: err.response?.data || err.message });
  }
});

module.exports = router;