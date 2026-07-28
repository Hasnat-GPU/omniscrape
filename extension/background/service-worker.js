/**
 * OmniScrape service worker.
 *
 * The switchboard. It owns the WebSocket to the MCP server, injects the content
 * script on demand, relays requests to whichever tab is being scraped, and keeps
 * the side panel in sync.
 *
 * Three actors talk to it:
 *   - the MCP server, over the bridge  (methods from shared/protocol.js)
 *   - the content script, over chrome.tabs messaging  ("omniscrape:*")
 *   - the side panel, over chrome.runtime messaging   ("panel:*")
 */

import { BridgeClient, STATE } from './bridge-client.js';
import { ERROR_CODE, EVENT, METHOD, makeCapture } from '../shared/protocol.js';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS = {
  bridgeUrl: 'ws://127.0.0.1:3000',
  token: '',
  autoConnect: true,
  // Extraction defaults used by the panel's buttons. Claude passes its own
  // values per tool call, so these only affect user-initiated captures.
  useReadability: true,
  includeLinks: true,
  format: 'markdown',
  includeAttributes: false,
};

async function getSettings() {
  const stored = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(stored.settings ?? {}) };
}

async function setSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

/** Host patterns we need in order to inject into ordinary pages. */
const HOST_PATTERNS = ['http://*/*', 'https://*/*'];

function hasHostAccess() {
  return chrome.permissions.contains({ origins: HOST_PATTERNS });
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Build an Error carrying a protocol error code the server understands. */
function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** Pages Chrome forbids extensions from touching, whatever permissions we hold. */
const BLOCKED_SCHEMES = ['chrome:', 'chrome-extension:', 'edge:', 'about:', 'devtools:', 'view-source:'];
const BLOCKED_HOSTS = ['chromewebstore.google.com', 'chrome.google.com/webstore'];

function describeUnscrapable(url) {
  if (!url) return 'That tab has no readable URL yet — it may still be loading.';
  try {
    const parsed = new URL(url);
    if (BLOCKED_SCHEMES.includes(parsed.protocol)) {
      return `Chrome does not allow extensions to read ${parsed.protocol}// pages. Switch to a normal web page.`;
    }
    if (parsed.protocol === 'file:') {
      return 'Reading local files requires "Allow access to file URLs" on the extension\'s details page.';
    }
    if (BLOCKED_HOSTS.some((host) => url.includes(host))) {
      return 'Chrome blocks extensions on the Web Store. Switch to another tab.';
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return `OmniScrape only reads http(s) pages, not ${parsed.protocol}//`;
    }
  } catch {
    return `That tab's URL could not be parsed: ${url}`;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

/** Resolve the tab a request targets: an explicit id, else the active tab. */
async function resolveTab(tabId) {
  let tab;
  if (typeof tabId === 'number') {
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      throw fail(ERROR_CODE.NO_ACTIVE_TAB, `No tab with id ${tabId}. It may have been closed.`);
    }
  } else {
    // `lastFocusedWindow` beats `currentWindow` here: when Claude drives the
    // browser there is no "current" window from the worker's point of view.
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    tab = active ?? (await chrome.tabs.query({ active: true }))[0];
  }

  if (!tab) {
    throw fail(ERROR_CODE.NO_ACTIVE_TAB, 'No active tab found. Open a page in Chrome and try again.');
  }

  const problem = describeUnscrapable(tab.url);
  if (problem) throw fail(ERROR_CODE.NO_ACTIVE_TAB, problem);

  return tab;
}

/**
 * Make sure the content script and its libraries are loaded in `tabId`.
 * Injection is idempotent: selector.js no-ops if it is already installed.
 */
async function ensureContentScript(tabId) {
  // Cheapest check first — a live content script answers instantly.
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: 'omniscrape:ping' });
    if (pong?.ok) return;
  } catch {
    /* not injected yet; fall through */
  }

  if (!(await hasHostAccess())) {
    throw fail(
      ERROR_CODE.CONTENT_SCRIPT_UNAVAILABLE,
      'OmniScrape does not have permission to read pages yet. Open the OmniScrape side panel ' +
        'and click "Grant page access" — Chrome only lets an extension request that from a ' +
        'button you clicked, so it cannot be done from here.',
    );
  }

  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['content/selector.css'] });
    await chrome.scripting.executeScript({
      target: { tabId },
      // Order matters: the libraries must define their globals before
      // selector.js runs. These are classic scripts, not modules.
      files: [
        'vendor/finder.js',
        'vendor/turndown.js',
        'vendor/turndown-plugin-gfm.js',
        'vendor/readability.js',
        'content/selector.js',
      ],
    });
  } catch (error) {
    throw fail(
      ERROR_CODE.CONTENT_SCRIPT_UNAVAILABLE,
      `Could not inject into that tab: ${error.message}. Try reloading the page.`,
    );
  }

  // Hand back any selection this tab had before the worker or page restarted.
  const restored = await loadSelection(tabId);
  if (restored.length > 0) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'omniscrape:restore', fields: restored });
    } catch {
      /* best effort */
    }
  }
}

/** Send a message to a tab's content script, injecting it first if needed. */
async function askTab(tabId, message) {
  await ensureContentScript(tabId);
  let response;
  try {
    response = await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    throw fail(
      ERROR_CODE.CONTENT_SCRIPT_UNAVAILABLE,
      `The page stopped responding: ${error.message}. Reload the tab and try again.`,
    );
  }
  if (!response) {
    throw fail(ERROR_CODE.SCRAPE_FAILED, 'The content script returned nothing.');
  }
  if (response.ok === false) {
    throw fail(response.code ?? ERROR_CODE.SCRAPE_FAILED, response.error ?? 'Scrape failed.');
  }
  return response;
}

// ---------------------------------------------------------------------------
// Per-tab selection state
// ---------------------------------------------------------------------------
// Mirrored into chrome.storage.session so it survives a service-worker restart
// (which happens constantly) but never touches disk.

const selectionKey = (tabId) => `selection:${tabId}`;

async function loadSelection(tabId) {
  const key = selectionKey(tabId);
  const stored = await chrome.storage.session.get(key);
  return stored[key] ?? [];
}

async function saveSelection(tabId, fields) {
  if (!fields || fields.length === 0) {
    await chrome.storage.session.remove(selectionKey(tabId));
  } else {
    await chrome.storage.session.set({ [selectionKey(tabId)]: fields });
  }
  await updateBadge(tabId, fields?.length ?? 0);
}

async function updateBadge(tabId, count) {
  try {
    await chrome.action.setBadgeText({ tabId, text: count > 0 ? String(count) : '' });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#4f46e5' });
  } catch {
    /* tab closed */
  }
}

// ---------------------------------------------------------------------------
// The bridge
// ---------------------------------------------------------------------------

const bridge = new BridgeClient({
  getSettings: async () => {
    const settings = await getSettings();
    return { url: settings.bridgeUrl, token: settings.token };
  },
  onRequest: handleServerRequest,
  onStateChange: (state, status) => {
    broadcastToPanel({ type: 'sw:bridge-state', status });
    // Reflect connection state in the toolbar tooltip — cheap ambient feedback
    // that does not require opening the panel.
    const label =
      state === STATE.CONNECTED
        ? 'OmniScrape — connected to Claude'
        : state === STATE.CONNECTING
          ? 'OmniScrape — connecting…'
          : 'OmniScrape — not connected';
    chrome.action.setTitle({ title: label }).catch(() => {});
  },
});

/**
 * Handle one request from the MCP server.
 * @param {string} method one of METHOD.*
 */
async function handleServerRequest(method, params) {
  switch (method) {
    case METHOD.PAGE_MARKDOWN: {
      const tab = await resolveTab(params.tabId);
      const response = await askTab(tab.id, {
        type: 'omniscrape:extract-page',
        options: {
          useReadability: params.useReadability !== false,
          includeLinks: params.includeLinks !== false,
          maxChars: Number.isFinite(params.maxChars) ? params.maxChars : 100_000,
        },
      });
      return response.capture;
    }

    case METHOD.SELECTION_SCRAPE: {
      const tab = await resolveTab(params.tabId);
      const response = await askTab(tab.id, {
        type: 'omniscrape:extract-selection',
        options: {
          format: params.format ?? 'markdown',
          includeAttributes: Boolean(params.includeAttributes),
        },
      });
      return response.capture;
    }

    case METHOD.BRIDGE_PING: {
      return { pong: true, tabs: await listCandidateTabs() };
    }

    default:
      throw fail(ERROR_CODE.UNKNOWN_METHOD, `The extension does not implement "${method}".`);
  }
}

/** Summarise the tabs Claude could plausibly be asked to read. */
async function listCandidateTabs() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return [];
  }
  return tabs
    .filter((tab) => !describeUnscrapable(tab.url))
    .slice(0, 25)
    .map((tab) => ({
      id: tab.id,
      title: tab.title ?? '',
      url: tab.url ?? '',
      active: Boolean(tab.active),
      // Without host permission Chrome withholds title/url; say so plainly
      // rather than reporting an empty string as if the page had no title.
      readable: Boolean(tab.url),
    }));
}

// ---------------------------------------------------------------------------
// Side panel messaging
// ---------------------------------------------------------------------------

/** Push an update to the side panel. It may not be open; that is not an error. */
function broadcastToPanel(message) {
  chrome.runtime.sendMessage(message).catch(() => {
    /* no panel listening */
  });
}

/** Build the full state object the panel renders from. */
async function panelState() {
  const settings = await getSettings();
  const granted = await hasHostAccess();

  let tab = null;
  let unscrapable = '';
  try {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (active) {
      tab = { id: active.id, title: active.title ?? '', url: active.url ?? '' };
      unscrapable = describeUnscrapable(active.url);
    }
  } catch {
    /* no window */
  }

  const fields = tab ? await loadSelection(tab.id) : [];
  const selecting = tab ? Boolean(selectionModeTabs.has(tab.id)) : false;

  return {
    bridge: bridge.status(),
    settings,
    permissions: { hostAccess: granted },
    tab,
    unscrapable,
    fields,
    selecting,
  };
}

/** Tabs currently in selection mode, so the panel can show the right button. */
const selectionModeTabs = new Set();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Returning true keeps the response channel open for the async work below.
  handleRuntimeMessage(message, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: error.message, code: error.code }));
  return true;
});

async function handleRuntimeMessage(message, sender) {
  switch (message?.type) {
    // --- from the content script -------------------------------------------
    case 'omniscrape:selection-changed': {
      const tabId = sender.tab?.id;
      if (typeof tabId !== 'number') return {};
      await saveSelection(tabId, message.fields);
      if (message.selecting === true) selectionModeTabs.add(tabId);
      if (message.selecting === false) selectionModeTabs.delete(tabId);
      broadcastToPanel({ type: 'sw:selection', tabId, fields: message.fields, selecting: message.selecting });
      return {};
    }

    // --- from the side panel ------------------------------------------------
    case 'panel:get-state':
      return { state: await panelState() };

    case 'panel:start-selection': {
      const tab = await resolveTab();
      await askTab(tab.id, { type: 'omniscrape:start-selection' });
      selectionModeTabs.add(tab.id);
      return { tabId: tab.id };
    }

    case 'panel:stop-selection': {
      const tab = await resolveTab();
      await askTab(tab.id, { type: 'omniscrape:stop-selection' });
      selectionModeTabs.delete(tab.id);
      return { tabId: tab.id };
    }

    case 'panel:clear-selection': {
      const tab = await resolveTab();
      await askTab(tab.id, { type: 'omniscrape:clear-selection' });
      await saveSelection(tab.id, []);
      return { tabId: tab.id };
    }

    case 'panel:remove-field': {
      const tab = await resolveTab();
      const response = await askTab(tab.id, { type: 'omniscrape:remove-field', id: message.id });
      await saveSelection(tab.id, response.fields ?? []);
      return { fields: response.fields ?? [] };
    }

    case 'panel:set-scope': {
      const tab = await resolveTab();
      const response = await askTab(tab.id, {
        type: 'omniscrape:set-field-scope',
        id: message.id,
        scope: message.scope,
      });
      await saveSelection(tab.id, response.fields ?? []);
      return { fields: response.fields ?? [] };
    }

    case 'panel:rename-field': {
      const tab = await resolveTab();
      const response = await askTab(tab.id, {
        type: 'omniscrape:rename-field',
        id: message.id,
        label: message.label,
      });
      await saveSelection(tab.id, response.fields ?? []);
      return { fields: response.fields ?? [] };
    }

    case 'panel:extract-page': {
      const settings = await getSettings();
      const tab = await resolveTab();
      const response = await askTab(tab.id, {
        type: 'omniscrape:extract-page',
        options: {
          useReadability: settings.useReadability,
          includeLinks: settings.includeLinks,
          maxChars: 0, // no truncation for a user-initiated capture
        },
      });
      return { capture: response.capture };
    }

    case 'panel:send-to-claude': {
      const capture = await buildCapture(message.mode ?? 'auto');
      const sent = bridge.sendEvent(EVENT.CAPTURE, capture);
      if (!sent) {
        throw fail(
          ERROR_CODE.NOT_CONNECTED,
          'Not connected to the MCP server, so the capture was not sent. Start Claude (which ' +
            'launches the server) and wait for the status dot to turn green.',
        );
      }
      return { capture: { url: capture.url, chars: capture.markdown_content.length, fields: capture.extracted_fields.length } };
    }

    case 'panel:reconnect':
      await bridge.connect({ manual: true });
      return { status: bridge.status() };

    case 'panel:disconnect':
      bridge.disconnect();
      return { status: bridge.status() };

    case 'panel:save-settings': {
      const next = await setSettings(message.settings ?? {});
      // A changed URL or token only takes effect on a fresh socket.
      if (message.reconnect) {
        bridge.disconnect();
        await bridge.connect({ manual: true });
      }
      return { settings: next };
    }

    case 'panel:permission-granted':
      // The panel performs the request (it needs a user gesture); we just
      // refresh anything that depends on it.
      broadcastToPanel({ type: 'sw:state-dirty' });
      return { hostAccess: await hasHostAccess() };

    default:
      throw new Error(`Unknown message type: ${message?.type}`);
  }
}

/**
 * Assemble a capture for the "Send to Claude" button.
 * @param {'auto'|'page'|'selection'} mode  'auto' prefers a selection if one exists.
 */
async function buildCapture(mode) {
  const settings = await getSettings();
  const tab = await resolveTab();
  const fields = await loadSelection(tab.id);

  const wantSelection = mode === 'selection' || (mode === 'auto' && fields.length > 0);

  if (wantSelection) {
    const response = await askTab(tab.id, {
      type: 'omniscrape:extract-selection',
      options: { format: settings.format, includeAttributes: settings.includeAttributes },
    });
    return makeCapture({ ...response.capture, meta: { ...response.capture.meta, source: 'send-to-claude' } });
  }

  const response = await askTab(tab.id, {
    type: 'omniscrape:extract-page',
    options: { useReadability: settings.useReadability, includeLinks: settings.includeLinks, maxChars: 0 },
  });
  return makeCapture({ ...response.capture, meta: { ...response.capture.meta, source: 'send-to-claude' } });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** Keep the panel opening from the toolbar button, and connect on every start. */
async function bootstrap() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (error) {
    console.warn('[omniscrape] sidePanel.setPanelBehavior failed', error);
  }

  const settings = await getSettings();
  if (settings.autoConnect) {
    await bridge.connect();
  }
}

chrome.runtime.onInstalled.addListener(() => {
  bootstrap();
  // A 1-minute alarm is the only thing that can restart a terminated service
  // worker on a schedule. Without it, a bridge that drops while the browser is
  // idle stays down until the user clicks something.
  chrome.alarms.create('omniscrape:keepalive', { periodInMinutes: 1 });
});

chrome.runtime.onStartup.addListener(() => {
  bootstrap();
  chrome.alarms.create('omniscrape:keepalive', { periodInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'omniscrape:keepalive') return;
  getSettings().then((settings) => {
    if (settings.autoConnect) bridge.connect();
  });
});

// Keyboard shortcut: toggle selection mode without opening the panel.
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-selection') return;
  try {
    const tab = await resolveTab();
    const active = selectionModeTabs.has(tab.id);
    await askTab(tab.id, { type: active ? 'omniscrape:stop-selection' : 'omniscrape:start-selection' });
    if (active) selectionModeTabs.delete(tab.id);
    else selectionModeTabs.add(tab.id);
    broadcastToPanel({ type: 'sw:state-dirty' });
  } catch (error) {
    console.warn('[omniscrape] toggle-selection failed', error.message);
  }
});

// Forget a tab's selection when it goes away or navigates elsewhere.
chrome.tabs.onRemoved.addListener((tabId) => {
  selectionModeTabs.delete(tabId);
  chrome.storage.session.remove(selectionKey(tabId)).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // A committed navigation invalidates every stored CSS selector.
  if (changeInfo.status === 'loading' && changeInfo.url) {
    selectionModeTabs.delete(tabId);
    chrome.storage.session.remove(selectionKey(tabId)).catch(() => {});
    updateBadge(tabId, 0);
    broadcastToPanel({ type: 'sw:state-dirty' });
  }
});

chrome.tabs.onActivated.addListener(() => {
  broadcastToPanel({ type: 'sw:state-dirty' });
});

// The worker may be spun up by any event, not just install/startup — so always
// make sure the bridge is coming up.
bootstrap();
