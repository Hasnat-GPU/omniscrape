/**
 * BridgeClient — the extension's end of the localhost WebSocket.
 *
 * It dials the MCP server, answers the requests it sends, and pushes events the
 * user triggers. Everything here is written around one awkward fact: a Manifest
 * V3 service worker is not a long-lived process. Chrome terminates it after
 * roughly 30 seconds idle, and a "persistent WebSocket connection" is therefore
 * a polite fiction. Three things keep it honest:
 *
 *   1. A keepalive frame every ~20s. Chrome resets the idle timer on WebSocket
 *      traffic, so an active bridge keeps its own worker alive.
 *   2. Reconnect with exponential backoff + jitter, so a server that is not
 *      running yet costs nothing and a server that just restarted is found fast.
 *   3. `chrome.alarms` in the service worker revives us if we are killed anyway
 *      (see service-worker.js) — an alarm can start a stopped worker; a dead
 *      socket cannot.
 */

import { EVENT, T, makeEvent, makeHello, parseEnvelope, is } from '../shared/protocol.js';

/** Connection states surfaced to the UI. */
export const STATE = Object.freeze({
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
});

const KEEPALIVE_MS = 20_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const BACKOFF_FACTOR = 1.7;

export class BridgeClient {
  /**
   * @param {object} options
   * @param {() => Promise<{url: string, token: string}>} options.getSettings
   * @param {(method: string, params: object) => Promise<object>} options.onRequest
   *        Handles a server request; resolve with the result, throw to fail it.
   *        Thrown errors may carry a `.code` from protocol.ERROR_CODE.
   * @param {(state: string, detail: object) => void} [options.onStateChange]
   */
  constructor({ getSettings, onRequest, onStateChange = () => {} }) {
    this.getSettings = getSettings;
    this.onRequest = onRequest;
    this.onStateChange = onStateChange;

    /** @type {WebSocket|null} */
    this.ws = null;
    this.state = STATE.DISCONNECTED;
    this.lastError = '';
    this.attempts = 0;
    this.connectedAt = 0;

    this.reconnectTimer = null;
    this.keepaliveTimer = null;

    /** In-flight connect attempt, so concurrent callers share one socket. */
    this.connectPromise = null;

    /** Set when the user explicitly disconnects, to suppress auto-reconnect. */
    this.stopped = false;
  }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  /** Snapshot for the side panel UI. */
  status() {
    return {
      state: this.state,
      connected: this.state === STATE.CONNECTED,
      url: this.url ?? '',
      lastError: this.lastError,
      attempts: this.attempts,
      connectedAt: this.connectedAt || null,
    };
  }

  /**
   * Ensure a connection exists. Safe to call repeatedly — this is the entry
   * point for startup, alarms, and the UI's "Reconnect" button alike.
   *
   * Concurrent callers are collapsed onto a single attempt. This is not a
   * theoretical nicety: a worker start fires `bootstrap()` from module top
   * level *and* from `onInstalled`/`onStartup`, and the alarm can land on top.
   * Each call used to pass the `this.ws` check while awaiting settings — the
   * socket does not exist yet at that point — and then open its own. Only the
   * last was tracked, so the earlier ones became orphans: still connected, but
   * with no `open` handler willing to claim them, so they never sent a hello
   * and never sent a keepalive. The server counted three clients where there
   * was one browser.
   */
  connect(options = {}) {
    // Manual intent is recorded synchronously, so it is not lost if an
    // automatic attempt happens to be in flight already.
    if (options.manual) {
      this.stopped = false;
      this.attempts = 0; // a human asked, so try immediately
      this.#clearReconnect();
    }
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = this.#attemptConnect(options).finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  async #attemptConnect({ manual = false } = {}) {
    if (this.stopped) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.#clearReconnect();

    let settings;
    try {
      settings = await this.getSettings();
    } catch (error) {
      this.#fail(`Could not read settings: ${error.message}`);
      return;
    }

    const url = this.#buildUrl(settings);
    if (!url) {
      this.#fail('No bridge URL configured.');
      return;
    }

    this.url = url;
    this.#setState(STATE.CONNECTING);

    let socket;
    try {
      socket = new WebSocket(url);
    } catch (error) {
      // Thrown synchronously for a malformed URL.
      this.#fail(`Invalid bridge URL "${url}": ${error.message}`);
      this.#scheduleReconnect();
      return;
    }
    this.ws = socket;

    socket.addEventListener('open', () => {
      // A late 'open' from a socket we already replaced must not clobber state
      // — and must not be left dangling either. An unclaimed socket stays open,
      // answers the server's protocol-level pings automatically so the
      // heartbeat never reaps it, and shows up forever as a phantom client.
      if (this.ws !== socket) {
        try {
          socket.close(1000, 'superseded');
        } catch {
          /* already closing */
        }
        return;
      }

      this.attempts = 0;
      this.lastError = '';
      this.connectedAt = Date.now();
      this.#setState(STATE.CONNECTED);

      this.#send(makeHello('extension', chrome.runtime.getManifest().version, 'chrome-mv3'));
      this.#startKeepalive();
    });

    socket.addEventListener('message', (event) => {
      if (this.ws !== socket) return;
      this.#handleFrame(event.data);
    });

    socket.addEventListener('error', () => {
      if (this.ws !== socket) return;
      // The WebSocket error event carries no detail by design (it would leak
      // cross-origin information), so we can only report that it failed.
      this.lastError =
        'Could not reach the bridge. Is the MCP server running? ' +
        'Check with: curl ' + this.url.replace(/^ws/, 'http').replace(/\/(bridge)?$/, '') + '/health';
    });

    socket.addEventListener('close', (event) => {
      if (this.ws !== socket) return;
      this.ws = null;
      this.#stopKeepalive();
      this.connectedAt = 0;

      if (event.code === 1008 || event.code === 1011) {
        this.lastError = `Server rejected the connection (code ${event.code}). Check the token in Options.`;
      }
      this.#setState(STATE.DISCONNECTED);
      this.#scheduleReconnect();
    });
  }

  /** Close the socket and stop reconnecting until `connect({manual:true})`. */
  disconnect() {
    this.stopped = true;
    this.#clearReconnect();
    this.#stopKeepalive();
    if (this.ws) {
      try {
        this.ws.close(1000, 'user disconnected');
      } catch {
        /* already closing */
      }
      this.ws = null;
    }
    this.#setState(STATE.DISCONNECTED);
  }

  /** Push a fire-and-forget event to the server. Returns false if not open. */
  sendEvent(event, payload) {
    return this.#send(makeEvent(event, payload));
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  #buildUrl({ url, token }) {
    const base = (url || '').trim();
    if (!base) return '';
    if (!token) return base;
    // Append the shared secret as a query param; the server compares it in
    // constant time during the HTTP upgrade.
    const separator = base.includes('?') ? '&' : '?';
    return `${base}${separator}token=${encodeURIComponent(token)}`;
  }

  #send(envelope) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(envelope));
      return true;
    } catch (error) {
      console.warn('[omniscrape] send failed', error);
      return false;
    }
  }

  async #handleFrame(data) {
    const envelope = parseEnvelope(data);
    if (!envelope) {
      console.warn('[omniscrape] dropped unparseable frame');
      return;
    }

    if (!is.request(envelope)) {
      // The server only sends requests today; events from it are reserved.
      return;
    }

    try {
      const result = await this.onRequest(envelope.method, envelope.params ?? {});
      this.#send({ t: T.RESPONSE, id: envelope.id, ok: true, result });
    } catch (error) {
      this.#send({
        t: T.RESPONSE,
        id: envelope.id,
        ok: false,
        error: {
          code: error?.code ?? 'internal_error',
          message: error?.message ?? String(error),
        },
      });
    }
  }

  #setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.onStateChange(state, this.status());
  }

  #fail(message) {
    this.lastError = message;
    console.warn('[omniscrape]', message);
    this.#setState(STATE.DISCONNECTED);
  }

  #scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;

    // Exponential backoff with +/-20% jitter. Jitter matters because several
    // browser windows all reconnect the instant the server restarts, and we do
    // not want them to arrive in lockstep forever.
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * BACKOFF_FACTOR ** this.attempts);
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));
    this.attempts += 1;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  #clearReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  #startKeepalive() {
    this.#stopKeepalive();
    this.keepaliveTimer = setInterval(() => {
      if (!this.#send(makeEvent(EVENT.KEEPALIVE, { at: Date.now() }))) {
        this.#stopKeepalive();
      }
    }, KEEPALIVE_MS);
  }

  #stopKeepalive() {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }
}
