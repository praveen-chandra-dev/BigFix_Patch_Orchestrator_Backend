// src/state/store.js
// In-memory stores/config used by multiple routes

const actionStore = {
  lastActionId: null,
  // id -> { id, createdAt, xml, meta?: {...}, postMailSent?: true }
  actions: Object.create(null),
};

const CONFIG = {
  cpuThresholdPct: 85,
  ramThresholdPct: 85,
  diskThresholdGB: 10,
  requireChg: true,
  autoMail: false,        // pre-patch
  postPatchMail: false,   // <-- ADD: enable/disable post-patch watcher mails
  locked: false,

  lastReportValue: 10,
  lastReportUnit: "days",
};

module.exports = { actionStore, CONFIG };
