/**
 * OmniScrape content script — the point-and-click engine.
 *
 * Runs in the page. Responsible for:
 *   - selection mode: hover highlighting, click-to-pick, suppressing the page's
 *     own click behaviour so picking a link does not navigate away
 *   - turning a picked element into a CSS selector, and — the part that makes
 *     this useful for lists and tables — a *generalised* selector that matches
 *     its siblings, with a live match count
 *   - extraction: Readability + Turndown for whole pages, per-selector for the
 *     picked fields
 *
 * This is a classic script, not a module. It expects these globals, injected
 * ahead of it by the service worker:
 *   FinderLib.finder   unique-selector generation   (@medv/finder)
 *   TurndownService    HTML -> Markdown             (turndown)
 *   turndownPluginGfm  tables/strikethrough for it  (turndown-plugin-gfm)
 *   Readability        article extraction           (@mozilla/readability)
 */

(() => {
  'use strict';

  // Injection is idempotent: the service worker re-runs executeScript whenever
  // it is unsure whether we are here, and running twice would double every
  // event listener.
  if (window.__omniscrapeInstalled) return;
  window.__omniscrapeInstalled = true;

  const HUD_ID = 'omniscrape-hud-root';
  const ATTR = {
    HOVER: 'data-omniscrape-hover',
    SELECTED: 'data-omniscrape-selected',
    MATCH: 'data-omniscrape-match',
    ACTIVE: 'data-omniscrape-active',
  };

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  const state = {
    selecting: false,
    /** @type {Array<Field>} */
    fields: [],
    nextId: 1,
    hovered: null,
    hud: null,
  };

  /**
   * @typedef {object} Field
   * @property {string} id
   * @property {string} label            user-facing name
   * @property {string} uniqueSelector   matches exactly the clicked element
   * @property {string} listSelector     generalised; matches its siblings too
   * @property {'one'|'all'} scope       which of the two is live
   * @property {number} matchCount       matches for the live selector
   * @property {string} sampleText       first match's text, for the panel
   */

  /** The selector a field is currently using. */
  const activeSelector = (field) => (field.scope === 'all' ? field.listSelector : field.uniqueSelector);

  // ---------------------------------------------------------------------------
  // Selector generation
  // ---------------------------------------------------------------------------

  /**
   * Class names that survive into a selector. The goal is to drop anything that
   * describes *state* rather than *kind*, because state flips as the user
   * interacts and a selector built on it silently stops matching.
   */
  const STATE_CLASS = /^(is|has|js)-|^(active|selected|current|open|opened|show|shown|visible|hidden|hide|focus|focused|hover|hovered|disabled|checked|expanded|collapsed|loading|error|sticky|pinned|highlighted|dragging)$/i;
  /** CSS-modules / styled-components hashes: `Button_root__1a2b3c`, `css-1q2w3e`. */
  const HASHED_CLASS = /(^|[-_])[a-z0-9]*[0-9][a-z0-9]{4,}$|__[a-zA-Z0-9]{5,}$/;

  function isStableClass(cls) {
    if (!cls || cls.startsWith('omniscrape')) return false;
    if (STATE_CLASS.test(cls)) return false;
    if (HASHED_CLASS.test(cls)) return false;
    return true;
  }

  function stableClasses(el) {
    return Array.from(el.classList).filter(isStableClass);
  }

  /** `div.card.product` — a tag plus up to three durable classes. */
  function signature(el) {
    if (!el || el.nodeType !== 1) return '';
    const tag = el.tagName.toLowerCase();
    if (tag === 'html' || tag === 'body') return tag;
    const classes = stableClasses(el).slice(0, 3).map((c) => `.${CSS.escape(c)}`);
    return tag + classes.join('');
  }

  /** Strip positional constraints, turning "the 3rd price" into "any price". */
  function relax(selector) {
    return selector
      .replace(/:nth-child\(\s*\d+\s*\)/g, '')
      .replace(/:nth-of-type\(\s*\d+\s*\)/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function countMatches(selector) {
    if (!selector) return 0;
    try {
      return document.querySelectorAll(selector).length;
    } catch {
      return 0; // invalid selector
    }
  }

  function matchesElement(selector, el) {
    try {
      return el.matches(selector);
    } catch {
      return false;
    }
  }

  /**
   * Build a selector that captures "elements like this one".
   *
   * Ordered most-specific first; we take the first candidate that still matches
   * the clicked element *and* matches more than one node. Preferring specific
   * candidates matters: `.product > .price` is a far better answer than `span`,
   * even though both match several elements.
   */
  function generalize(el, uniqueSelector) {
    const own = signature(el);
    const parent = el.parentElement;
    const grand = parent?.parentElement;

    const candidates = [];

    const relaxed = relax(uniqueSelector);
    if (relaxed && relaxed !== uniqueSelector) candidates.push(relaxed);

    if (grand && parent && own) candidates.push(`${signature(grand)} ${signature(parent)} > ${own}`);
    if (parent && own) candidates.push(`${signature(parent)} > ${own}`);
    if (own) candidates.push(own);

    for (const candidate of candidates) {
      if (!candidate) continue;
      const count = countMatches(candidate);
      if (count > 1 && matchesElement(candidate, el)) return { selector: candidate, count };
    }

    return { selector: uniqueSelector, count: countMatches(uniqueSelector) };
  }

  /** Unique selector for one element, with a defensive fallback. */
  function uniqueSelectorFor(el) {
    try {
      // Ignore our own bookkeeping attributes so they never end up in the path.
      return FinderLib.finder(el, {
        idName: (name) => !name.startsWith('omniscrape'),
        className: isStableClass,
        attr: (name) => !name.startsWith('data-omniscrape'),
      });
    } catch {
      // finder throws if it cannot find anything unique within its budget.
      return fallbackPath(el);
    }
  }

  /** Last-resort structural path, used only if finder gives up. */
  function fallbackPath(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 12) {
      const tag = node.tagName.toLowerCase();
      if (tag === 'html') break;
      const parent = node.parentElement;
      if (!parent) {
        parts.unshift(tag);
        break;
      }
      const siblings = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
      parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})` : tag);
      node = parent;
    }
    return parts.join(' > ');
  }

  // ---------------------------------------------------------------------------
  // Highlighting
  // ---------------------------------------------------------------------------

  function clearAttr(attr) {
    for (const el of document.querySelectorAll(`[${attr}]`)) el.removeAttribute(attr);
  }

  function setHover(el) {
    if (state.hovered === el) return;
    if (state.hovered) state.hovered.removeAttribute(ATTR.HOVER);
    state.hovered = el;
    if (el) el.setAttribute(ATTR.HOVER, '');
  }

  /** Repaint selected/match highlights for every field. */
  function repaintFields() {
    clearAttr(ATTR.SELECTED);
    clearAttr(ATTR.MATCH);

    for (const field of state.fields) {
      const selector = activeSelector(field);
      let nodes = [];
      try {
        nodes = Array.from(document.querySelectorAll(selector));
      } catch {
        continue;
      }
      field.matchCount = nodes.length;
      for (const node of nodes) node.setAttribute(field.scope === 'all' ? ATTR.MATCH : ATTR.SELECTED, '');
      // Always mark the primary pick as selected so it stays visually distinct.
      try {
        const primary = document.querySelector(field.uniqueSelector);
        if (primary) primary.setAttribute(ATTR.SELECTED, '');
      } catch {
        /* selector no longer valid */
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Heads-up display (shadow DOM, immune to page CSS)
  // ---------------------------------------------------------------------------

  const HUD_CSS = `
    :host { all: initial; }
    .bar, .badge {
      font: 500 12px/1.4 ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
      color: #fff;
      box-sizing: border-box;
      pointer-events: none;
      position: fixed;
      z-index: 2147483647;
    }
    .bar {
      top: 12px; left: 50%; transform: translateX(-50%);
      display: flex; align-items: center; gap: 10px;
      padding: 8px 14px;
      background: #1e1b4b;
      border: 1px solid #4f46e5;
      border-radius: 9999px;
      box-shadow: 0 8px 24px rgba(0,0,0,.35);
      white-space: nowrap;
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #34d399; flex: none; }
    .bar b { font-weight: 600; }
    .bar .muted { color: #c7d2fe; font-weight: 400; }
    .kbd {
      font: 600 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
      padding: 3px 5px; border-radius: 4px;
      background: #312e81; border: 1px solid #6366f1; color: #e0e7ff;
    }
    .badge {
      padding: 5px 9px;
      background: #4f46e5;
      border-radius: 6px;
      box-shadow: 0 4px 14px rgba(0,0,0,.3);
      max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .badge .count { color: #a7f3d0; font-weight: 600; }
    .badge.hidden { display: none; }
  `;

  function buildHud() {
    const host = document.createElement('div');
    host.id = HUD_ID;
    // Keep the host itself out of the page's flow and hit-testing entirely.
    host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;pointer-events:none;';
    const root = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = HUD_CSS;

    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.innerHTML =
      '<span class="dot"></span><b>OmniScrape</b>' +
      '<span class="muted">click elements to select</span>' +
      '<span class="kbd">Esc</span><span class="muted">finish</span>' +
      '<span class="muted">·</span><span class="count muted">0 fields</span>';

    const badge = document.createElement('div');
    badge.className = 'badge hidden';

    root.append(style, bar, badge);
    (document.body ?? document.documentElement).appendChild(host);

    return { host, bar, badge, count: bar.querySelector('.count') };
  }

  function showHud() {
    if (!state.hud) state.hud = buildHud();
    state.hud.host.style.display = '';
    updateHudCount();
  }

  function hideHud() {
    if (state.hud) state.hud.host.style.display = 'none';
  }

  function updateHudCount() {
    if (!state.hud) return;
    const n = state.fields.length;
    state.hud.count.textContent = `${n} field${n === 1 ? '' : 's'}`;
  }

  /**
   * Rewrite the badge's text for a newly hovered element.
   *
   * This is the expensive half — `finder` searches for a unique path and
   * `generalize` runs several querySelectorAll passes — so it must only ever run
   * when the hovered element actually changes, never on plain cursor movement.
   */
  function refreshBadgeContent(el) {
    if (!state.hud) return;
    const { badge } = state.hud;

    if (!el) {
      badge.classList.add('hidden');
      return;
    }

    const unique = uniqueSelectorFor(el);
    const { selector, count } = generalize(el, unique);

    badge.textContent = '';
    const label = document.createElement('span');
    label.textContent = signature(el) || el.tagName.toLowerCase();
    badge.appendChild(label);

    if (count > 1) {
      const sep = document.createElement('span');
      sep.textContent = ' · ';
      const c = document.createElement('span');
      c.className = 'count';
      c.textContent = `${count} similar`;
      badge.append(sep, c);
    }

    badge.dataset.selector = selector;
    badge.classList.remove('hidden');
  }

  /** Cheap half: keep the badge beside the cursor and on screen. */
  function positionBadge(x, y) {
    if (!state.hud) return;
    const { badge } = state.hud;
    if (badge.classList.contains('hidden')) return;

    const pad = 14;
    const rect = badge.getBoundingClientRect();
    const left = Math.min(x + pad, window.innerWidth - rect.width - 8);
    const top = y + pad + rect.height > window.innerHeight ? y - rect.height - pad : y + pad;
    badge.style.left = `${Math.max(8, left)}px`;
    badge.style.top = `${Math.max(8, top)}px`;
  }

  // ---------------------------------------------------------------------------
  // Selection mode
  // ---------------------------------------------------------------------------

  /** Is this element part of our own UI rather than the page? */
  function isOurs(el) {
    return !el || el.id === HUD_ID || el.closest?.(`#${HUD_ID}`) !== null;
  }

  /**
   * Hover tracking, batched into one animation frame.
   *
   * mousemove fires far faster than the screen refreshes, and the work behind a
   * hover update is not cheap, so we record the latest position and do the work
   * once per frame. Selector generation additionally only runs when the element
   * under the cursor is a different element than last time.
   */
  let pendingMove = null;
  let moveFrame = 0;

  function onMouseMove(event) {
    if (!state.selecting) return;
    const el = event.target;
    if (!el || el.nodeType !== 1 || isOurs(el)) return;

    pendingMove = { el, x: event.clientX, y: event.clientY };
    if (moveFrame) return;

    moveFrame = requestAnimationFrame(() => {
      moveFrame = 0;
      const move = pendingMove;
      if (!move || !state.selecting) return;

      const changed = state.hovered !== move.el;
      if (changed) {
        setHover(move.el);
        refreshBadgeContent(move.el);
      }
      positionBadge(move.x, move.y);
    });
  }

  /**
   * Swallow every interaction the page would otherwise act on.
   *
   * Selection mode means the user's clicks belong to us, not the site. Without
   * this, picking a product title navigates to the product page and the whole
   * selection is lost. `stopImmediatePropagation` is what beats handlers the
   * page attached before us.
   */
  function swallow(event) {
    if (!state.selecting) return;
    if (isOurs(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }

  function onClick(event) {
    if (!state.selecting) return;
    if (isOurs(event.target)) return;

    swallow(event);

    const el = event.target;
    if (!el || el.nodeType !== 1) return;
    if (el === document.documentElement || el === document.body) return;

    toggleField(el);
  }

  function onKeyDown(event) {
    if (!state.selecting) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      stopSelecting();
      notifyPanel();
      return;
    }
    // Enter/Space would activate a focused link or button.
    if (event.key === 'Enter' || event.key === ' ') swallow(event);
  }

  /** Every event we intercept, all in the capture phase so we go first. */
  const SWALLOWED = ['mousedown', 'mouseup', 'auxclick', 'dblclick', 'contextmenu', 'pointerdown', 'pointerup', 'submit'];

  function startSelecting() {
    if (state.selecting) return;
    state.selecting = true;
    document.documentElement.setAttribute(ATTR.ACTIVE, '');

    window.addEventListener('mousemove', onMouseMove, true);
    window.addEventListener('click', onClick, true);
    window.addEventListener('keydown', onKeyDown, true);
    for (const type of SWALLOWED) window.addEventListener(type, swallow, true);

    showHud();
    repaintFields();
  }

  function stopSelecting() {
    if (!state.selecting) return;
    state.selecting = false;
    document.documentElement.removeAttribute(ATTR.ACTIVE);

    window.removeEventListener('mousemove', onMouseMove, true);
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('keydown', onKeyDown, true);
    for (const type of SWALLOWED) window.removeEventListener(type, swallow, true);

    if (moveFrame) {
      cancelAnimationFrame(moveFrame);
      moveFrame = 0;
    }
    pendingMove = null;

    setHover(null);
    hideHud();
  }

  /** Click an unselected element to add it; click a selected one to remove it. */
  function toggleField(el) {
    const unique = uniqueSelectorFor(el);
    const existing = state.fields.find((f) => f.uniqueSelector === unique);
    if (existing) {
      removeField(existing.id);
      return;
    }

    const { selector: listSelector, count } = generalize(el, unique);
    // Default to the generalised selector when it actually found siblings —
    // clicking one row of a table almost always means "and all the others".
    const scope = count > 1 ? 'all' : 'one';

    const field = {
      id: `f${state.nextId++}`,
      label: `field_${state.fields.length + 1}`,
      uniqueSelector: unique,
      listSelector,
      scope,
      matchCount: scope === 'all' ? count : 1,
      sampleText: (el.innerText ?? el.textContent ?? '').trim().slice(0, 120),
    };

    state.fields.push(field);
    repaintFields();
    updateHudCount();
    notifyPanel();
  }

  function removeField(id) {
    state.fields = state.fields.filter((f) => f.id !== id);
    repaintFields();
    updateHudCount();
    notifyPanel();
    return state.fields;
  }

  /** Tell the service worker (and through it, the panel) what changed. */
  function notifyPanel() {
    try {
      chrome.runtime
        .sendMessage({
          type: 'omniscrape:selection-changed',
          fields: serializeFields(),
          selecting: state.selecting,
        })
        .catch(() => {});
    } catch {
      // Extension context invalidated (reloaded from chrome://extensions).
      // Nothing useful to do; the page will be re-injected on next use.
    }
  }

  function serializeFields() {
    return state.fields.map((f) => ({
      id: f.id,
      label: f.label,
      selector: activeSelector(f),
      uniqueSelector: f.uniqueSelector,
      listSelector: f.listSelector,
      scope: f.scope,
      matchCount: countMatches(activeSelector(f)),
      sampleText: f.sampleText,
    }));
  }

  // ---------------------------------------------------------------------------
  // Markdown conversion
  // ---------------------------------------------------------------------------

  function makeTurndown({ includeLinks }) {
    const service = new TurndownService({
      headingStyle: 'atx',
      hr: '---',
      bulletListMarker: '-',
      codeBlockStyle: 'fenced',
      emDelimiter: '_',
      linkStyle: 'inlined',
    });

    // Tables are the single most valuable thing on a scrapeable page, and plain
    // Turndown passes them through as raw HTML. The GFM plugin fixes that.
    service.use(turndownPluginGfm.gfm);

    service.remove(['script', 'style', 'noscript', 'template', 'canvas', 'svg']);

    if (!includeLinks) {
      service.addRule('unwrapLinks', {
        filter: 'a',
        replacement: (content) => content,
      });
    }

    // An image with no alt text contributes nothing but noise to an LLM.
    service.addRule('dropEmptyImages', {
      filter: (node) => node.nodeName === 'IMG' && !node.getAttribute('alt'),
      replacement: () => '',
    });

    return service;
  }

  /**
   * Prepare a detached copy of `root` for conversion: drop our own UI, strip
   * bookkeeping attributes, and make URLs absolute so links survive being read
   * outside the browser.
   */
  function sanitizeClone(root) {
    const clone = root.cloneNode(true);

    for (const node of clone.querySelectorAll(`#${HUD_ID}`)) node.remove();
    for (const attr of Object.values(ATTR)) {
      // The root itself carries these when it is a selected element, and
      // querySelectorAll only walks descendants — so strip it explicitly or
      // every `html` capture leaks a stray data-omniscrape-selected attribute.
      clone.removeAttribute?.(attr);
      for (const node of clone.querySelectorAll(`[${attr}]`)) node.removeAttribute(attr);
    }

    // Resolve URLs against the page. Whatever consumes this Markdown is outside
    // the browser, where "/p/alpha" means nothing.
    const absolutize = (node, name) => {
      const raw = node.getAttribute?.(name);
      if (raw == null) return;
      try {
        node.setAttribute(name, new URL(raw, document.baseURI).href);
      } catch {
        /* leave malformed URLs exactly as they were */
      }
    };

    // The root element counts too: when the user picks a link directly, the
    // <a> *is* the clone, and querySelectorAll only walks its descendants.
    if (clone.nodeType === 1) {
      absolutize(clone, 'href');
      absolutize(clone, 'src');
    }
    for (const anchor of clone.querySelectorAll('a[href]')) absolutize(anchor, 'href');
    for (const img of clone.querySelectorAll('img[src]')) absolutize(img, 'src');

    return clone;
  }

  function tidyMarkdown(markdown) {
    return markdown
      .replace(/ /g, ' ') // non-breaking spaces read as garbage downstream
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // ---------------------------------------------------------------------------
  // Extraction
  // ---------------------------------------------------------------------------

  function extractPage({ useReadability = true, includeLinks = true, maxChars = 0 } = {}) {
    const service = makeTurndown({ includeLinks });
    let html = '';
    let title = document.title || '';
    let excerpt = '';
    let byline = '';
    let readabilityApplied = false;

    if (useReadability) {
      try {
        // Readability MUTATES the document it is handed — it strips nodes as it
        // scores them. Passing the live document would visibly destroy the page
        // under the user. Always give it a clone.
        const docClone = document.cloneNode(true);
        for (const node of docClone.querySelectorAll(`#${HUD_ID}`)) node.remove();

        // A cloned document does not reliably carry the original's URL, and
        // Readability resolves every href/src against it. Without this, links
        // on a page come back relative and useless once they leave the browser.
        if (!docClone.querySelector('base[href]')) {
          const base = docClone.createElement('base');
          base.setAttribute('href', document.baseURI);
          (docClone.head ?? docClone.documentElement).prepend(base);
        }

        const article = new Readability(docClone).parse();
        if (article?.content) {
          const holder = document.createElement('div');
          holder.innerHTML = article.content;
          html = sanitizeClone(holder).innerHTML;
          title = article.title || title;
          excerpt = article.excerpt || '';
          byline = article.byline || '';
          readabilityApplied = true;
        }
      } catch (error) {
        // Readability throws on pages it cannot make sense of (app shells,
        // framesets). Falling back to the raw body is strictly better than
        // failing the whole request.
        console.warn('[omniscrape] readability failed, using full body', error);
      }
    }

    if (!html) {
      html = sanitizeClone(document.body ?? document.documentElement).innerHTML;
    }

    let markdown = tidyMarkdown(service.turndown(html));
    const originalChars = markdown.length;
    let truncated = false;

    if (maxChars > 0 && markdown.length > maxChars) {
      markdown = markdown.slice(0, maxChars).trimEnd() + '\n\n…[truncated by OmniScrape]';
      truncated = true;
    }

    return {
      url: location.href,
      title,
      timestamp: new Date().toISOString(),
      markdown_content: markdown,
      extracted_fields: [],
      meta: {
        mode: 'page',
        readability_applied: readabilityApplied,
        include_links: includeLinks,
        word_count: markdown ? markdown.split(/\s+/).filter(Boolean).length : 0,
        truncated,
        original_chars: originalChars,
        ...(excerpt ? { excerpt } : {}),
        ...(byline ? { byline } : {}),
      },
    };
  }

  const ATTRS_OF_INTEREST = ['href', 'src', 'alt', 'title', 'value', 'type', 'datetime', 'content'];

  function attributesOf(el) {
    const out = {};
    for (const name of ATTRS_OF_INTEREST) {
      if (!el.hasAttribute(name)) continue;
      const raw = el.getAttribute(name);
      if (name === 'href' || name === 'src') {
        try {
          out[name] = new URL(raw, document.baseURI).href;
          continue;
        } catch {
          /* fall through to raw */
        }
      }
      out[name] = raw;
    }
    for (const attr of el.attributes) {
      if (attr.name.startsWith('data-') && !attr.name.startsWith('data-omniscrape')) {
        out[attr.name] = attr.value;
      }
    }
    return out;
  }

  function valueFor(el, format, service) {
    switch (format) {
      case 'text':
        return { text: (el.innerText ?? el.textContent ?? '').trim() };
      case 'html':
        return { html: sanitizeClone(el).outerHTML };
      case 'markdown':
      default:
        return { markdown: tidyMarkdown(service.turndown(sanitizeClone(el).outerHTML)) };
    }
  }

  function extractSelection({ format = 'markdown', includeAttributes = false } = {}) {
    const service = makeTurndown({ includeLinks: true });

    const extracted = state.fields.map((field) => {
      const selector = activeSelector(field);
      let nodes = [];
      let error = null;
      try {
        nodes = Array.from(document.querySelectorAll(selector));
      } catch (err) {
        error = err.message;
      }

      const values = nodes.map((node) => {
        const value = valueFor(node, format, service);
        if (includeAttributes) value.attributes = attributesOf(node);
        return value;
      });

      return {
        label: field.label,
        selector,
        match_count: nodes.length,
        values,
        ...(error ? { error } : {}),
        ...(field.scope === 'one' ? { scope: 'one' } : {}),
      };
    });

    return {
      url: location.href,
      title: document.title || '',
      timestamp: new Date().toISOString(),
      markdown_content: '',
      extracted_fields: extracted,
      meta: {
        mode: 'selection',
        format,
        include_attributes: includeAttributes,
        field_count: extracted.length,
        total_values: extracted.reduce((sum, f) => sum + f.values.length, 0),
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Message handling
  // ---------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    try {
      switch (message?.type) {
        case 'omniscrape:ping':
          sendResponse({ ok: true, selecting: state.selecting, fields: serializeFields() });
          break;

        case 'omniscrape:start-selection':
          startSelecting();
          notifyPanel();
          sendResponse({ ok: true, selecting: true, fields: serializeFields() });
          break;

        case 'omniscrape:stop-selection':
          stopSelecting();
          notifyPanel();
          sendResponse({ ok: true, selecting: false, fields: serializeFields() });
          break;

        case 'omniscrape:clear-selection':
          state.fields = [];
          repaintFields();
          updateHudCount();
          notifyPanel();
          sendResponse({ ok: true, fields: [] });
          break;

        case 'omniscrape:remove-field':
          removeField(message.id);
          sendResponse({ ok: true, fields: serializeFields() });
          break;

        case 'omniscrape:set-field-scope': {
          const field = state.fields.find((f) => f.id === message.id);
          if (field) {
            field.scope = message.scope === 'all' ? 'all' : 'one';
            repaintFields();
            notifyPanel();
          }
          sendResponse({ ok: true, fields: serializeFields() });
          break;
        }

        case 'omniscrape:rename-field': {
          const field = state.fields.find((f) => f.id === message.id);
          if (field) {
            const label = String(message.label ?? '').trim();
            if (label) field.label = label;
            notifyPanel();
          }
          sendResponse({ ok: true, fields: serializeFields() });
          break;
        }

        case 'omniscrape:restore': {
          // Re-hydrate after a page reload or worker restart. Selectors may no
          // longer match anything; that is fine and the counts will show it.
          const incoming = Array.isArray(message.fields) ? message.fields : [];
          state.fields = incoming.map((f, index) => ({
            id: f.id ?? `f${index + 1}`,
            label: f.label ?? `field_${index + 1}`,
            uniqueSelector: f.uniqueSelector ?? f.selector ?? '',
            listSelector: f.listSelector ?? f.selector ?? '',
            scope: f.scope === 'one' ? 'one' : 'all',
            matchCount: 0,
            sampleText: f.sampleText ?? '',
          }));
          state.nextId = state.fields.length + 1;
          repaintFields();
          updateHudCount();
          sendResponse({ ok: true, fields: serializeFields() });
          break;
        }

        case 'omniscrape:extract-page':
          sendResponse({ ok: true, capture: extractPage(message.options ?? {}) });
          break;

        case 'omniscrape:extract-selection':
          sendResponse({ ok: true, capture: extractSelection(message.options ?? {}) });
          break;

        default:
          sendResponse({ ok: false, error: `Unknown message: ${message?.type}` });
      }
    } catch (error) {
      console.error('[omniscrape] content script error', error);
      sendResponse({ ok: false, error: error.message, code: 'scrape_failed' });
    }
    // Every branch responds synchronously, so no need to keep the port open.
    return false;
  });

  // A navigation inside a single-page app can invalidate every selector without
  // ever unloading this script. Re-count on history changes so the panel does
  // not keep showing stale match numbers.
  for (const event of ['popstate', 'hashchange']) {
    window.addEventListener(event, () => {
      if (state.fields.length === 0) return;
      repaintFields();
      notifyPanel();
    });
  }

  console.debug('[omniscrape] content script ready');
})();
