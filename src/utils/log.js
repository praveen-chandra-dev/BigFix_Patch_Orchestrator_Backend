// src/utils/log.js
const { createRequestLogger, getLogLevel, logger } = require('../services/logger');

function stamp(start) { 
    const ms = Date.now() - start; 
    return `(+${ms}ms)`; 
}

function processLogArgs(args) {
    let message = args[0] || '';
    let meta = args.length > 1 ? args.slice(1) : [];

    if (meta.length > 0 && typeof meta[0] === 'string' && meta[0].length > 100) {
        let decodedContent;
        try { 
            decodedContent = decodeURIComponent(meta[0]); 
        } catch (e) { 
            decodedContent = meta[0]; 
        }
        message += ` | Query: ${decodedContent}`; 
        meta = meta.slice(1);
    }
    
    return { message, meta };
}

function logFactory(DEBUG_LOG_LEGACY) {
  return function log(req, ...args) {
    if (!req.logger) req.logger = createRequestLogger(req);
    const startTime = req._logStart || Date.now();
    const { message: processedMessage, meta } = processLogArgs(args);
    const finalMessage = `${processedMessage} ${stamp(startTime)}`;
    req.logger.debug(finalMessage, ...meta);
  };
}

const infoLogger = (req, ...args) => {
    if (!req.logger) req.logger = createRequestLogger(req);
    const startTime = req._logStart || Date.now();
    const { message: processedMessage, meta } = processLogArgs(args);
    const finalMessage = `${processedMessage} ${stamp(startTime)}`;
    req.logger.info(finalMessage, ...meta);
};

module.exports = { logFactory, infoLogger, logger };