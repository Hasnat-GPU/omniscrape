/**
 * ExtensionBridge — the localhost transport between this MCP server and the
 * OmniScrape Chrome extension.
 *
 * Why a WebSocket at all: an MCP server is a Node process talking JSON-RPC over
 * stdio to Claude. The scraping has to happen inside the browser, in a page's
 * DOM. Those two worlds cannot see each other, so the extension dials into a
 * loopback socket here and we turn MCP tool calls into request/response round
 * trips across it.
 *
 * Responsibilities:
 *   - Own one HTTP server shared by Express (health endpoint) and `ws` (upgrade).
 *   - Authenticate the handshake (origin allowlist + optional shared token).
 *   - Correlate outbound requests with inbound responses by id, with timeouts.
 *   - Reap half-open sockets with a ping/pong heartbeat.
 *   - Re-emit unsolicited events (the "Send to Claude" button) to listeners.
 */

import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { WebSocketServer } from 'ws';

import { config } from './config.js';
import { logger } from './logger.js';
import { ERROR_CODE, METHOD, is, makeRequest, parseEnvelope } from './protocol.js';

/** An error carrying a protocol error code, so tools can report precisely. */
export class BridgeError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.details = details;
  }
}

/** Constant-time string comparison that tolerates unequal lengths. */
function secretsMatch(a, b) {
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Does `origin` satisfy the allowlist? Supports exact origins and `scheme://*`
 * wildcards, plus a bare `*` escape hatch for debugging.
 */
function originAllowed(origin, allowed) {
  if (allowed.includes('*')) return true;
  // No Origin header means a non-browser client (curl, a script, another local
  // process). Our extension always sends one, so absence is a mismatch and we
  // reject. Set OMNISCRAPE_ALLOWED_ORIGINS=* if you deliberately want to drive
  // the bridge from a non-browser client.
  if (!origin) return false;

  return allowed.some((rule) => {
    if (rule === origin) return true;
    if (rule.endsWith('://*')) {
      const scheme = rule.slice(0, -1); // keep "chrome-extension://"
      return origin.startsWith(scheme);
    }
    return false;
  });
}

/** Politely refuse an upgrade with a real HTTP status instead of a raw drop. */
function rejectUpgrade(socket, status, reason) {
  const body = `${status} ${reason}`;
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\n` +
      'Connection: close\r\n' +
      'Content-Type: text/plain\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      '\r\n' +
      body,
  );
  socket.destroy();
}

/**
 * @typedef {object} ClientRecord
 * @property {string} id           Server-assigned connection id.
 * @property {import('ws').WebSocket} ws
 * @property {string} origin       Origin header presented at handshake.
 * @property {number} connectedAt  epoch ms
 * @property {number} lastSeenAt   epoch ms of the last inbound frame
 * @property {boolean} isAlive     Heartbeat flag; false means a pong is overdue.
 * @property {string} agent        Self-reported client description.
 * @property {string} version      Self-reported client version.
 */

export class ExtensionBridge extends EventEmitter {
  constructor(options = {}) {
    super();
    this.port = options.port ?? config.port;
    this.host = options.host ?? config.host;
    this.token = options.token ?? config.token;
    this.allowedOrigins = options.allowedOrigins ?? config.allowedOrigins;
    this.requestTimeoutMs = options.requestTimeoutMs ?? config.requestTimeoutMs;

    /** @type {Map<import('ws').WebSocket, ClientRecord>} */
    this.clients = new Map();

    /** In-flight requests awaiting a response, keyed by request id. */
    this.pending = new Map();

    this.app = express();
    this.httpServer = createServer(this.app);
    this.wss = new WebSocketServer({ noServer: true, maxPayload: config.maxMessageBytes });
    this.heartbeatTimer = null;
    this.started = false;

    /**
     * Why the last `start()` failed, or null. The process deliberately stays
     * alive when the bridge cannot bind, so this is the only record of what
     * went wrong — `status()` hands it to the agent.
     * @type {Error|null}
     */
    this.startError = null;

    /** Optional CaptureInbox, wired by `attachInbox()` for the /captures route. */
    this.inbox = null;

    this.#configureHttp();
    this.#configureUpgrade();
    this.#configureSocketEvents();
  }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  /** True when at least one extension is connected and ready for requests. */
  get connected() {
    return this.primaryClient() !== null;
  }

  /**
   * Pick the client to route requests to. With multiple browser profiles
   * connected we prefer the most recently *active* one, which is the closest
   * available proxy for "the window the user is actually looking at".
   * @returns {ClientRecord|null}
   */
  primaryClient() {
    let best = null;
    for (const record of this.clients.values()) {
      if (record.ws.readyState !== record.ws.OPEN) continue;
      if (!best || record.lastSeenAt > best.lastSeenAt) best = record;
    }
    return best;
  }

  /** A serialisable snapshot for the health endpoint and the status tool. */
  status() {
    return {
      server: { name: config.name, version: config.version },
      listening: this.started,
      // Present only when the bridge is down, so a scrape failure can be traced
      // to "the port was taken" rather than "the browser is not connected".
      start_error: this.startError ? this.startError.message : null,
      bridge_url: `ws://${this.host}:${this.port}`,
      auth: {
        token_required: Boolean(this.token),
        allowed_origins: this.allowedOrigins,
      },
      extension_connected: this.connected,
      client_count: this.clients.size,
      clients: [...this.clients.values()].map((c) => ({
        id: c.id,
        origin: c.origin,
        agent: c.agent,
        version: c.version,
        connected_at: new Date(c.connectedAt).toISOString(),
        idle_ms: Date.now() - c.lastSeenAt,
      })),
      pending_requests: this.pending.size,
    };
  }

  /** Start listening. Rejects with an actionable message on EADDRINUSE. */
  async start() {
    if (this.started) return;

    try {
      await this.#listen();
    } catch (error) {
      // Remember the reason. The caller is expected to keep the process up so
      // the MCP tools can explain the outage, and by then the stack is gone.
      this.startError = error;
      throw error;
    }

    this.started = true;
    this.startError = null;
    this.#startHeartbeat();
    logger.info('bridge listening', {
      ws: `ws://${this.host}:${this.port}`,
      health: `http://${this.host}:${this.port}/health`,
      token_required: Boolean(this.token),
    });
  }

  /** Bind the HTTP server, translating EADDRINUSE into something actionable. */
  #listen() {
    return new Promise((resolve, reject) => {
      const onError = (error) => {
        this.httpServer.off('listening', onListening);
        if (error.code === 'EADDRINUSE') {
          reject(
            new Error(
              `Port ${this.port} is already in use. Either another OmniScrape server is ` +
                `running, or something else owns that port. Set OMNISCRAPE_PORT to a free ` +
                `port (and update the extension's Bridge URL to match).`,
            ),
          );
        } else {
          reject(error);
        }
      };
      const onListening = () => {
        this.httpServer.off('error', onError);
        resolve();
      };
      this.httpServer.once('error', onError);
      this.httpServer.once('listening', onListening);
      this.httpServer.listen(this.port, this.host);
    });
  }

  /** Stop the heartbeat, close all sockets, and release the port. */
  async stop() {
    if (!this.started) return;
    this.started = false;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    // Fail anything still in flight so callers do not hang on shutdown.
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new BridgeError(ERROR_CODE.DISCONNECTED, 'Bridge is shutting down.'));
      this.pending.delete(id);
    }

    for (const record of this.clients.values()) {
      try {
        record.ws.close(1001, 'server shutting down');
      } catch {
        /* socket already gone */
      }
    }
    this.clients.clear();

    await new Promise((resolve) => {
      this.wss.close(() => resolve());
    });
    await new Promise((resolve) => {
      this.httpServer.close(() => resolve());
    });
    logger.info('bridge stopped');
  }

  /**
   * Send a request to the extension and await its response.
   *
   * @param {string} method  One of METHOD.*
   * @param {object} params
   * @param {{timeoutMs?: number}} [options]
   * @returns {Promise<object>} the `result` payload from the extension
   * @throws {BridgeError} not_connected | timeout | disconnected | whatever the
   *         extension reported in a failure envelope
   */
  call(method, params = {}, options = {}) {
    const client = this.primaryClient();
    if (!client) {
      // Two very different failures land here. If the bridge never bound, no
      // extension *could* have connected, and telling the user to check Chrome
      // sends them hunting in the wrong place.
      return Promise.reject(
        new BridgeError(
          ERROR_CODE.NOT_CONNECTED,
          this.startError
            ? `The bridge is not listening, so the extension has nothing to connect to. ${this.startError.message}`
            : 'No OmniScrape extension is connected to the bridge. Open Chrome, make sure the ' +
              'extension is loaded and enabled, then check its popup shows "Connected".',
        ),
      );
    }

    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    const id = randomUUID();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new BridgeError(
            ERROR_CODE.TIMEOUT,
            `The extension did not respond to "${method}" within ${timeoutMs}ms. The tab may ` +
              `still be loading, or the page may block content scripts.`,
          ),
        );
      }, timeoutMs);
      // Do not let a pending timeout hold the event loop open at shutdown.
      timer.unref?.();

      this.pending.set(id, { resolve, reject, timer, socket: client.ws, method, startedAt: Date.now() });

      try {
        client.ws.send(JSON.stringify(makeRequest(id, method, params)));
        logger.debug('-> request', { id, method, client: client.id });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new BridgeError(ERROR_CODE.DISCONNECTED, `Failed to send "${method}": ${error.message}`));
      }
    });
  }

  /** Give the bridge a read-only handle on the inbox for the /captures route. */
  attachInbox(inbox) {
    this.inbox = inbox;
  }

  /** Fire-and-forget broadcast of an event to every connected client. */
  broadcast(event, payload) {
    const frame = JSON.stringify({ t: 'evt', event, payload });
    for (const record of this.clients.values()) {
      if (record.ws.readyState !== record.ws.OPEN) continue;
      try {
        record.ws.send(frame);
      } catch (error) {
        logger.debug('broadcast failed', { client: record.id, error: error.message });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  #configureHttp() {
    this.app.disable('x-powered-by');

    // Liveness/diagnostics. `curl http://127.0.0.1:3000/health` is the fastest
    // way for a user to answer "is the bridge up and does it see my browser?".
    this.app.get('/health', (_req, res) => {
      res.json({ ok: true, ...this.status() });
    });

    // Optional debugging view of pushed captures. Off unless explicitly enabled,
    // because it would otherwise expose scraped page content to any local process.
    // `attachInbox()` supplies the data source; without it the route reports empty.
    if (config.exposeCapturesOverHttp) {
      this.app.get('/captures', (_req, res) => {
        res.json({ ok: true, captures: this.inbox ? this.inbox.list() : [] });
      });
    }

    this.app.use((_req, res) => {
      res.status(404).json({ ok: false, error: 'not_found' });
    });
  }

  #configureUpgrade() {
    // Manual upgrade handling (rather than `new WebSocketServer({ server })`)
    // so we can validate the handshake and answer with a meaningful HTTP status.
    this.httpServer.on('upgrade', (request, socket, head) => {
      let url;
      try {
        url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
      } catch {
        return rejectUpgrade(socket, 400, 'Bad Request');
      }

      if (!config.allowedPaths.includes(url.pathname)) {
        logger.warn('upgrade rejected: path', { path: url.pathname });
        return rejectUpgrade(socket, 404, 'Not Found');
      }

      const origin = request.headers.origin;
      if (!originAllowed(origin, this.allowedOrigins)) {
        logger.warn('upgrade rejected: origin not allowed', { origin: origin ?? '(none)' });
        return rejectUpgrade(socket, 403, 'Forbidden');
      }

      if (this.token) {
        const presented = url.searchParams.get('token') ?? '';
        if (!presented || !secretsMatch(presented, this.token)) {
          logger.warn('upgrade rejected: bad token', { origin });
          return rejectUpgrade(socket, 401, 'Unauthorized');
        }
      }

      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.wss.emit('connection', ws, request);
      });
    });
  }

  #configureSocketEvents() {
    this.wss.on('connection', (ws, request) => {
      /** @type {ClientRecord} */
      const record = {
        id: randomUUID().slice(0, 8),
        ws,
        origin: request.headers.origin ?? '(none)',
        connectedAt: Date.now(),
        lastSeenAt: Date.now(),
        isAlive: true,
        agent: 'unknown',
        version: 'unknown',
      };
      this.clients.set(ws, record);
      logger.info('extension connected', { client: record.id, origin: record.origin });
      this.emit('connect', record);

      ws.on('pong', () => {
        record.isAlive = true;
        record.lastSeenAt = Date.now();
      });

      ws.on('message', (data) => {
        record.lastSeenAt = Date.now();
        this.#handleMessage(record, data);
      });

      ws.on('error', (error) => {
        logger.debug('socket error', { client: record.id, error: error.message });
      });

      ws.on('close', (code, reason) => {
        this.clients.delete(ws);
        logger.info('extension disconnected', {
          client: record.id,
          code,
          reason: reason?.toString?.() || '',
        });

        // Anything we were waiting on from this socket can never arrive now.
        for (const [id, entry] of this.pending) {
          if (entry.socket !== ws) continue;
          clearTimeout(entry.timer);
          this.pending.delete(id);
          entry.reject(
            new BridgeError(
              ERROR_CODE.DISCONNECTED,
              `The extension disconnected while "${entry.method}" was in flight.`,
            ),
          );
        }

        this.emit('disconnect', record);
      });
    });

    this.wss.on('error', (error) => {
      logger.exception('websocket server error', error);
    });
  }

  #handleMessage(record, data) {
    const envelope = parseEnvelope(data);
    if (!envelope) {
      logger.warn('dropped unparseable frame', { client: record.id });
      return;
    }

    if (is.hello(envelope)) {
      record.agent = String(envelope.agent ?? 'unknown');
      record.version = String(envelope.version ?? 'unknown');
      logger.info('extension identified', {
        client: record.id,
        agent: record.agent,
        version: record.version,
      });
      this.emit('hello', record, envelope);
      return;
    }

    if (is.response(envelope)) {
      const entry = this.pending.get(envelope.id);
      if (!entry) {
        // Late response after a timeout, or a duplicate. Not fatal.
        logger.debug('response for unknown/expired request', { id: envelope.id });
        return;
      }
      clearTimeout(entry.timer);
      this.pending.delete(envelope.id);
      logger.debug('<- response', {
        id: envelope.id,
        method: entry.method,
        ok: envelope.ok,
        ms: Date.now() - entry.startedAt,
      });

      if (envelope.ok) {
        entry.resolve(envelope.result ?? {});
      } else {
        const err = envelope.error ?? {};
        entry.reject(
          new BridgeError(err.code ?? ERROR_CODE.INTERNAL, err.message ?? 'Extension reported an error.', err.details),
        );
      }
      return;
    }

    if (is.event(envelope)) {
      logger.debug('<- event', { event: envelope.event, client: record.id });
      this.emit('event', envelope.event, envelope.payload, record);
      this.emit(`event:${envelope.event}`, envelope.payload, record);
      return;
    }

    if (is.request(envelope)) {
      // Reserved: the extension asking the server for something. Nothing needs
      // it today, so answer explicitly rather than leaving the caller hanging.
      try {
        record.ws.send(
          JSON.stringify({
            t: 'res',
            id: envelope.id,
            ok: false,
            error: { code: ERROR_CODE.UNKNOWN_METHOD, message: 'Server exposes no callable methods.' },
          }),
        );
      } catch {
        /* socket gone */
      }
      return;
    }

    logger.debug('ignored envelope', { t: envelope.t });
  }

  #startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      for (const record of this.clients.values()) {
        if (!record.isAlive) {
          // Missed the previous round trip: the socket is half-open (laptop
          // slept, network stack died). Terminate so `close` fires and pending
          // requests get rejected instead of hanging until their timeout.
          logger.warn('terminating unresponsive client', { client: record.id });
          record.ws.terminate();
          continue;
        }
        record.isAlive = false;
        try {
          record.ws.ping();
        } catch {
          /* will be reaped next tick */
        }
      }
    }, config.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }
}

export { METHOD };
