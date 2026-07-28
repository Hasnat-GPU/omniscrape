/**
 * Integration test for the extension's WebSocket client against the real server.
 *
 * Imports the shipped `background/bridge-client.js` unchanged and points it at a
 * genuinely spawned MCP server, then drives that *same* server process over its
 * stdio — so a tool call travels the whole path it does in production:
 *
 *   MCP JSON-RPC on stdin -> server -> WebSocket -> BridgeClient -> handler
 *                                                                    |
 *   MCP result on stdout  <- server <- WebSocket <--------------------+
 *
 * Only two things are shimmed, both because Node is not a browser:
 *   - `WebSocket` — Node's global sends no Origin header and the bridge requires
 *     a `chrome-extension://` one. Using `ws` to supply it means the real
 *     handshake is exercised rather than bypassed.
 *   - `chrome.runtime.getManifest()` — read once, for the hello frame.
 *
 * The reconnect test is the point of the whole file: "gracefully handles
 * connection drops" can only be checked by actually dropping the connection.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import WSWebSocket from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(here, '..', 'mcp-server', 'src', 'index.js');
const EXT_ORIGIN = 'chrome-extension://testtesttesttesttesttesttesttest';

// --- Browser shims, installed before the client module is imported ----------

/** `ws`, but always presenting an extension origin like Chrome would. */
class OriginWebSocket extends WSWebSocket {
  constructor(url, protocols) {
    super(url, protocols, { origin: EXT_ORIGIN });
  }
}
globalThis.WebSocket = OriginWebSocket;
globalThis.chrome = { runtime: { getManifest: () => ({ version: '0.1.0' }) } };

const { BridgeClient, STATE } = await import('../extension/background/bridge-client.js');

// --- Server harness ---------------------------------------------------------

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * A running server plus an MCP session attached to its stdio.
 * Keeping both together is what lets a test call a tool on the very process the
 * bridge client is connected to.
 */
class ServerHandle {
  constructor(child, port) {
    this.child = child;
    this.port = port;
    this.buffer = '';
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      this.buffer += chunk;
      let index;
      while ((index = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        const entry = this.pending.get(message.id);
        if (!entry) continue;
        this.pending.delete(message.id);
        if (message.error) entry.reject(new Error(message.error.message));
        else entry.resolve(message.result);
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      this.stderr += chunk;
    });
  }

  request(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`MCP "${method}" timed out`));
      }, 15_000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async initialize() {
    await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'bridge-test', version: '0' },
    });
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  }

  callTool(name, args = {}) {
    return this.request('tools/call', { name, arguments: args });
  }

  async readResource(uri) {
    const result = await this.request('resources/read', { uri });
    return result.contents[0].text;
  }

  health() {
    return fetch(`http://127.0.0.1:${this.port}/health`).then((r) => r.json());
  }

  async stop() {
    if (this.child.exitCode !== null) return;
    this.child.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill('SIGKILL');
        resolve();
      }, 3_000);
      this.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

async function startServer(port, env = {}) {
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, OMNISCRAPE_PORT: String(port), OMNISCRAPE_LOG_LEVEL: 'warn', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const handle = new ServerHandle(child, port);

  let exited = null;
  child.on('exit', (code, signal) => {
    exited = { code, signal };
  });

  const deadline = Date.now() + 10_000;
  for (;;) {
    if (exited) throw new Error(`server exited (${exited.code}/${exited.signal}):\n${handle.stderr}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) break;
    } catch {
      /* not yet */
    }
    if (Date.now() > deadline) throw new Error(`server never started:\n${handle.stderr}`);
    await new Promise((r) => setTimeout(r, 80));
  }

  await handle.initialize();
  return handle;
}

/** Poll until `predicate` is true, or fail with a useful message. */
async function waitFor(predicate, { timeout = 8_000, interval = 60, what = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

// ---------------------------------------------------------------------------

describe('extension bridge client', () => {
  let port;
  let server;
  let client;
  const requests = [];
  let handler = async () => ({});

  before(async () => {
    port = await freePort();
    server = await startServer(port);

    client = new BridgeClient({
      getSettings: async () => ({ url: `ws://127.0.0.1:${port}`, token: '' }),
      onRequest: async (method, params) => {
        requests.push({ method, params });
        return handler(method, params);
      },
    });
    await client.connect({ manual: true });
    await waitFor(() => client.state === STATE.CONNECTED, { what: 'the client to connect' });
  });

  after(async () => {
    client?.disconnect();
    await server?.stop();
  });

  it('completes the handshake and identifies itself', async () => {
    const body = await server.health();
    assert.equal(body.extension_connected, true);
    assert.equal(body.client_count, 1);
    assert.equal(body.clients[0].origin, EXT_ORIGIN);
    assert.equal(body.clients[0].agent, 'chrome-mv3');
    assert.equal(body.clients[0].version, '0.1.0');
  });

  it('answers a tool call end to end, through the real socket', async () => {
    handler = async (method, params) => ({
      url: 'https://example.com',
      title: 'Example',
      timestamp: '2026-07-27T00:00:00.000Z',
      markdown_content: `# Example\n\nmethod=${method} readability=${params.useReadability}`,
      extracted_fields: [],
      meta: { readability_applied: true, word_count: 4 },
    });

    const result = await server.callTool('get_active_tab_markdown', { use_readability: true });
    assert.notEqual(result.isError, true);
    assert.match(result.content[0].text, /method=page\.markdown readability=true/);
    assert.match(result.content[0].text, /url: https:\/\/example\.com/);
    assert.equal(requests.at(-1).method, 'page.markdown');
  });

  it('passes tool arguments through to the handler', async () => {
    await server.callTool('scrape_selected_elements', { format: 'text', include_attributes: true });
    const last = requests.at(-1);
    assert.equal(last.method, 'selection.scrape');
    assert.equal(last.params.format, 'text');
    assert.equal(last.params.includeAttributes, true);
  });

  it('propagates a handler failure with its error code and guidance', async () => {
    handler = async () => {
      const error = new Error('The page blocked content scripts.');
      error.code = 'content_script_unavailable';
      throw error;
    };

    const result = await server.callTool('get_active_tab_markdown', {});
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /content_script_unavailable/);
    assert.match(result.content[0].text, /blocked content scripts/);
    assert.match(result.content[0].text, /reload the tab/i);

    handler = async () => ({});
  });

  it('reports reachable tabs through get_bridge_status', async () => {
    handler = async (method) => {
      if (method === 'bridge.ping') return { pong: true, tabs: [{ id: 7, title: 'Example', active: true }] };
      return {};
    };

    const result = await server.callTool('get_bridge_status', { probe: true });
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.extension_connected, true);
    assert.equal(payload.probe.pong, true);
    assert.equal(payload.probe.tabs[0].id, 7);
  });

  it('pushes a capture event that lands in the server inbox', async () => {
    const sent = client.sendEvent('capture', {
      url: 'https://news.example.com/a',
      title: 'Pushed',
      timestamp: '2026-07-27T00:00:00.000Z',
      markdown_content: '# Pushed\n\nfrom the button',
      extracted_fields: [],
      meta: { source: 'send-to-claude' },
    });
    assert.equal(sent, true);

    await waitFor(
      async () => JSON.parse(await server.readResource('omniscrape://captures')).count === 1,
      { what: 'the capture to reach the inbox' },
    );

    const latest = await server.readResource('omniscrape://captures/latest');
    assert.match(latest, /Pushed/);
    assert.match(latest, /from the button/);
  });

  it('reconnects on its own after the server goes away and comes back', async () => {
    await server.stop();
    await waitFor(() => client.state === STATE.DISCONNECTED, { what: 'the client to notice the drop' });
    assert.equal(client.status().connected, false);

    // Same port, fresh process — exactly what happens when Claude restarts.
    server = await startServer(port);

    await waitFor(() => client.state === STATE.CONNECTED, {
      timeout: 20_000,
      what: 'the client to reconnect by itself',
    });

    const body = await server.health();
    assert.equal(body.extension_connected, true, 'the new server should see the reconnected client');
    assert.equal(body.clients[0].agent, 'chrome-mv3');

    // And it must actually work again, not merely report connected.
    handler = async () => ({
      url: 'https://after-restart.example.com',
      title: 'After restart',
      timestamp: '2026-07-27T00:00:00.000Z',
      markdown_content: 'still working',
      extracted_fields: [],
      meta: {},
    });
    const result = await server.callTool('get_active_tab_markdown', {});
    assert.match(result.content[0].text, /still working/);
  });

  it('stays down after an explicit disconnect', async () => {
    client.disconnect();
    await waitFor(async () => (await server.health()).client_count === 0, {
      what: 'the server to drop the client',
    });

    // Well past the initial backoff, so an armed retry would have fired.
    await new Promise((r) => setTimeout(r, 2_500));
    assert.equal(client.state, STATE.DISCONNECTED, 'must not auto-reconnect after a manual stop');
    assert.equal((await server.health()).client_count, 0);
  });

  it('reconnects when explicitly asked after a manual disconnect', async () => {
    await client.connect({ manual: true });
    await waitFor(() => client.state === STATE.CONNECTED, { what: 'a manual reconnect' });
    assert.equal((await server.health()).client_count, 1);
  });

  it('opens exactly one socket when several callers connect at once', async () => {
    // Regression: a service-worker start calls bootstrap() from module top
    // level *and* from onInstalled/onStartup, and the alarm can land on top.
    // Each call used to clear the `this.ws` guard while awaiting settings and
    // then open its own socket, leaving orphans that never sent a hello — the
    // server saw three clients for one browser, two of them reporting
    // agent "unknown". Observed live before this was fixed.
    client.disconnect();
    await waitFor(async () => (await server.health()).client_count === 0, {
      what: 'a clean slate',
    });

    await Promise.all([
      client.connect({ manual: true }),
      client.connect(),
      client.connect(),
      client.connect(),
    ]);
    await waitFor(() => client.state === STATE.CONNECTED, { what: 'the shared attempt to connect' });

    // Let any orphan finish its handshake so it would be counted if it existed.
    await new Promise((r) => setTimeout(r, 600));

    const body = await server.health();
    assert.equal(body.client_count, 1, `expected exactly one client, got ${body.client_count}`);
    // Every connection must have identified itself; "unknown" is the signature
    // of a socket nobody claimed.
    for (const c of body.clients) {
      assert.equal(c.agent, 'chrome-mv3', 'an unclaimed socket leaked through');
      assert.equal(c.version, '0.1.0');
    }
  });
});

describe('extension bridge client: token auth', () => {
  let port;
  let server;
  let client;

  before(async () => {
    port = await freePort();
    server = await startServer(port, { OMNISCRAPE_TOKEN: 'correct-horse-battery-staple' });
  });

  after(async () => {
    client?.disconnect();
    await server?.stop();
  });

  it('is rejected when the token is wrong', async () => {
    const rejected = new BridgeClient({
      getSettings: async () => ({ url: `ws://127.0.0.1:${port}`, token: 'wrong' }),
      onRequest: async () => ({}),
    });
    await rejected.connect({ manual: true });

    // It never reaches CONNECTED; it just keeps retrying against a 401.
    await new Promise((r) => setTimeout(r, 1_200));
    assert.notEqual(rejected.state, STATE.CONNECTED);
    assert.equal((await server.health()).client_count, 0);
    rejected.disconnect();
  });

  it('connects when the token matches', async () => {
    client = new BridgeClient({
      getSettings: async () => ({ url: `ws://127.0.0.1:${port}`, token: 'correct-horse-battery-staple' }),
      onRequest: async () => ({}),
    });
    await client.connect({ manual: true });
    await waitFor(() => client.state === STATE.CONNECTED, { what: 'a token-authenticated connection' });
    assert.equal((await server.health()).client_count, 1);
  });
});
