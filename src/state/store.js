// src/state/store.js
// In-memory stores/config used by multiple routes

const actionStore = {
  lastActionId: null,
  actions: Object.create(null), // id -> { id, createdAt, xml }
};

// CONFIG used by /api/health/critical and /api/config
const CONFIG = {
  cpuThresholdPct: 85,
  ramThresholdPct: 85,
  diskThresholdGB: 10,
  requireChg: true,
  locked: false,
};

module.exports = { actionStore, CONFIG };
