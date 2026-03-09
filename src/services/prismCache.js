const cache = new Map();

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

/* =========================================
   Clear entire cache
========================================= */

function clearCache() {
  cache.clear();
}

module.exports = {
  getCache,
  setCache,
  clearCache
};