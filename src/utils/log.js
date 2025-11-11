// backend/src/utils/log.js
const { createRequestLogger, getLogLevel } = require('../services/logger');

// Helpers to mimic the old logger's [reqId] (+ms) format
function stamp(start) { const ms = Date.now() - start; return `(+${ms}ms)`; }

/**
 * Creates a logging function that respects the .env log level
 * and automatically includes a request ID.
 * All logs from this factory are routed to the 'debug' level.
 */
function logFactory(DEBUG_LOG_LEGACY) {
  
  /**
   * @param {object} req - The Express request object.
   * @param {...any} args - The log message and optional metadata.
   */
  return function log(req, ...args) {
    // 1. Get or create the child logger for this request
    if (!req.logger) {
      req.logger = createRequestLogger(req);
    }

    // 2. Format the message
    const startTime = req._logStart || Date.now();
    const message = `${stamp(startTime)} ${args[0]}`;
    const meta = args.length > 1 ? args.slice(1) : {};

    // 3. Log at 'debug' level.
    // This means it will *only* show in the console if DEBUG_LOG=1,
    // but will *always* show in the file (which is set to level 'debug').
    // This matches the behavior you wanted.
    req.logger.debug(message, meta);
  };
}

// --- NEW ---
// Create a separate "info" logger for important events
// that should *always* appear in the console.
const { logger } = require('../services/logger');
const infoLogger = (req, ...args) => {
    if (!req.logger) {
      req.logger = createRequestLogger(req);
    }
    const startTime = req._logStart || Date.now();
    const message = `${stamp(startTime)} ${args[0]}`;
    const meta = args.length > 1 ? args.slice(1) : {};
    
    // This logs at 'info' level, which will always show in console and file
    req.logger.info(message, meta);
};

module.exports = { logFactory, infoLogger, logger }; // Export main logger too