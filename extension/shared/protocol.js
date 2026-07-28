/**
 * The wire protocol spoken over the localhost WebSocket between this MCP server
 * and the OmniScrape Chrome extension.
 *
 * IMPORTANT: this is a verbatim mirror of `mcp-server/src/protocol.js`. It is
 * deliberately dependency-free and framework-free so the same source can run in
 * Node and in a Manifest V3 service worker. If you change a constant here,
 * change it there too — `npm run check:protocol` in mcp-server asserts the two
 * files stay byte-identical apart from this header.
 *
 * ## Envelope shapes
 *
 * Request  (server -> extension)   { t: 'req',   id, method, params }
 * Response (extension -> server)   { t: 'res',   id, ok: true,  result }
 *                                  { t: 'res',   id, ok: false, error: { code, message } }
 * Event    (either direction)      { t: 'evt',   event, payload }
 * Hello    (extension -> server)   { t: 'hello', role, version, agent }
 *
 * Requests are correlated by `id`. Events are fire-and-forget: nobody replies to
 * them and nobody awaits them.
 */

/** Envelope discriminator values. */
export const T = Object.freeze({
  REQUEST: 'req',
  RESPONSE: 'res',
  EVENT: 'evt',
  HELLO: 'hello',
});

/** Methods the server may invoke on the extension. */
export const METHOD = Object.freeze({
  /** Scrape the readable body of a tab and return it as Markdown. */
  PAGE_MARKDOWN: 'page.markdown',
  /** Return data for the elements the user picked with the point-and-click tool. */
  SELECTION_SCRAPE: 'selection.scrape',
  /** Liveness probe; also returns a summary of candidate tabs. */
  BRIDGE_PING: 'bridge.ping',
});

/** Events the extension may push to the server without being asked. */
export const EVENT = Object.freeze({
  /** User pressed "Send to Claude" — payload is a full capture envelope. */
  CAPTURE: 'capture',
  /** Selection set changed in a tab — payload is a lightweight summary. */
  SELECTION_CHANGED: 'selection.changed',
  /**
   * Periodic no-op from the extension. A Manifest V3 service worker is killed
   * after ~30s idle, and Chrome documents WebSocket traffic as what resets that
   * timer — so the extension sends this every ~20s to stay alive while
   * connected. The server intentionally does nothing with it.
   */
  KEEPALIVE: 'keepalive',
});

/** Error codes returned inside a failed response envelope. */
export const ERROR_CODE = Object.freeze({
  /** The extension does not implement the requested method. */
  UNKNOWN_METHOD: 'unknown_method',
  /** No suitable tab (none active, or it is a chrome:// page we cannot touch). */
  NO_ACTIVE_TAB: 'no_active_tab',
  /** The content script could not be injected or did not answer. */
  CONTENT_SCRIPT_UNAVAILABLE: 'content_script_unavailable',
  /** The user has not selected anything yet. */
  NO_SELECTION: 'no_selection',
  /** Scraping threw. */
  SCRAPE_FAILED: 'scrape_failed',
  /** Server-side: nothing is connected to the bridge. */
  NOT_CONNECTED: 'not_connected',
  /** Server-side: the extension did not answer within the timeout. */
  TIMEOUT: 'timeout',
  /** Server-side: the socket closed while the request was in flight. */
  DISCONNECTED: 'disconnected',
  /** Anything else. */
  INTERNAL: 'internal_error',
});

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

export function makeRequest(id, method, params = {}) {
  return { t: T.REQUEST, id, method, params };
}

export function makeSuccess(id, result) {
  return { t: T.RESPONSE, id, ok: true, result };
}

export function makeFailure(id, code, message, details) {
  return { t: T.RESPONSE, id, ok: false, error: { code, message, ...(details ? { details } : {}) } };
}

export function makeEvent(event, payload) {
  return { t: T.EVENT, event, payload };
}

export function makeHello(role, version, agent) {
  return { t: T.HELLO, role, version, agent };
}

// ---------------------------------------------------------------------------
// Parsing / validation
// ---------------------------------------------------------------------------

/**
 * Parse raw WebSocket data into an envelope, or return null if it is not one.
 * Never throws — anything can arrive on a socket, including from software that
 * is not our extension at all.
 *
 * @param {string|Buffer|ArrayBuffer} raw
 * @returns {object|null}
 */
export function parseEnvelope(raw) {
  let text;
  if (typeof raw === 'string') {
    text = raw;
  } else if (raw instanceof ArrayBuffer) {
    text = new TextDecoder().decode(raw);
  } else if (raw && typeof raw === 'object' && typeof raw.toString === 'function') {
    text = raw.toString('utf8');
  } else {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (typeof parsed.t !== 'string') return null;
  return parsed;
}

/** Type guards used by both ends to route an incoming envelope. */
export const is = Object.freeze({
  request: (e) => e?.t === T.REQUEST && typeof e.id === 'string' && typeof e.method === 'string',
  response: (e) => e?.t === T.RESPONSE && typeof e.id === 'string' && typeof e.ok === 'boolean',
  event: (e) => e?.t === T.EVENT && typeof e.event === 'string',
  hello: (e) => e?.t === T.HELLO,
});

/**
 * The canonical capture envelope both ends agree on. Every scrape — whether it
 * was pulled by a tool call or pushed by the "Send to Claude" button — is
 * normalised into this shape so downstream consumers only learn one schema.
 *
 * @typedef {object} CaptureEnvelope
 * @property {string} url             Page the capture came from.
 * @property {string} title           Document title at capture time.
 * @property {string} timestamp       ISO-8601 capture time.
 * @property {string} markdown_content Cleaned Markdown body ('' when field-only).
 * @property {ExtractedField[]} extracted_fields Point-and-click results.
 * @property {object} meta            Provenance: mode, counts, truncation, ...
 *
 * @typedef {object} ExtractedField
 * @property {string} label           Human label ("price", "Field 2", ...).
 * @property {string} selector        CSS selector that produced the values.
 * @property {number} match_count     How many nodes the selector matched.
 * @property {Array<object>} values    One entry per matched node.
 */

/** Build a CaptureEnvelope with every field present and correctly typed. */
export function makeCapture({
  url = '',
  title = '',
  timestamp = new Date().toISOString(),
  markdown_content = '',
  extracted_fields = [],
  meta = {},
} = {}) {
  return { url, title, timestamp, markdown_content, extracted_fields, meta };
}
