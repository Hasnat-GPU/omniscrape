/**
 * Static integrity checks for the extension package.
 *
 * These catch the failures that are invisible until you load the thing in
 * Chrome and stare at a blank panel: a renamed file the manifest still points
 * at, an inline script the extension CSP silently refuses to run, or the two
 * copies of the wire protocol drifting apart.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const EXT = path.join(ROOT, 'extension');

const manifest = JSON.parse(readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
const exists = (rel) => existsSync(path.join(EXT, rel));

describe('manifest', () => {
  it('is Manifest V3 with the identity fields Chrome requires', () => {
    assert.equal(manifest.manifest_version, 3);
    assert.ok(manifest.name);
    assert.match(manifest.version, /^\d+(\.\d+)*$/);
    assert.ok(manifest.description.length <= 132, 'Chrome truncates descriptions over 132 chars');
  });

  it('declares a module service worker that exists', () => {
    assert.equal(manifest.background.type, 'module', 'the worker uses ES imports');
    assert.ok(exists(manifest.background.service_worker));
  });

  it('points at a side panel that exists', () => {
    assert.ok(manifest.side_panel?.default_path);
    assert.ok(exists(manifest.side_panel.default_path));
    // sidePanel is a Chrome 114 API; without the floor, older Chrome installs
    // the extension and then fails at runtime with no useful message.
    assert.ok(Number(manifest.minimum_chrome_version) >= 114);
  });

  it('points at an options page that exists', () => {
    assert.ok(exists(manifest.options_page));
  });

  it('ships every icon size it declares', () => {
    for (const source of [manifest.icons, manifest.action.default_icon]) {
      for (const [size, file] of Object.entries(source)) {
        assert.ok(exists(file), `missing icon ${size}: ${file}`);
        const bytes = readFileSync(path.join(EXT, file));
        assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${file} is not a PNG`);
        assert.equal(bytes.readUInt32BE(16), Number(size), `${file} is not ${size}px wide`);
      }
    }
  });

  it('requests the permissions the code actually uses, and no more', () => {
    const declared = new Set(manifest.permissions);
    for (const needed of ['activeTab', 'scripting', 'storage', 'sidePanel', 'alarms']) {
      assert.ok(declared.has(needed), `missing permission: ${needed}`);
    }
    // Host access is optional on purpose: it is requested from a button, so the
    // extension installs without the "read all your data" warning.
    assert.ok(!manifest.host_permissions, 'host access must stay optional');
    assert.deepEqual(manifest.optional_host_permissions, ['http://*/*', 'https://*/*']);
  });

  it('declares the keyboard command the service worker listens for', () => {
    assert.ok(manifest.commands?.['toggle-selection']);
    const worker = readFileSync(path.join(EXT, manifest.background.service_worker), 'utf8');
    assert.match(worker, /toggle-selection/);
  });
});

describe('script references', () => {
  /** Every file the service worker injects must be present, in order. */
  it('injects vendor libraries and the content script, all of which exist', () => {
    const worker = readFileSync(path.join(EXT, manifest.background.service_worker), 'utf8');

    // The worker has more than one `files: [...]` array (insertCSS has one too),
    // so pick the one carrying JavaScript rather than assuming an order.
    const blocks = [...worker.matchAll(/files:\s*\[([^\]]*)\]/gs)].map((m) => m[1]);
    const jsBlock = blocks.find((block) => /\.js'/.test(block));
    assert.ok(jsBlock, 'no executeScript files array found in the service worker');

    const files = [...jsBlock.matchAll(/'([^']+\.js)'/g)].map((m) => m[1]);

    assert.ok(files.length >= 5, `expected the vendor set plus selector.js, got ${files.join(', ')}`);
    for (const file of files) assert.ok(exists(file), `injected file missing: ${file}`);

    // selector.js depends on globals the vendor files define, so it must be last.
    assert.equal(files.at(-1), 'content/selector.js');
  });

  it('injects a stylesheet that exists', () => {
    const worker = readFileSync(path.join(EXT, manifest.background.service_worker), 'utf8');
    const match = worker.match(/insertCSS\([^)]*files:\s*\['([^']+)'\]/s);
    assert.ok(match, 'expected an insertCSS call');
    assert.ok(exists(match[1]));
  });

  it('resolves every href/src in the HTML pages', () => {
    for (const page of ['sidepanel/index.html', 'options/index.html']) {
      const dir = path.dirname(path.join(EXT, page));
      const html = readFileSync(path.join(EXT, page), 'utf8');
      const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);

      assert.ok(refs.length > 0, `${page} references nothing`);
      for (const ref of refs) {
        if (/^(https?:|data:|#)/.test(ref)) continue;
        assert.ok(existsSync(path.resolve(dir, ref)), `${page} references missing file: ${ref}`);
      }
    }
  });

  it('has no inline scripts or event handlers, which the extension CSP blocks', () => {
    for (const page of ['sidepanel/index.html', 'options/index.html']) {
      const html = readFileSync(path.join(EXT, page), 'utf8');

      // <script> with a body rather than a src= is refused outright by MV3.
      const inline = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].filter(
        (m) => m[1].trim().length > 0,
      );
      assert.equal(inline.length, 0, `${page} has an inline <script>`);

      const handlers = html.match(/\son(click|change|input|submit|load|error)=/g);
      assert.equal(handlers, null, `${page} has an inline event handler: ${handlers?.join(', ')}`);
    }
  });

  it('imports only files that exist, from every ES module', () => {
    const modules = [
      'background/service-worker.js',
      'background/bridge-client.js',
      'sidepanel/sidepanel.js',
      'options/options.js',
    ];
    for (const rel of modules) {
      const dir = path.dirname(path.join(EXT, rel));
      const source = readFileSync(path.join(EXT, rel), 'utf8');
      for (const match of source.matchAll(/from\s+'(\.[^']+)'/g)) {
        assert.ok(existsSync(path.resolve(dir, match[1])), `${rel} imports missing ${match[1]}`);
      }
    }
  });
});

describe('vendored libraries', () => {
  const VENDOR = [
    ['vendor/turndown.js', /global\.TurndownService/],
    ['vendor/turndown-plugin-gfm.js', /^var turndownPluginGfm/m],
    ['vendor/readability.js', /^function Readability/m],
    ['vendor/finder.js', /^var FinderLib/m],
  ];

  it('each expose the global the content script expects', () => {
    for (const [file, pattern] of VENDOR) {
      assert.ok(exists(file), `missing ${file}`);
      const source = readFileSync(path.join(EXT, file), 'utf8');
      assert.match(source, pattern, `${file} does not define its expected global`);
    }
  });

  it('are classic scripts, since content scripts cannot be modules', () => {
    for (const [file] of VENDOR) {
      const source = readFileSync(path.join(EXT, file), 'utf8');
      assert.doesNotMatch(source, /^\s*export\s+(default|const|function|class|\{)/m, `${file} uses ESM syntax`);
      assert.doesNotMatch(source, /^\s*import\s+[\w{*]/m, `${file} uses ESM imports`);
    }
  });

  it('ship their licences', () => {
    const licences = readdirSync(path.join(EXT, 'vendor', 'licenses'));
    assert.equal(licences.length, VENDOR.length, 'every vendored library needs its licence');
  });
});

describe('shared protocol', () => {
  it('is identical in the server and the extension', () => {
    const strip = (source) => {
      const end = source.indexOf('*/');
      return (source.startsWith('/**') && end !== -1 ? source.slice(end + 2) : source)
        .replace(/\r\n/g, '\n')
        .trim();
    };

    const server = readFileSync(path.join(ROOT, 'mcp-server', 'src', 'protocol.js'), 'utf8');
    const extension = readFileSync(path.join(EXT, 'shared', 'protocol.js'), 'utf8');

    assert.equal(
      strip(server),
      strip(extension),
      'protocol.js has drifted; requests will time out with no explanation',
    );
  });

  it('defines every method the two sides use', () => {
    const protocol = readFileSync(path.join(EXT, 'shared', 'protocol.js'), 'utf8');
    const worker = readFileSync(path.join(EXT, 'background', 'service-worker.js'), 'utf8');

    for (const method of ['page.markdown', 'selection.scrape', 'bridge.ping']) {
      assert.match(protocol, new RegExp(method.replace('.', '\\.')));
    }
    // The worker must handle each METHOD constant, or a tool call hangs.
    for (const constant of ['PAGE_MARKDOWN', 'SELECTION_SCRAPE', 'BRIDGE_PING']) {
      assert.match(worker, new RegExp(`METHOD\\.${constant}`), `worker does not handle ${constant}`);
    }
  });
});
