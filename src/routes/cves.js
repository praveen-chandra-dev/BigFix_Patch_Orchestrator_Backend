// src/routes/cves.js
const express = require("express");
const { getCache, setCache } = require("../services/prismCache");
const { prismRequest } = require("../services/prism");
const { ensureCveCache } = require("../services/cacheWarmup");
const { getAllowedSites } = require("../services/roleService");
const { isMasterOperator, getUserVisibleComputers } = require("../services/bigfix");
const { getCtx } = require("../env");
const { getSessionUser, getSessionRole, escapeHtml } = require("../utils/http");

const router = express.Router();

function normalizeSeverity(severity) {
  const value = String(severity || "").toUpperCase().trim();
  if (!value || value === "NONE" || value === "UNKNOWN") return "UNKNOWN";
  return value;
}

function buildPatchKey(patchId, siteName) {
  return `${patchId}|${siteName}`;
}

async function applyCveRbac(req, cves) {
  try {
    const activeUser = getSessionUser(req);
    const ctx = req.app.locals.ctx || getCtx();
    const isMO = await isMasterOperator(req, ctx, activeUser);

    if (isMO) return cves;

    const allowedSites = await getAllowedSites(req, ctx);
    const allowedSiteSet = new Set(allowedSites.map((s) => String(s).toLowerCase().trim()));

    // Same source of truth as the Computer List page: ask BigFix using user creds.
    const visibleComps = await getUserVisibleComputers(req, ctx);
    const visibleCompSet = new Set(visibleComps);

    return cves.filter((cve) => {
      let siteAllowed = allowedSites.includes("__ALL__");

      if (!siteAllowed) {
        const patchObjects = cve.patchObjects || [];
        siteAllowed = patchObjects.some((p) => allowedSiteSet.has(String(p.site_name || "").toLowerCase().trim()));
        if (!siteAllowed && cve.site_name) {
            siteAllowed = allowedSiteSet.has(String(cve.site_name).toLowerCase().trim());
        }
      }

      if (!siteAllowed) return false;

      const devices = cve.devices || [];
      if (devices.length === 0) return false;

      // CVE is visible only if at least one affected device is in the user's BigFix-visible set.
      return devices.some((d) => visibleCompSet.has(String(d).toLowerCase().trim()));
    });
  } catch (err) {
    console.warn("[RBAC] CVE filtering failed:", err.message);
    return cves;
  }
}

router.get("/", async (req, res) => {
  try {
    await ensureCveCache();
    let uniqueCves = getCache("unique_cves") || [];
    uniqueCves = await applyCveRbac(req, uniqueCves);

    res.json({
      data: uniqueCves,
      unique_cves: uniqueCves,
      total_unique_cves: uniqueCves.length,
      pagination: { total_records: uniqueCves.length, total_pages: 1, page: 1, limit: uniqueCves.length || 100 },
    });
  } catch (err) {
    console.error("[CVES] Failed:", err.message);
    res.status(500).json({ error: "Failed to fetch CVEs" });
  }
});

router.post("/by-patches", async (req, res) => {
    try {

      const allowedKeys = ["patches"];
      const incomingKeys = Object.keys(req.body || {});
      const hasExtraKeys = incomingKeys.some(key => !allowedKeys.includes(key));
      
      if (hasExtraKeys) {
          return res.status(400).json({ 
              ok: false, 
              error: "Bad Request: Payload contains unauthorized properties." 
          });
      }
      await ensureCveCache();
      const patches = Array.isArray(req.body?.patches) ? req.body.patches : [];

      if (patches.length === 0) {
        return res.json({ data: [], grouped: {}, unique_cves: [], total_unique_cves: 0, pagination: { total_records: 0, total_pages: 1, page: 1, limit: 0 } });
      }

      const patchCveMap = getCache("patch_cves_map") || {};
      const flat = [];
      const grouped = {};

      for (const patch of patches) {
        //  SAST FIX: Sanitize input parameters before processing
        const safePatchId = escapeHtml(patch.patch_id);
        const safeSiteName = escapeHtml(patch.site_name);

        const key = buildPatchKey(safePatchId, safeSiteName);
        const cves = patchCveMap[key] || [];
        grouped[key] = cves;
        flat.push(...cves);
      }

      const patchCache = getCache("patches") || [];
      const patchDeviceMap = {};

      patchCache.forEach((patch) => {
        const key = buildPatchKey(patch.patch_id, patch.site_name);
        let applicableComputers = [];

        if (Array.isArray(patch.applicable_computers)) {
          applicableComputers = patch.applicable_computers;
        } else if (typeof patch.applicable_computers === "string") {
          try { applicableComputers = JSON.parse(patch.applicable_computers); } catch (e) { applicableComputers = []; }
        }
        patchDeviceMap[key] = applicableComputers.map((d) => String(d).trim());
      });

      const uniqueMap = {};

      for (const cve of flat) {
        const cveId = String(cve.cve_id || "").trim();
        if (!cveId) continue;

        const patchKey = buildPatchKey(cve.patch_id, cve.site_name);

        if (!uniqueMap[cveId]) {
          uniqueMap[cveId] = {
            cve_id: cveId,
            cvss_severity: normalizeSeverity(cve.cvss_severity),
            severity: normalizeSeverity(cve.cvss_severity),
            kev: cve.is_kev ? "YES" : "NO",
            is_kev: !!cve.is_kev,
            patches: new Set(),
            patchObjects: [],
            devices: new Set(),
          };
        }

        if (!uniqueMap[cveId].patches.has(patchKey)) {
          uniqueMap[cveId].patches.add(patchKey);
          uniqueMap[cveId].patchObjects.push({ patch_id: cve.patch_id, site_name: cve.site_name });
        }

        const devices = patchDeviceMap[patchKey] || [];
        devices.forEach((device) => { uniqueMap[cveId].devices.add(String(device).trim()); });
      }

      let uniqueCves = Object.values(uniqueMap).map((cve) => ({
        ...cve,
        patches: Array.from(cve.patches),
        devices: Array.from(cve.devices),
        patch_count: cve.patches.size,
        device_count: cve.devices.size,
      }));

      uniqueCves = await applyCveRbac(req, uniqueCves);

      res.json({
        data: flat,
        grouped,
        unique_cves: uniqueCves,
        total_unique_cves: uniqueCves.length,
        pagination: { total_records: flat.length, total_pages: 1, page: 1, limit: flat.length || 100 },
      });
    } catch (err) {
      console.error("[CVES/BY-PATCHES] Failed:", err.message);
      res.status(500).json({ error: "Failed to fetch CVEs " });
    }
});

module.exports = router;