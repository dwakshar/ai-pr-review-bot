/**
 * logger.js — Centralized structured logging using Winston.
 *
 * Design decisions:
 * - Single logger instance exported as a module singleton to ensure
 *   consistent log formatting across all modules.
 * - GitHub Actions CI surfaces logs in job output, so we emit to console
 *   with a clean format rather than file transports.
 * - Log level is driven by the DEBUG env var to avoid verbose output
 *   in production runs while enabling detailed traces during development.
 */

import { createLogger, format, transports } from 'winston';

const { combine, timestamp, printf, colorize, errors } = format;

// Custom format that emits key=value context pairs for easy log parsing.
const ciFormat = printf(({ level, message, timestamp, context, ...meta }) => {
  const ctx = context ? ` [${context}]` : '';
  const metaStr = Object.keys(meta).length
    ? ' ' + JSON.stringify(meta)
    : '';
  return `${timestamp} ${level}${ctx}: ${message}${metaStr}`;
});

const logger = createLogger({
  level: process.env.DEBUG === 'true' ? 'debug' : 'info',
  format: combine(
    errors({ stack: true }),   // Capture stack traces on Error objects
    timestamp({ format: 'HH:mm:ss' }),
    colorize({ all: true }),
    ciFormat
  ),
  transports: [
    new transports.Console()
  ]
});

/**
 * Returns a child logger pre-scoped to a module context label.
 * Usage: const log = createContextLogger('fetchPRDiff')
 */
export function createContextLogger(context) {
  return {
    debug: (msg, meta = {}) => logger.debug(msg, { context, ...meta }),
    info:  (msg, meta = {}) => logger.info(msg,  { context, ...meta }),
    warn:  (msg, meta = {}) => logger.warn(msg,  { context, ...meta }),
    error: (msg, meta = {}) => logger.error(msg, { context, ...meta }),
  };
}

export default logger;
