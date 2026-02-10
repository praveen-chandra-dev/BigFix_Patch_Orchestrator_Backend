const actionStore = {
  lastActionId: null,
  actions: Object.create(null),
};

const CONFIG = {
  diskThresholdGB: 10,
  requireChg: true,
  autoMail: false,
  postPatchMail: false,
  locked: false,
  lastReportValue: 10,
  lastReportUnit: "days",
  checkServiceStatus: false,
  // New flags
  snapshotVM: false, 
  cloneVM: false
};

module.exports = { actionStore, CONFIG };