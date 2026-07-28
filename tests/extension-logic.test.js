/**
 * Tests for the content script's selection and extraction engine.
 *
 * These load the *real* `content/selector.js` — plus the real vendored
 * libraries — into a jsdom page and drive it through the same
 * `chrome.runtime.onMessage` interface the service worker uses. Nothing is
 * mocked except the `chrome.*` surface itself, so what is under test is the
 * shipped code path.
 *
 * Run: node --test "tests/**\/*.test.js"
 */

import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.join(here, '..', 'extension');
const read = (rel) => readFileSync(path.join(EXT, rel), 'utf8');

const PAGE_URL = 'https://shop.example.com/catalog/page-1';

/**
 * A page with the two shapes that matter for scraping: a repeating list of
 * cards, and a table. Prose is long enough for Readability to accept the page
 * rather than bailing out on a thin document.
 */
const PAGE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <title>Widgets — Catalog</title>
    <meta name="description" content="Every widget we sell." />
  </head>
  <body>
    <nav class="site-nav"><a href="/">Home</a> <a href="/about">About</a></nav>

    <article class="content">
      <h1>Widget catalog</h1>
      <p>
        Our widgets are manufactured to a tolerance of one micron and shipped in recyclable
        packaging. Every unit is tested twice before it leaves the factory floor, once on the
        line and once in the quality lab, and we publish the results of both tests alongside the
        serial number so that buyers can audit any individual widget after delivery. The catalog
        below lists current stock with live pricing that updates whenever our suppliers revise
        their rates, which in practice happens about once a fortnight during ordinary trading.
      </p>

      <div class="product-grid">
        <div class="product">
          <h2 class="product-title"><a href="/p/alpha">Alpha Widget</a></h2>
          <span class="price">$19.99</span>
          <span class="stock in-stock">In stock</span>
        </div>
        <div class="product">
          <h2 class="product-title"><a href="/p/beta">Beta Widget</a></h2>
          <span class="price">$24.50</span>
          <span class="stock">Backordered</span>
        </div>
        <div class="product">
          <h2 class="product-title"><a href="/p/gamma">Gamma Widget</a></h2>
          <span class="price">$8.00</span>
          <span class="stock in-stock">In stock</span>
        </div>
      </div>

      <h2>Specifications</h2>
      <table class="specs">
        <thead><tr><th>Model</th><th>Weight</th></tr></thead>
        <tbody>
          <tr><td>Alpha</td><td>120g</td></tr>
          <tr><td>Beta</td><td>140g</td></tr>
        </tbody>
      </table>

      <p>
        Shipping is calculated at checkout and depends on destination, declared value, and the
        service level you pick. Orders placed before noon usually leave the same working day.
      </p>
    </article>

    <footer class="site-footer"><p>© Example Corp</p></footer>
  </body>
</html>`;

/**
 * Values that come back from the content script were built inside jsdom's
 * realm, so their Array/Object prototypes are not Node's and `deepStrictEqual`
 * rejects them on identity alone. In Chrome this boundary does not exist —
 * messages are structured-cloned into the receiver's realm — so re-homing the
 * value here reproduces production semantics rather than papering over them.
 */
const rehome = (value) => JSON.parse(JSON.stringify(value));

/** Boot a jsdom page with the vendor libs + content script loaded into it. */
function bootPage(html = PAGE_HTML, url = PAGE_URL) {
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url,
    // jsdom cannot navigate, and one test deliberately lets a click through to
    // prove the page works again. Swallow just that, so a real error still shows.
    virtualConsole: new VirtualConsole().on('jsdomError', (error) => {
      if (!/Not implemented: navigation/.test(error.message)) console.error(error);
    }),
  });
  const { window } = dom;

  const sent = [];
  let listener = null;

  // Minimal chrome.* surface — exactly what selector.js touches.
  window.chrome = {
    runtime: {
      onMessage: {
        addListener: (fn) => {
          listener = fn;
        },
      },
      sendMessage: (message) => {
        sent.push(message);
        return Promise.resolve();
      },
    },
  };

  // jsdom does not implement CSS.escape; the content script relies on it to
  // build safe class selectors.
  if (!window.CSS) window.CSS = {};
  if (typeof window.CSS.escape !== 'function') {
    window.CSS.escape = (value) =>
      String(value).replace(/[^a-zA-Z0-9_ -￿-]/g, (ch) => `\\${ch}`);
  }

  const files = [
    'vendor/finder.js',
    'vendor/turndown.js',
    'vendor/turndown-plugin-gfm.js',
    'vendor/readability.js',
    'content/selector.js',
  ];
  for (const file of files) {
    const script = window.document.createElement('script');
    script.textContent = read(file);
    window.document.head.appendChild(script);
  }

  /** Call the content script the way the service worker does. */
  const ask = (message) =>
    new Promise((resolve, reject) => {
      if (!listener) return reject(new Error('content script registered no message listener'));
      const returned = listener(message, {}, resolve);
      if (returned === true) return; // async responder
    });

  /** Dispatch a trusted-looking click, as a real user would produce. */
  const click = (el) => {
    const event = new window.MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      clientX: 10,
      clientY: 10,
    });
    el.dispatchEvent(event);
    return event;
  };

  return { dom, window, document: window.document, ask, click, sent };
}

// ---------------------------------------------------------------------------

describe('content script: bootstrap', () => {
  it('registers a message listener and answers a ping', async () => {
    const { ask } = bootPage();
    const response = await ask({ type: 'omniscrape:ping' });
    assert.equal(response.ok, true);
    assert.equal(response.selecting, false);
    assert.deepEqual(rehome(response.fields), []);
  });

  it('does not install twice into the same page', async () => {
    const { window, ask } = bootPage();
    // Re-running the script must be a no-op; the worker re-injects freely.
    const script = window.document.createElement('script');
    script.textContent = read('content/selector.js');
    window.document.head.appendChild(script);

    const response = await ask({ type: 'omniscrape:ping' });
    assert.equal(response.ok, true);
  });
});

describe('content script: selection', () => {
  it('generalises a clicked list item to match all its siblings', async () => {
    const { document, ask, click } = bootPage();
    await ask({ type: 'omniscrape:start-selection' });

    click(document.querySelector('.product .price'));

    const { fields } = await ask({ type: 'omniscrape:ping' });
    assert.equal(fields.length, 1);

    const [field] = fields;
    // The whole point: clicking one price should capture the column.
    assert.equal(field.matchCount, 3, `expected 3 matches, selector was "${field.selector}"`);
    assert.equal(field.scope, 'all');
    assert.match(field.selector, /price/);
    assert.equal(field.sampleText, '$19.99');
  });

  it('keeps a unique selector alongside the generalised one', async () => {
    const { document, ask, click } = bootPage();
    await ask({ type: 'omniscrape:start-selection' });
    click(document.querySelector('.product .price'));

    const { fields } = await ask({ type: 'omniscrape:ping' });
    const [field] = fields;

    assert.equal(document.querySelectorAll(field.listSelector).length, 3);
    assert.equal(document.querySelectorAll(field.uniqueSelector).length, 1);
  });

  it('switches between all matches and just the clicked element', async () => {
    const { document, ask, click } = bootPage();
    await ask({ type: 'omniscrape:start-selection' });
    click(document.querySelector('.product .price'));

    const { fields: initial } = await ask({ type: 'omniscrape:ping' });
    const id = initial[0].id;

    const one = await ask({ type: 'omniscrape:set-field-scope', id, scope: 'one' });
    assert.equal(one.fields[0].matchCount, 1);

    const all = await ask({ type: 'omniscrape:set-field-scope', id, scope: 'all' });
    assert.equal(all.fields[0].matchCount, 3);
  });

  it('does not let a click navigate while selecting', async () => {
    const { document, ask, click } = bootPage();
    await ask({ type: 'omniscrape:start-selection' });

    const link = document.querySelector('.product-title a');
    const event = click(link);

    // If this were not prevented, picking a product title would leave the page
    // and destroy the whole selection.
    assert.equal(event.defaultPrevented, true, 'click during selection must be prevented');
  });

  it('lets clicks through again once selection mode ends', async () => {
    const { document, ask, click } = bootPage();
    await ask({ type: 'omniscrape:start-selection' });
    await ask({ type: 'omniscrape:stop-selection' });

    const event = click(document.querySelector('.product-title a'));
    assert.equal(event.defaultPrevented, false, 'the page must work normally after stopping');
  });

  it('toggles a field off when the same element is clicked twice', async () => {
    const { document, ask, click } = bootPage();
    await ask({ type: 'omniscrape:start-selection' });

    const price = document.querySelector('.product .price');
    click(price);
    assert.equal((await ask({ type: 'omniscrape:ping' })).fields.length, 1);

    click(price);
    assert.equal((await ask({ type: 'omniscrape:ping' })).fields.length, 0);
  });

  it('ignores state classes so a selector survives interaction', async () => {
    const { document, ask, click } = bootPage();
    await ask({ type: 'omniscrape:start-selection' });

    // `.stock.in-stock` — `in-stock` is state and must not enter the selector,
    // or the field would silently stop matching when stock changes.
    click(document.querySelector('.stock.in-stock'));

    const { fields } = await ask({ type: 'omniscrape:ping' });
    assert.doesNotMatch(fields[0].selector, /in-stock/);
    assert.equal(fields[0].matchCount, 3, 'should match all three stock labels');
  });

  it('renames and removes fields', async () => {
    const { document, ask, click } = bootPage();
    await ask({ type: 'omniscrape:start-selection' });
    click(document.querySelector('.product .price'));

    const { fields } = await ask({ type: 'omniscrape:ping' });
    const id = fields[0].id;

    const renamed = await ask({ type: 'omniscrape:rename-field', id, label: 'price' });
    assert.equal(renamed.fields[0].label, 'price');

    const removed = await ask({ type: 'omniscrape:remove-field', id });
    assert.equal(removed.fields.length, 0);
  });

  it('notifies the service worker whenever the selection changes', async () => {
    const { document, ask, click, sent } = bootPage();
    await ask({ type: 'omniscrape:start-selection' });
    click(document.querySelector('.product .price'));

    const updates = sent.filter((m) => m.type === 'omniscrape:selection-changed');
    assert.ok(updates.length > 0, 'expected at least one selection-changed message');
    assert.equal(updates.at(-1).fields.length, 1);
    assert.equal(updates.at(-1).selecting, true);
  });

  it('restores a selection after a worker or page restart', async () => {
    const { document, ask } = bootPage();
    const restored = await ask({
      type: 'omniscrape:restore',
      fields: [
        {
          id: 'f1',
          label: 'price',
          uniqueSelector: '.product-grid > div:nth-child(1) > .price',
          listSelector: '.product > .price',
          scope: 'all',
        },
      ],
    });
    assert.equal(restored.fields.length, 1);
    assert.equal(restored.fields[0].matchCount, 3);
    assert.equal(document.querySelectorAll('[data-omniscrape-match]').length, 3);
  });
});

describe('content script: selection extraction', () => {
  async function selectPrices() {
    const page = bootPage();
    await page.ask({ type: 'omniscrape:start-selection' });
    page.click(page.document.querySelector('.product .price'));
    return page;
  }

  it('returns every matching value as text', async () => {
    const { ask } = await selectPrices();
    const { capture } = await ask({
      type: 'omniscrape:extract-selection',
      options: { format: 'text' },
    });

    assert.equal(capture.extracted_fields.length, 1);
    const values = rehome(capture.extracted_fields[0].values).map((v) => v.text);
    assert.deepEqual(values, ['$19.99', '$24.50', '$8.00']);
    assert.equal(capture.meta.total_values, 3);
    assert.equal(capture.url, PAGE_URL);
  });

  it('returns markdown values that keep links', async () => {
    const page = bootPage();
    await page.ask({ type: 'omniscrape:start-selection' });
    page.click(page.document.querySelector('.product-title a'));

    const { capture } = await page.ask({
      type: 'omniscrape:extract-selection',
      options: { format: 'markdown' },
    });
    const values = capture.extracted_fields[0].values.map((v) => v.markdown);
    assert.equal(values.length, 3);
    // Relative hrefs must be absolute — the consumer is outside the browser.
    assert.equal(values[0], '[Alpha Widget](https://shop.example.com/p/alpha)');
  });

  it('includes attributes on request, with absolute URLs', async () => {
    const page = bootPage();
    await page.ask({ type: 'omniscrape:start-selection' });
    page.click(page.document.querySelector('.product-title a'));

    const { capture } = await page.ask({
      type: 'omniscrape:extract-selection',
      options: { format: 'text', includeAttributes: true },
    });
    const [first] = capture.extracted_fields[0].values;
    assert.equal(first.attributes.href, 'https://shop.example.com/p/alpha');
  });

  it('never leaks its own bookkeeping attributes into html output', async () => {
    const { ask } = await selectPrices();
    const { capture } = await ask({
      type: 'omniscrape:extract-selection',
      options: { format: 'html' },
    });
    const html = capture.extracted_fields[0].values.map((v) => v.html).join('');
    assert.doesNotMatch(html, /data-omniscrape/, 'highlight attributes must be stripped');
    assert.match(html, /\$19\.99/);
  });

  it('reports zero matches rather than failing when a selector goes stale', async () => {
    const page = await selectPrices();
    // Simulate the page changing under a stored selector.
    for (const node of page.document.querySelectorAll('.price')) node.remove();

    const { capture } = await page.ask({
      type: 'omniscrape:extract-selection',
      options: { format: 'text' },
    });
    assert.equal(capture.extracted_fields[0].match_count, 0);
    assert.deepEqual(rehome(capture.extracted_fields[0].values), []);
  });
});

describe('content script: page extraction', () => {
  it('converts the page to markdown and reports provenance', async () => {
    const { ask } = bootPage();
    const { capture } = await ask({
      type: 'omniscrape:extract-page',
      options: { useReadability: true, includeLinks: true, maxChars: 0 },
    });

    assert.equal(capture.url, PAGE_URL);
    assert.match(capture.title, /Widget/);
    assert.match(capture.markdown_content, /# Widget catalog|Widget catalog/);
    assert.ok(capture.meta.word_count > 50, 'should have extracted the article prose');
    assert.equal(capture.meta.truncated, false);
    assert.equal(capture.extracted_fields.length, 0);
  });

  it('converts tables to GitHub-flavoured markdown', async () => {
    const { ask } = bootPage();
    const { capture } = await ask({
      type: 'omniscrape:extract-page',
      options: { useReadability: false, includeLinks: true, maxChars: 0 },
    });

    // Plain Turndown passes tables through as raw HTML; the GFM plugin is what
    // makes the most scrapeable content on a page actually readable.
    assert.match(capture.markdown_content, /\| Model \| Weight \|/);
    assert.match(capture.markdown_content, /\| Alpha \| 120g \|/);
    assert.doesNotMatch(capture.markdown_content, /<table/);
  });

  it('makes relative links absolute', async () => {
    const { ask } = bootPage();
    const { capture } = await ask({
      type: 'omniscrape:extract-page',
      options: { useReadability: false, includeLinks: true, maxChars: 0 },
    });
    assert.match(capture.markdown_content, /\(https:\/\/shop\.example\.com\/p\/alpha\)/);
    assert.doesNotMatch(capture.markdown_content, /\]\(\/p\/alpha\)/);
  });

  it('strips links when asked', async () => {
    const { ask } = bootPage();
    const { capture } = await ask({
      type: 'omniscrape:extract-page',
      options: { useReadability: false, includeLinks: false, maxChars: 0 },
    });
    assert.match(capture.markdown_content, /Alpha Widget/);
    assert.doesNotMatch(capture.markdown_content, /\]\(https:\/\/shop\.example\.com\/p\/alpha\)/);
  });

  it('drops nav and footer when readability is on, keeps them when off', async () => {
    const { ask } = bootPage();

    const cleaned = (
      await ask({
        type: 'omniscrape:extract-page',
        options: { useReadability: true, includeLinks: true, maxChars: 0 },
      })
    ).capture;
    const raw = (
      await ask({
        type: 'omniscrape:extract-page',
        options: { useReadability: false, includeLinks: true, maxChars: 0 },
      })
    ).capture;

    assert.equal(cleaned.meta.readability_applied, true);
    assert.equal(raw.meta.readability_applied, false);
    assert.match(raw.markdown_content, /Example Corp/);
    assert.ok(
      raw.markdown_content.length >= cleaned.markdown_content.length,
      'the raw body should be at least as large as the readable article',
    );
  });

  it('truncates at max_chars and says so', async () => {
    const { ask } = bootPage();
    const { capture } = await ask({
      type: 'omniscrape:extract-page',
      options: { useReadability: false, includeLinks: true, maxChars: 200 },
    });

    assert.equal(capture.meta.truncated, true);
    assert.ok(capture.meta.original_chars > 200);
    assert.match(capture.markdown_content, /truncated by OmniScrape/);
  });

  it('falls back to the raw body when readability finds no article', async () => {
    const thin = `<!doctype html><html><head><title>Dashboard</title></head>
      <body><div id="app"><span class="metric">42</span></div></body></html>`;
    const { ask } = bootPage(thin, 'https://app.example.com/dashboard');

    const { capture } = await ask({
      type: 'omniscrape:extract-page',
      options: { useReadability: true, includeLinks: true, maxChars: 0 },
    });

    // Readability rejects thin app shells; returning nothing would be useless.
    assert.match(capture.markdown_content, /42/);
    assert.equal(capture.title, 'Dashboard');
  });

  it('does not destroy the live page while extracting', async () => {
    const { document, ask } = bootPage();
    const before = document.querySelectorAll('.product').length;

    await ask({
      type: 'omniscrape:extract-page',
      options: { useReadability: true, includeLinks: true, maxChars: 0 },
    });

    // Readability mutates whatever document it is handed. If the live document
    // were passed instead of a clone, the page would visibly fall apart.
    assert.equal(document.querySelectorAll('.product').length, before);
    assert.ok(document.querySelector('.site-footer'), 'footer must still be in the live DOM');
  });
});

describe('content script: error handling', () => {
  it('answers unknown messages without throwing', async () => {
    const { ask } = bootPage();
    const response = await ask({ type: 'omniscrape:nonsense' });
    assert.equal(response.ok, false);
    assert.match(response.error, /Unknown message/);
  });
});
