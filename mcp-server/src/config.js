/**
 * Central, environment-driven configuration for the OmniScrape MCP server.
 *
 * Every knob can be overridden with an `OMNISCRAPE_*` environment variable, which
 * matters because MCP servers are normally launched by the MCP client (Claude
 * Desktop / Claude Code) from a JSON config file where `env` is the only way to
 * pass settings — there is no command line to type flags into.
 */

import process from 'node:process';

/** Parse an integer env var, falling back when unset/garbage. */
function int(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Parse a boolean env var. Accepts 1/true/yes/on (case-insensitive). */
function bool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

/** Parse a comma-separated list env var into a trimmed, non-empty array. */
function list(value, fallback) {
  if (!value) return fallback;
  const items = String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : fallback;
}

const env = process.env;

export const config = Object.freeze({
  /** Server identity reported over MCP and on the /health endpoint. */
  name: 'omniscrape',
  version: '0.1.0',

  // ---------------------------------------------------------------------------
  // Bridge (HTTP + WebSocket) transport
  // ---------------------------------------------------------------------------

  /** TCP port shared by the Express health endpoint and the WebSocket upgrade. */
  port: int(env.OMNISCRAPE_PORT, 3000),

  /**
   * Bind address. Defaults to loopback ON PURPOSE: this bridge hands out the
   * contents of whatever page the user is looking at, so it must never be
   * reachable from the local network. Override only if you truly know why.
   */
  host: env.OMNISCRAPE_HOST || '127.0.0.1',

  /**
   * Origins permitted to open the WebSocket. Chrome extensions connect with an
   * `Origin: chrome-extension://<extension-id>` header; ordinary web pages send
   * their own https origin. Restricting to the extension scheme is what stops a
   * random tab from connecting to the bridge and siphoning scrapes.
   *
   * Entries may be an exact origin (`chrome-extension://abcdef...`) or a scheme
   * wildcard (`chrome-extension://*`). Pin the exact ID once you have loaded the
   * extension and know it — see README "Locking down the bridge".
   */
  allowedOrigins: list(env.OMNISCRAPE_ALLOWED_ORIGINS, [
    'chrome-extension://*',
    // Firefox/Edge equivalents, harmless to keep for a cross-browser port.
    'moz-extension://*',
  ]),

  /**
   * Optional shared secret. When set, the extension must connect with
   * `?token=<value>`; connections without it are rejected at handshake time.
   * Unset by default so the extension works with zero configuration.
   */
  token: env.OMNISCRAPE_TOKEN || '',

  /** WebSocket paths accepted during the HTTP upgrade. */
  allowedPaths: Object.freeze(['/', '/bridge']),

  /**
   * Largest single WebSocket frame accepted, in bytes. A full-page Markdown
   * capture of a heavy article lands around 100 KB, so 16 MB is generous while
   * still bounding how much memory a misbehaving client can make us allocate.
   */
  maxMessageBytes: int(env.OMNISCRAPE_MAX_MESSAGE_BYTES, 16 * 1024 * 1024),

  // ---------------------------------------------------------------------------
  // Request/response behaviour
  // ---------------------------------------------------------------------------

  /**
   * How long a tool call waits for the extension to answer before giving up.
   * Readability + Turndown on a large page is fast, but the tab may be busy
   * loading, so we allow a comfortable margin.
   */
  requestTimeoutMs: int(env.OMNISCRAPE_REQUEST_TIMEOUT_MS, 30_000),

  /** Interval for WebSocket keepalive pings used to reap half-open sockets. */
  heartbeatMs: int(env.OMNISCRAPE_HEARTBEAT_MS, 30_000),

  // ---------------------------------------------------------------------------
  // Capture inbox ("Send to Claude" pushes)
  // ---------------------------------------------------------------------------

  /** How many pushed captures to retain in memory before evicting the oldest. */
  inboxMax: int(env.OMNISCRAPE_INBOX_MAX, 25),

  /** Expose the in-memory inbox over HTTP too (debugging aid, off by default). */
  exposeCapturesOverHttp: bool(env.OMNISCRAPE_EXPOSE_CAPTURES_HTTP, false),

  // ---------------------------------------------------------------------------
  // Diagnostics
  // ---------------------------------------------------------------------------

  /** silent | error | warn | info | debug */
  logLevel: env.OMNISCRAPE_LOG_LEVEL || 'info',
});

/** Convenience: the ws:// URL the extension should point at. */
export function bridgeUrl() {
  return `ws://${config.host}:${config.port}`;
}

/** Convenience: the http:// URL of the health endpoint. */
export function healthUrl() {
  return `http://${config.host}:${config.port}/health`;
}
