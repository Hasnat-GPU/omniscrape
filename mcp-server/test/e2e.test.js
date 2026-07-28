/**
 * End-to-end test for the MCP server + bridge.
 *
 * Spawns the real server as a child process, speaks real MCP JSON-RPC over its
 * stdio, and connects a fake "extension" over the real WebSocket — so this
 * exercises the actual wiring, not mocks of it.
 *
 * Run with:  node --test test/
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(here, '..', 'src', 'index.js');

/**
 * Ask the OS for a free port instead of hardcoding one. A hardcoded port makes
 * a leaked server from a previous run answer this run's health check, and the
 * suite then tests a zombie: HTTP and WebSocket assertions pass while every
 * stdio assertion times out, because the child that owns *this* stdin died on
 * EADDRINUSE. That is a genuinely confusing hour to lose.
 */
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

let PORT;
let WS_URL;
let HTTP_URL;
const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

/** Minimal MCP client speaking newline-delimited JSON-RPC over a child's stdio. */
class StdioClient {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.buffer = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      this.buffer += chunk;
      let index;
      while ((index = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (line) this.#handleLine(line);
      }
    });
  }

  #handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      throw new Error(`Server wrote non-JSON to stdout (this corrupts MCP): ${line}`);
    }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error.code}: ${message.error.message}`));
      else resolve(message.result);
    } else if (message.method) {
      this.notifications.push(message);
    }
  }

  request(method, params = {}) {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request "${method}" timed out`));
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
      this.child.stdin.write(payload + '\n');
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }
}

/** Fake extension: answers bridge requests the way the real one will. */
class FakeExtension {
  constructor(ws) {
    this.ws = ws;
    this.received = [];
    this.handlers = new Map();
    ws.on('message', (raw) => {
      const envelope = JSON.parse(raw.toString('utf8'));
      this.received.push(envelope);
      if (envelope.t !== 'req') return;
      const handler = this.handlers.get(envelope.method);
      if (!handler) {
        this.send({ t: 'res', id: envelope.id, ok: false, error: { code: 'unknown_method', message: 'nope' } });
        return;
      }
      // Start the chain with an empty promise so a *synchronous* throw from a
      // handler is captured too. `Promise.resolve(handler(...))` would let it
      // escape the ws 'message' callback as an uncaughtException, killing this
      // socket and every later test that depends on it.
      Promise.resolve()
        .then(() => handler(envelope.params))
        .then(
          (result) => this.send({ t: 'res', id: envelope.id, ok: true, result }),
          (error) =>
            this.send({
              t: 'res',
              id: envelope.id,
              ok: false,
              error: { code: 'scrape_failed', message: error.message },
            }),
        );
    });
  }

  on(method, handler) {
    this.handlers.set(method, handler);
  }

  send(envelope) {
    this.ws.send(JSON.stringify(envelope));
  }

  close() {
    return new Promise((resolve) => {
      this.ws.once('close', resolve);
      this.ws.close();
    });
  }

  static async connect(url = WS_URL, origin = EXT_ORIGIN) {
    const ws = new WebSocket(url, { origin });
    await once(ws, 'open');
    return new FakeExtension(ws);
  }
}

let child;
let client;
let stderr = '';

describe('OmniScrape MCP server (end to end)', () => {
  before(async () => {
    PORT = await freePort();
    WS_URL = `ws://127.0.0.1:${PORT}`;
    HTTP_URL = `http://127.0.0.1:${PORT}`;

    child = spawn(process.execPath, [serverEntry], {
      env: {
        ...process.env,
        OMNISCRAPE_PORT: String(PORT),
        OMNISCRAPE_LOG_LEVEL: 'debug',
        OMNISCRAPE_HEARTBEAT_MS: '1000',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    let exited = null;
    child.on('exit', (code, signal) => {
      exited = { code, signal };
    });

    client = new StdioClient(child);

    // Wait for the bridge to bind before any test tries to connect to it.
    const deadline = Date.now() + 10_000;
    for (;;) {
      // Check this first: if the child died, a passing health check means we
      // are talking to somebody else's server, and every stdio test will hang.
      if (exited) {
        throw new Error(
          `Server exited during startup (code=${exited.code}, signal=${exited.signal}).\nstderr:\n${stderr}`,
        );
      }
      try {
        const response = await fetch(`${HTTP_URL}/health`);
        if (response.ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`Server never came up.\nstderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  });

  after(async () => {
    // SIGTERM, then make sure it is really gone — a leaked server child holds
    // its port and poisons the next run.
    child?.kill('SIGTERM');
    if (child && child.exitCode === null && child.signalCode === null) {
      await Promise.race([once(child, 'exit'), new Promise((r) => setTimeout(r, 3_000))]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });

  it('completes the MCP initialize handshake', async () => {
    const result = await client.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'omniscrape-test', version: '0.0.0' },
    });
    client.notify('notifications/initialized');

    assert.equal(result.serverInfo.name, 'omniscrape');
    assert.ok(result.capabilities.tools, 'should advertise tools');
    assert.ok(result.capabilities.resources, 'should advertise resources');
    assert.match(result.instructions, /OmniScrape/);
  });

  it('advertises exactly the expected tools with input schemas', async () => {
    const { tools } = await client.request('tools/list');
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['get_active_tab_markdown', 'get_bridge_status', 'scrape_selected_elements']);

    const page = tools.find((t) => t.name === 'get_active_tab_markdown');
    assert.deepEqual(
      Object.keys(page.inputSchema.properties).sort(),
      ['include_links', 'max_chars', 'tab_id', 'use_readability'],
    );
    // tab_id is the only genuinely optional-with-no-default field.
    assert.ok(!(page.inputSchema.required ?? []).includes('tab_id'));
  });

  it('reports a disconnected bridge with actionable guidance', async () => {
    const result = await client.request('tools/call', {
      name: 'get_bridge_status',
      arguments: {},
    });
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.extension_connected, false);
    assert.equal(payload.client_count, 0);
    assert.match(payload.hint, /Load unpacked/);
  });

  it('fails a scrape with a helpful error when no extension is connected', async () => {
    const result = await client.request('tools/call', {
      name: 'get_active_tab_markdown',
      arguments: {},
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /not_connected/);
    assert.match(result.content[0].text, /chrome:\/\/extensions/);
  });

  it('rejects a WebSocket from a non-extension origin', async () => {
    const ws = new WebSocket(WS_URL, { origin: 'https://evil.example.com' });
    const [error] = await once(ws, 'error');
    assert.match(error.message, /403/);
  });

  it('rejects a WebSocket with no Origin header', async () => {
    const ws = new WebSocket(WS_URL);
    const [error] = await once(ws, 'error');
    assert.match(error.message, /403/);
  });

  describe('with an extension connected', () => {
    let ext;

    before(async () => {
      ext = await FakeExtension.connect();
      ext.send({ t: 'hello', role: 'extension', version: '0.1.0', agent: 'fake-chrome' });

      ext.on('page.markdown', (params) => ({
        url: 'https://example.com/article',
        title: 'A Test Article',
        timestamp: '2026-07-27T12:00:00.000Z',
        markdown_content: `# Heading\n\nBody text. readability=${params.useReadability} links=${params.includeLinks}`,
        extracted_fields: [],
        meta: { readability_applied: params.useReadability, word_count: 7, truncated: false },
      }));

      ext.on('selection.scrape', (params) => ({
        url: 'https://shop.example.com/list',
        title: 'Products',
        timestamp: '2026-07-27T12:05:00.000Z',
        markdown_content: '',
        extracted_fields: [
          {
            label: 'price',
            selector: '.product > .price',
            match_count: 3,
            values: [{ [params.format]: '$10' }, { [params.format]: '$20' }, { [params.format]: '$30' }],
          },
        ],
        meta: { mode: 'selection', format: params.format },
      }));

      ext.on('bridge.ping', () => ({ pong: true, tabs: [{ id: 42, title: 'A Test Article' }] }));

      // Give the server a moment to process the hello frame.
      await new Promise((r) => setTimeout(r, 150));
    });

    after(async () => {
      await ext?.close();
    });

    it('shows the connection on /health', async () => {
      const response = await fetch(`${HTTP_URL}/health`);
      const body = await response.json();
      assert.equal(body.extension_connected, true);
      assert.equal(body.client_count, 1);
      assert.equal(body.clients[0].agent, 'fake-chrome');
      assert.equal(body.clients[0].origin, EXT_ORIGIN);
    });

    it('round-trips get_active_tab_markdown through the bridge', async () => {
      const result = await client.request('tools/call', {
        name: 'get_active_tab_markdown',
        arguments: { use_readability: true, include_links: false },
      });
      assert.notEqual(result.isError, true);
      const out = result.content[0].text;
      assert.match(out, /url: https:\/\/example\.com\/article/);
      assert.match(out, /title: A Test Article/);
      assert.match(out, /extraction: mozilla-readability \+ turndown/);
      assert.match(out, /# Heading/);
      // Defaults must reach the extension, and explicit args must win.
      assert.match(out, /readability=true links=false/);
    });

    it('applies schema defaults when arguments are omitted', async () => {
      await client.request('tools/call', { name: 'get_active_tab_markdown', arguments: {} });
      const request = ext.received.filter((e) => e.method === 'page.markdown').at(-1);
      assert.equal(request.params.useReadability, true);
      assert.equal(request.params.includeLinks, true);
      assert.equal(request.params.maxChars, 100_000);
    });

    it('round-trips scrape_selected_elements and returns structured records', async () => {
      const result = await client.request('tools/call', {
        name: 'scrape_selected_elements',
        arguments: { format: 'text', include_attributes: true },
      });
      assert.notEqual(result.isError, true);
      const out = result.content[0].text;
      assert.match(out, /Extracted 1 field from https:\/\/shop\.example\.com\/list/);
      assert.match(out, /price \(\.product > \.price\) -> 3 matches/);

      const json = JSON.parse(out.slice(out.indexOf('```json') + 7, out.lastIndexOf('```')));
      assert.equal(json.extracted_fields[0].values.length, 3);
      assert.equal(json.extracted_fields[0].values[0].text, '$10');
      assert.equal(json.meta.format, 'text');
    });

    it('probes the extension from get_bridge_status', async () => {
      const result = await client.request('tools/call', {
        name: 'get_bridge_status',
        arguments: { probe: true },
      });
      const payload = JSON.parse(result.content[0].text);
      assert.equal(payload.extension_connected, true);
      assert.deepEqual(payload.probe, { pong: true, tabs: [{ id: 42, title: 'A Test Article' }] });
    });

    it('surfaces an extension-side failure as a tool error', async () => {
      ext.on('page.markdown', () => {
        throw new Error('DOM went sideways');
      });
      const result = await client.request('tools/call', {
        name: 'get_active_tab_markdown',
        arguments: {},
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /scrape_failed/);
      assert.match(result.content[0].text, /DOM went sideways/);
    });

    it('accepts a pushed capture and exposes it as a resource', async () => {
      const before = client.notifications.length;

      ext.send({
        t: 'evt',
        event: 'capture',
        payload: {
          url: 'https://news.example.com/story',
          title: 'Pushed Story',
          timestamp: '2026-07-27T12:30:00.000Z',
          markdown_content: '# Pushed\n\nSent with the button.',
          extracted_fields: [],
          meta: { source: 'send-to-claude' },
        },
      });

      await new Promise((r) => setTimeout(r, 200));

      // The server should have told the client the resource list changed.
      const changed = client.notifications
        .slice(before)
        .some((n) => n.method === 'notifications/resources/list_changed');
      assert.ok(changed, 'expected a resources/list_changed notification');

      const index = await client.request('resources/read', { uri: 'omniscrape://captures' });
      const parsed = JSON.parse(index.contents[0].text);
      assert.equal(parsed.count, 1);
      assert.equal(parsed.captures[0].url, 'https://news.example.com/story');

      const latest = await client.request('resources/read', { uri: 'omniscrape://captures/latest' });
      assert.match(latest.contents[0].text, /Pushed Story/);
      assert.match(latest.contents[0].text, /Sent with the button\./);

      const listed = await client.request('resources/list');
      const one = listed.resources.find((r) => r.uri.startsWith('omniscrape://captures/') && r.name === 'Pushed Story');
      assert.ok(one, 'the pushed capture should be enumerable');

      const byId = await client.request('resources/read', { uri: one.uri });
      assert.match(byId.contents[0].text, /Sent with the button\./);
    });

    it('normalises a malformed capture instead of dropping it', async () => {
      ext.send({ t: 'evt', event: 'capture', payload: { url: 'https://partial.example.com' } });
      await new Promise((r) => setTimeout(r, 150));
      const index = await client.request('resources/read', { uri: 'omniscrape://captures' });
      const parsed = JSON.parse(index.contents[0].text);
      assert.equal(parsed.captures[0].url, 'https://partial.example.com');
      assert.equal(parsed.captures[0].markdown_chars, 0);
      assert.equal(parsed.captures[0].field_count, 0);
    });

    it('ignores unparseable frames without dropping the connection', async () => {
      ext.ws.send('this is not json at all');
      ext.ws.send(JSON.stringify({ nonsense: true }));
      await new Promise((r) => setTimeout(r, 150));
      const response = await fetch(`${HTTP_URL}/health`);
      const body = await response.json();
      assert.equal(body.extension_connected, true, 'connection should survive garbage frames');
    });
  });

  it('rejects in-flight requests when the extension disconnects mid-call', async () => {
    const ext = await FakeExtension.connect();
    // Register no handler for page.markdown; instead drop the socket on receipt.
    ext.ws.removeAllListeners('message');
    ext.ws.on('message', () => ext.ws.terminate());

    await new Promise((r) => setTimeout(r, 100));

    const result = await client.request('tools/call', {
      name: 'get_active_tab_markdown',
      arguments: {},
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /disconnected|not_connected/);
  });

  it('never wrote anything to stdout that was not JSON-RPC', () => {
    // StdioClient.#handleLine throws on non-JSON, so reaching here already
    // proves it. Assert the logs went to stderr instead, as designed.
    assert.match(stderr, /\[omniscrape\]/);
    assert.match(stderr, /bridge listening/);
  });
});

/**
 * The bridge needs a specific TCP port; MCP does not. Losing the port must not
 * cost the client its tools, because a server that exits during the handshake
 * registers nothing and is indistinguishable from a server that was never
 * configured — the agent is left with no way to say why. Everything here failed
 * before the transports were reordered in index.js.
 */
describe('OmniScrape MCP server (bridge port already taken)', () => {
  let squatter;
  let squattedPort;
  let child;
  let client;
  let stderr = '';
  let exited = null;

  before(async () => {
    squattedPort = await freePort();

    // Hold the port for real, rather than mocking the failure.
    squatter = createServer();
    await new Promise((resolve, reject) => {
      squatter.once('error', reject);
      squatter.listen(squattedPort, '127.0.0.1', resolve);
    });

    child = spawn(process.execPath, [serverEntry], {
      env: {
        ...process.env,
        OMNISCRAPE_PORT: String(squattedPort),
        OMNISCRAPE_LOG_LEVEL: 'debug',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('exit', (code, signal) => {
      exited = { code, signal };
    });

    client = new StdioClient(child);
  });

  after(async () => {
    child?.kill('SIGTERM');
    if (child && child.exitCode === null && child.signalCode === null) {
      await Promise.race([once(child, 'exit'), new Promise((r) => setTimeout(r, 3_000))]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await new Promise((resolve) => squatter.close(resolve));
  });

  it('stays alive instead of exiting on EADDRINUSE', async () => {
    const result = await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'degraded-test', version: '0.0.0' },
    });
    assert.equal(exited, null, `Server exited on a busy port.\nstderr:\n${stderr}`);
    assert.equal(result.serverInfo.name, 'omniscrape');
  });

  it('still advertises every tool, so the agent can ask what went wrong', async () => {
    const { tools } = await client.request('tools/list');
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ['get_active_tab_markdown', 'get_bridge_status', 'scrape_selected_elements'],
    );
  });

  it('reports the port clash through get_bridge_status', async () => {
    const result = await client.request('tools/call', {
      name: 'get_bridge_status',
      arguments: { probe: false },
    });
    const status = JSON.parse(result.content[0].text);

    assert.equal(status.listening, false);
    assert.match(status.start_error, /already in use/i);
    assert.match(status.start_error, new RegExp(String(squattedPort)));
    // The advice must be about the port, not about loading the extension.
    assert.match(status.hint, /not listening/i);
  });

  it('blames the bridge, not Chrome, when a scrape is attempted', async () => {
    const result = await client.request('tools/call', {
      name: 'get_active_tab_markdown',
      arguments: {},
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /not listening/i);
    assert.doesNotMatch(result.content[0].text, /popup shows "Connected"/);
  });

  it('logged the failure to stderr without corrupting the MCP channel', () => {
    assert.match(stderr, /bridge failed to start/i);
  });
});
