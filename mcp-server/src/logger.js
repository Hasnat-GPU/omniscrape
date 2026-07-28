/**
 * Minimal leveled logger that writes to **stderr only**.
 *
 * This is not a style preference. When an MCP server speaks over the stdio
 * transport, stdout carries newline-delimited JSON-RPC frames. A single stray
 * `console.log` corrupts the stream and the client drops the connection with a
 * confusing parse error. So: never write to stdout anywhere in this codebase.
 */

import process from 'node:process';
import { config } from './config.js';

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

const threshold = LEVELS[String(config.logLevel).toLowerCase()] ?? LEVELS.info;

/**
 * Render structured context without ever throwing (circular refs, BigInt, DOM
 * leftovers relayed from the extension, ...). Logging must not be able to crash
 * the server.
 */
function formatContext(context) {
  if (context === undefined || context === null) return '';
  if (typeof context !== 'object') return ` ${String(context)}`;
  if (Object.keys(context).length === 0) return '';
  try {
    return ` ${JSON.stringify(context, replacer)}`;
  } catch {
    return ' [uninspectable context]';
  }
}

function replacer(_key, value) {
  if (typeof value === 'bigint') return `${value}n`;
  if (value instanceof Error) return { name: value.name, message: value.message };
  return value;
}

function emit(level, message, context) {
  if (LEVELS[level] > threshold) return;
  const line = `[omniscrape] ${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}${formatContext(context)}\n`;
  process.stderr.write(line);
}

export const logger = {
  error: (message, context) => emit('error', message, context),
  warn: (message, context) => emit('warn', message, context),
  info: (message, context) => emit('info', message, context),
  debug: (message, context) => emit('debug', message, context),

  /** Log an Error with its stack at debug level, message at error level. */
  exception(message, error, context = {}) {
    emit('error', `${message}: ${error?.message ?? error}`, context);
    if (error?.stack) emit('debug', 'stack', { stack: error.stack });
  },
};
