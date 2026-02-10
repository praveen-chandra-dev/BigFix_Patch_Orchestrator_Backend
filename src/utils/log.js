// backend/src/utils/log.jss
const { createRequestLogger, getLogLevel } = require('../services/logger');

// Helpers to mimic the old logger's [reqId] (+ms) format
function stamp(start) { const ms = Date.now() - start; return `(+${ms}ms)`; }

// Helper function to decode URL-encoded strings for readability
function processLogArgs(args) {
    let message = args[0] || '';
    let meta = args.length > 1 ? args.slice(1) : [];

    // Check if the first metadata element is a long, encoded string
    if (meta.length > 0 && typeof meta[0] === 'string' && meta[0].length > 100) {
        let decodedContent;
        try {
            // Attempt to decode the URL, as is common with BigFix relevance queries
            decodedContent = decodeURIComponent(meta[0]);
        } catch (e) {
            // If decoding fails (e.g., if it's just a long piece of text), use original content
            decodedContent = meta[0];
        }
        
        // Prepend the decoded string to the message and remove it from meta
        message += ` ${decodedContent}`;
        meta = meta.slice(1);
    }
    
    return { message, meta };
}


/**
 * Creates a logging function that respects the .env log level
 * and automatically includes a request ID.
 * All logs from this factory are routed to the 'debug' level. New
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

    // 2. Format the message and decode long strings
    const startTime = req._logStart || Date.now();
    const { message: processedMessage, meta } = processLogArgs(args);
    const finalMessage = `${stamp(startTime)} ${processedMessage}`;
    
    // 3. Log at 'debug' level.
 
    
    req.logger.debug(finalMessage, ...meta);
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
    const { message: processedMessage, meta } = processLogArgs(args);
    
    const finalMessage = `${stamp(startTime)} ${processedMessage}`;
    
    // This logs at 'info' level, which will always show in console and file
    req.logger.info(finalMessage, ...meta);
};

module.exports = { logFactory, infoLogger, logger }; // Export main logger too