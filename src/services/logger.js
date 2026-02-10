// backend/src/services/logger.js
const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');
const fs = require('fs');
const { getCfg } = require('../env');

// Ensure logs directory exists in the backend root
const logDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir);
}

/**
 * Gets the log level from the application config.
 */
function getLogLevel() {
  try {
    const cfg = getCfg();
    const level = String(cfg.DEBUG_LOG || 'info').toLowerCase();
    
    if (level === '1' || level === 'debug') {
      return 'debug';
    }
    return 'info';
  } catch (e) {
    const level = String(process.env.DEBUG_LOG || 'info').toLowerCase();
    return (level === '1' || level === 'debug') ? 'debug' : 'info';
  }
}

// --- Helper: Clean Metadata Formatting ---
function formatMeta(meta) {
  // Keys to exclude from the metadata dump (already handled explicitly)
  const knownKeys = ['level', 'timestamp', 'message', 'reqId', 'stack', Symbol.for('splat')];
  
  const cleanMeta = Object.keys(meta).reduce((acc, key) => {
      if (!knownKeys.includes(key) && meta[key] !== undefined) {
          acc[key] = meta[key];
      }
      return acc;
  }, {});

  if (Object.keys(cleanMeta).length === 0) return '';
  return ' ' + JSON.stringify(cleanMeta);
}

// --- 1. FILE FORMAT: Strict, Detailed, Uncolored ---
const fileFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.printf(({ timestamp, level, message, reqId, stack, ...meta }) => {
    const idStr = reqId ? `[${reqId}] ` : '';
    const metaStr = formatMeta(meta);
    const stackStr = stack ? `\n${stack}` : '';
    
    // Format: 2025-01-01 12:00:00.000 INFO: [ID] Message {meta}
    return `${timestamp} ${level.toUpperCase()}: ${idStr}${message}${metaStr}${stackStr}`;
  })
);

// --- 2. CONSOLE FORMAT: Friendly, Colored, Readable ---
const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'HH:mm:ss' }), // Simpler time for humans
  winston.format.colorize(), // Add colors (Green for Info, Red for Error, etc.)
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.printf(({ timestamp, level, message, reqId, stack, ...meta }) => {
    const idStr = reqId ? `[${reqId}] ` : '';
    const metaStr = formatMeta(meta);
    const stackStr = stack ? `\n${stack}` : '';
    
    // Format: [12:00:00] info: [ID] Message {meta}
    // Note: 'level' string contains color codes here
    return `[${timestamp}] ${level}: ${idStr}${message}${metaStr}${stackStr}`;
  })
);

// --- Transports ---

// File transport for daily rotation
const fileTransport = new DailyRotateFile({
  filename: path.join(logDir, 'app-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  zippedArchive: true,
  maxSize: '20m',
  maxFiles: '14d',
  level: 'debug', // Always capture everything in files
  format: fileFormat, 
});

// Console transport
const consoleTransport = new winston.transports.Console({
  level: getLogLevel(), // Controlled by .env
  format: consoleFormat,
});

// Create the main logger instance
const logger = winston.createLogger({
  transports: [
    fileTransport,
    consoleTransport
  ],
  exitOnError: false,
});

// Function to update console log level dynamically
function updateConsoleLogLevel() {
  const newLevel = getLogLevel();
  if (consoleTransport.level !== newLevel) {
    // Use direct console to bypass filters and ensure visibility
    console.log(`\x1b[36m[Logger]\x1b[0m Updating console log level to: \x1b[1m${newLevel}\x1b[0m`);
    consoleTransport.level = newLevel;
  }
}

// --- Request ID Logic ---
let _rid = 0;
function getReqId() {
  _rid = (_rid + 1) % 1000000;
  return _rid.toString().padStart(6, '0');
}

function createRequestLogger(req) {
  if (!req._logStart) req._logStart = Date.now();
  if (!req._rid) req._rid = getReqId();
  
  return logger.child({ reqId: req._rid });
}

module.exports = { logger, createRequestLogger, getLogLevel, updateConsoleLogLevel };