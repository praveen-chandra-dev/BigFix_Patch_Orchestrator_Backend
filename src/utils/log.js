// src/utils/log.js
let _rid = 0;
function rid() { _rid = (_rid + 1) % 1000000; return _rid.toString().padStart(6, "0"); }
function stamp(start) { const ms = Date.now() - start; return `(+${ms}ms)`; }

function logFactory(DEBUG_LOG) {
  return function log(req, ...args) {
    if (String(DEBUG_LOG).toLowerCase() !== "1") return;
    if (!req._logStart) req._logStart = Date.now();
    if (!req._rid) req._rid = rid();
    console.log(`[${req._rid}] ${stamp(req._logStart)}`, ...args);
  };
}

module.exports = { logFactory };
