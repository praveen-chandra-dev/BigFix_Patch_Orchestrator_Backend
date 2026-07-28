const cache = new Map();
const locks = new Map();

/* =========================================
   CONFIG
========================================= */

const DEFAULT_TTL = 6 * 60 * 60 * 1000; // 6 hours
const MAX_CACHE_SIZE = 200;             // prevent memory growth

/* =========================================
   Retrieve cached value if still valid
========================================= */

function getCache(key) {

  const entry = cache.get(key);

  if (!entry) return null;

  if (Date.now() > entry.expiry) {
    cache.delete(key);
    return null;
  }

  return entry.value;

}

/* =========================================
   Store value with TTL
========================================= */

function setCache(key, value, ttlMs = DEFAULT_TTL) {

  if (!value || (Array.isArray(value) && value.length === 0)) {
    return;
  }
  /* Prevent unlimited cache growth */
  if (cache.size >= MAX_CACHE_SIZE) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }

  cache.set(key, {
    value,
    expiry: Date.now() + ttlMs
  });

}


function updatePatchesInCache(patchesToUpdate) {
  const key = "patches";
  const entry = cache.get(key);

  if (!entry || !Array.isArray(entry.value)) return;

  const updateMap = new Map(
    patchesToUpdate.map(p => [
      `${p.patch_id}|${p.site_name.toLowerCase().trim()}`,
      p
    ])
  );

  const updated = entry.value.map((p) => {
    const match = updateMap.get(
      `${p.patch_id}|${String(p.site_name).toLowerCase().trim()}`
    );

    if (match) {
      return { ...p, status: match.status };
    }

    return p;
  });

  cache.set(key, {
    value: updated,
    expiry: entry.expiry,
  });
}


async function withCacheLock(key, fn) {
  if (locks.has(key)) {
    return locks.get(key);
  }

  const promise = fn().finally(() => {
    locks.delete(key);
  });

  locks.set(key, promise);

  return promise;
}


/* =========================================
   Clear entire cache
========================================= */

function clearCache() {
  cache.clear();
}

module.exports = {
  getCache,
  setCache,
  updatePatchesInCache,
  withCacheLock,
  clearCache
};