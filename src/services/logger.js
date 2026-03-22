// src/services/logger.js
const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { getCfg } = require('../env');

// Ensure logs directory exists
const logDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir);
}

function getLogLevel() {
  try {
    const cfg = getCfg();
    const level = String(cfg.DEBUG_LOG || 'info').toLowerCase();
    if (level === '1' || level === 'debug') return 'debug';
    return 'info';
  } catch (e) {
    return 'info';
  }
}

function formatMeta(meta) {
  const knownKeys = ['level', 'timestamp', 'message', 'reqId', 'stack', Symbol.for('splat')];
  const cleanMeta = Object.keys(meta).reduce((acc, key) => {
      if (!knownKeys.includes(key) && meta[key] !== undefined) acc[key] = meta[key];
      return acc;
  }, {});

  if (Object.keys(cleanMeta).length === 0) return '';
  return ' ' + JSON.stringify(cleanMeta);
}

// Custom formatter matching BES Root Server Logs
const besFormatter = winston.format.printf(({ timestamp, level, message, reqId, stack, ...meta }) => {
  const pid = process.pid;
  const threadName = reqId ? `ReqID:${reqId}` : 'Main Thread';
  const metaStr = formatMeta(meta);
  const stackStr = stack ? `\n   Stack Trace:\n   ${stack.replace(/\n/g, '\n   ')}` : '';
  
  // Format: Sat, 01 Mar 2025 17:19:09 +0530 - Main Thread (13136) - [INFO] Message
  return `${timestamp} - ${threadName} (${pid}) - [${level.toUpperCase()}] ${message}${metaStr}${stackStr}`;
});

const consoleFormatter = winston.format.printf(({ timestamp, level, message, reqId, stack, ...meta }) => {
  const pid = process.pid;
  const threadName = reqId ? `ReqID:${reqId}` : 'Main Thread';
  const metaStr = formatMeta(meta);
  const stackStr = stack ? `\n   Stack Trace:\n   ${stack.replace(/\n/g, '\n   ')}` : '';
  
  // Same format but supports Winston's colorized level
  return `${timestamp} - ${threadName} (${pid}) - [${level}] ${message}${metaStr}${stackStr}`;
});

// --- 1. FILE FORMAT ---
const fileFormat = winston.format.combine(
  winston.format.timestamp({ format: 'ddd, DD MMM YYYY HH:mm:ss ZZ' }), 
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format((info) => {
    info.level = info.level.replace(/\x1b\[[0-9;]*m/g, ''); // strip colors
    return info;
  })(),
  besFormatter
);

// --- 2. CONSOLE FORMAT ---
const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'ddd, DD MMM YYYY HH:mm:ss ZZ' }),
  winston.format.colorize(),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  consoleFormatter
);

const fileTransport = new DailyRotateFile({
  filename: path.join(logDir, 'patch-setu-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  zippedArchive: true,
  maxSize: '20m',
  maxFiles: '14d',
  level: 'debug', 
  format: fileFormat, 
});

const consoleTransport = new winston.transports.Console({
  level: getLogLevel(), 
  format: consoleFormat,
});

const logger = winston.createLogger({
  transports: [ fileTransport, consoleTransport ],
  exitOnError: false,
});

function updateConsoleLogLevel() {
  const newLevel = getLogLevel();
  if (consoleTransport.level !== newLevel) {
    consoleTransport.level = newLevel;
    logger.info(`Log level updated to: ${newLevel.toUpperCase()}`);
  }
}

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