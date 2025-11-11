// backend/src/services/logger.js
const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('node:path');
const fs = require('node:fs');
const { getCfg } = require('../env'); // To read DEBUG_LOG

// Ensure logs directory exists in the backend root
const logDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir);
}

/**
 * Gets the log level from the application config.
 * DEBUG_LOG=1 or 'debug' maps to 'debug'
 * DEBUG_LOG=0 or 'info' (or default) maps to 'info'
 */
function getLogLevel() {
  try {
    const cfg = getCfg();
    const level = String(cfg.DEBUG_LOG || 'info').toLowerCase();
    
    if (level === '1' || level === 'debug') {
      return 'debug';
    }
    // '0', 'info', or anything else
    return 'info';
  } catch (e) {
    // Fallback if config isn't ready
    const level = String(process.env.DEBUG_LOG || 'info').toLowerCase();
    return (level === '1' || level === 'debug') ? 'debug' : 'info';
  }
}

// Define custom log format
const logFormat = winston.format.printf(({ timestamp, level, message, reqId, ...meta }) => {
  // Safely stringify metadata
  const metaString = (meta && Object.keys(meta).length) ? JSON.stringify(meta) : '';
  const id = reqId ? `[${reqId}] ` : '';
  // Format: 2025-11-11T01:30:00.123Z INFO: [123456] (+50ms) My log message {meta}
  return `${timestamp} ${level}: ${id}${message} ${metaString}`;
});

// File transport for daily rotation
const fileTransport = new DailyRotateFile({
  filename: path.join(logDir, 'app-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  zippedArchive: true,
  maxSize: '20m',
  maxFiles: '14d',
  level: 'debug', // Always log 'debug' and above to files
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json(),
    logFormat
  ),
});

// Console transport
const consoleTransport = new winston.transports.Console({
  level: getLogLevel(), // Log level is controlled by .env
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp({ format: 'HH:mm:ss' }), // Simple timestamp for console
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    logFormat
  ),
});

// Create the main logger instance
const logger = winston.createLogger({
  transports: [
    fileTransport,
    consoleTransport
  ],
  exitOnError: false,
});

// --- NEW FUNCTION to update console log level ---
function updateConsoleLogLevel() {
  const newLevel = getLogLevel();
  if (consoleTransport.level !== newLevel) {
    // Use console.warn for this meta-log so it always appears
    console.warn(`[Logger] Updating console log level to: ${newLevel}`);
    consoleTransport.level = newLevel;
  }
}


// --- Request-specific logger ---

let _rid = 0;
function getReqId() {
  _rid = (_rid + 1) % 1000000;
  return _rid.toString().padStart(6, '0');
}

/**
 * Creates a child logger with a request ID bound to it.
 * @param {object} req - The Express request object.
 */
function createRequestLogger(req) {
  if (!req._logStart) req._logStart = Date.now();
  if (!req._rid) req._rid = getReqId();
  
  return logger.child({ reqId: req._rid });
}

module.exports = { logger, createRequestLogger, getLogLevel, updateConsoleLogLevel };