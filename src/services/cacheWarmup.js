// src/services/cacheWarmup.js

const { getPatches, prismRequest } = require("./prism");
const { setCache } = require("./prismCache");
const { getCtx } = require("../env");

function normalizeSeverity(severity) {
  const value = String(severity || "")
    .toUpperCase()
    .trim();

  if (
    !value ||
    value === "NONE" ||
    value === "UNKNOWN"
  ) {
    return "UNKNOWN";
  }

  return value;
}

async function warmCache() {
  try {
    console.log(
      "[CacheWarmup] Starting cache warmup...",
    );

    const ctx = getCtx();

    const prismUrl =
      ctx.prism.PRISM_BASE_URL;

    // =================================================
    // PATCH CACHE
    // =================================================

    const patches = await getPatches();

    setCache("patches", patches);

    console.log(
      `[CacheWarmup] Cached ${patches.length} patches`,
    );

    // =================================================
    // CVE CACHE
    // =================================================

    console.log(
      "[CacheWarmup] Fetching patch↔CVE mappings...",
    );

    const PATCH_BATCH_SIZE = 100;

    const allCves = [];

    // =================================================
    // PRESERVE RAW PATCH -> CVE MAP
    // =================================================

    const patchCveMap = {};

    for (
      let i = 0;
      i < patches.length;
      i += PATCH_BATCH_SIZE
    ) {
      const chunk = patches.slice(
        i,
        i + PATCH_BATCH_SIZE,
      );

      try {
        const response =
          await prismRequest({
            method: "POST",

            url: `${prismUrl}/api/v1/patches/cves`,

            data: {
              patches: chunk.map(
                (patch) => ({
                  patch_id:
                    patch.patch_id,

                  site_name:
                    patch.site_name,
                }),
              ),
            },

            params: {
              page: 1,
              limit: 100000,
            },
          });

        const grouped =
          response.data?.data || {};

        // =============================================
        // PRESERVE GROUPED STRUCTURE
        // =============================================

        for (const key of Object.keys(
          grouped,
        )) {
          const cves = Array.isArray(
            grouped[key],
          )
            ? grouped[key]
            : [];

          patchCveMap[key] = cves.map(
            (cve) => ({
              ...cve,

              cvss_severity:
                normalizeSeverity(
                  cve.cvss_severity,
                ),
            }),
          );

          allCves.push(
            ...patchCveMap[key],
          );
        }

        console.log(
          `[CacheWarmup] Processed ${Math.min(
            i + PATCH_BATCH_SIZE,
            patches.length,
          )} / ${patches.length} patches`,
        );
      } catch (err) {
        console.error(
          `[CacheWarmup] Failed batch starting at index ${i}:`,
          err.message,
        );
      }
    }

    // =================================================
    // STORE FLAT RAW LIST
    // =================================================

    setCache(
      "patch_cves",
      allCves,
    );

    // =================================================
    // STORE PATCH -> CVE MAP
    // =================================================

    setCache(
      "patch_cves_map",
      patchCveMap,
    );

    // =================================================
    // BUILD UNIQUE CVE MAP
    // =================================================

    const uniqueCveMap = {};

    // Build patch -> devices map
    const patchDeviceMap = {};

    for (const patch of patches) {
      const patchKey = `${patch.patch_id}|${patch.site_name}`;

      const devices = Array.isArray(
        patch.applicable_computers,
      )
        ? patch.applicable_computers
        : [];

      patchDeviceMap[patchKey] =
        devices.map((d) =>
          String(d).trim(),
        );
    }

    for (const cve of allCves) {
      const cveId = String(
        cve.cve_id || "",
      ).trim();

      if (!cveId) continue;

      const patchKey = `${cve.patch_id}|${cve.site_name}`;

      if (!uniqueCveMap[cveId]) {
        uniqueCveMap[cveId] = {
          cve_id: cveId,

          cvss_severity:
            normalizeSeverity(
              cve.cvss_severity,
            ),

          severity:
            normalizeSeverity(
              cve.cvss_severity,
            ),

          kev: cve.is_kev
            ? "YES"
            : "NO",

          is_kev: !!cve.is_kev,

          patches: new Set(),

          patchObjects: [],

          devices: new Set(),
        };
      }

      // =============================================
      // PATCH PRESERVATION
      // =============================================

      if (
        !uniqueCveMap[
          cveId
        ].patches.has(patchKey)
      ) {
        uniqueCveMap[
          cveId
        ].patches.add(patchKey);

        uniqueCveMap[
          cveId
        ].patchObjects.push({
          patch_id: cve.patch_id,

          site_name:
            cve.site_name,
        });
      }

      // =============================================
      // DEVICE PRESERVATION
      // =============================================

      const devices =
        patchDeviceMap[patchKey] ||
        [];

      devices.forEach((device) => {
        uniqueCveMap[
          cveId
        ].devices.add(
          String(device).trim(),
        );
      });
    }

    // =================================================
    // FINAL UNIQUE CVE ARRAY
    // =================================================

    const uniqueCves = Object.values(
      uniqueCveMap,
    ).map((cve) => ({
      ...cve,

      patches: Array.from(
        cve.patches,
      ),

      devices: Array.from(
        cve.devices,
      ),

      patch_count:
        cve.patches.size,

      device_count:
        cve.devices.size,
    }));

    setCache(
      "unique_cves",
      uniqueCves,
    );

    console.log(
      `[CacheWarmup] Cached ${allCves.length} CVE mappings`,
    );

    console.log(
      `[CacheWarmup] Cached ${uniqueCves.length} unique CVEs`,
    );

    console.log(
      `[CacheWarmup] Built CVE map for ${Object.keys(patchCveMap).length} patches`,
    );

    console.log(
      "[CacheWarmup] Cache warmup completed successfully",
    );
  } catch (err) {
    console.error(
      "[CacheWarmup] Failed:",
      err.message,
    );
  }
}

async function ensureCveCache() {

  const {
    getCache,
    withCacheLock,
  } = require("./prismCache");

  const existing =
    getCache("patch_cves");

  if (
    existing &&
    Array.isArray(existing) &&
    existing.length > 0
  ) {
    return;
  }

  await withCacheLock(
    "cache_warmup_rebuild",

    async () => {

      const recheck =
        getCache("patch_cves");

      if (
        recheck &&
        Array.isArray(recheck) &&
        recheck.length > 0
      ) {
        return;
      }

      console.log(
        "[CacheWarmup] CVE cache miss detected — rebuilding cache",
      );

      await warmCache();
    },
  );
}


module.exports = {
  warmCache,
  ensureCveCache,
};