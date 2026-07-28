/**
 * Options page controller.
 *
 * Reads and writes the same `settings` object the service worker uses, and
 * offers a connection test that talks to the server's HTTP health endpoint
 * rather than the WebSocket — a health check gives a real diagnosis ("nothing
 * is listening", "the server is up but sees no extension"), where a failed
 * WebSocket handshake gives an intentionally information-free error event.
 */

const $ = (id) => document.getElementById(id);

const DEFAULTS = {
  bridgeUrl: 'ws://127.0.0.1:3000',
  token: '',
  autoConnect: true,
  useReadability: true,
  includeLinks: true,
  format: 'markdown',
  includeAttributes: false,
};

const HOST_PATTERNS = ['http://*/*', 'https://*/*'];

const fields = {
  bridgeUrl: $('bridgeUrl'),
  token: $('token'),
  autoConnect: $('autoConnect'),
  useReadability: $('useReadability'),
  includeLinks: $('includeLinks'),
  format: $('format'),
  includeAttributes: $('includeAttributes'),
};

// ---------------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------------

async function loadSettings() {
  const stored = await chrome.storage.local.get('settings');
  const settings = { ...DEFAULTS, ...(stored.settings ?? {}) };

  fields.bridgeUrl.value = settings.bridgeUrl;
  fields.token.value = settings.token;
  fields.autoConnect.checked = settings.autoConnect;
  fields.useReadability.checked = settings.useReadability;
  fields.includeLinks.checked = settings.includeLinks;
  fields.format.value = settings.format;
  fields.includeAttributes.checked = settings.includeAttributes;

  return settings;
}

function readForm() {
  return {
    bridgeUrl: fields.bridgeUrl.value.trim() || DEFAULTS.bridgeUrl,
    token: fields.token.value,
    autoConnect: fields.autoConnect.checked,
    useReadability: fields.useReadability.checked,
    includeLinks: fields.includeLinks.checked,
    format: fields.format.value,
    includeAttributes: fields.includeAttributes.checked,
  };
}

/** Reject URLs the WebSocket constructor would throw on, before we save them. */
function validateBridgeUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return 'That is not a valid URL. Expected something like ws://127.0.0.1:3000';
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    return `The bridge URL must start with ws:// or wss://, not ${url.protocol}//`;
  }
  return '';
}

async function save({ reconnect }) {
  const settings = readForm();

  const problem = validateBridgeUrl(settings.bridgeUrl);
  if (problem) {
    toast(problem, 'error');
    return;
  }

  try {
    await chrome.runtime.sendMessage({ type: 'panel:save-settings', settings, reconnect });
    toast(reconnect ? 'Saved — reconnecting' : 'Saved', 'success');
  } catch {
    // The worker may be asleep; the storage write is what actually matters, and
    // it will pick the new values up on its next connect.
    await chrome.storage.local.set({ settings });
    toast('Saved', 'success');
  }
}

$('btn-save').addEventListener('click', () => void save({ reconnect: true }));
$('btn-save-2').addEventListener('click', () => void save({ reconnect: false }));

// ---------------------------------------------------------------------------
// Connection test
// ---------------------------------------------------------------------------

/** ws://host:port  ->  http://host:port/health */
function healthUrlFor(bridgeUrl) {
  const url = new URL(bridgeUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '/health';
  url.search = '';
  return url.href;
}

$('btn-test').addEventListener('click', async () => {
  const result = $('test-result');
  const value = fields.bridgeUrl.value.trim() || DEFAULTS.bridgeUrl;

  const problem = validateBridgeUrl(value);
  if (problem) {
    result.dataset.tone = 'bad';
    result.textContent = problem;
    return;
  }

  result.dataset.tone = '';
  result.textContent = 'Testing…';

  try {
    const response = await fetch(healthUrlFor(value), { cache: 'no-store' });
    if (!response.ok) {
      result.dataset.tone = 'bad';
      result.textContent = `Server answered ${response.status}.`;
      return;
    }
    const body = await response.json();
    result.dataset.tone = 'ok';
    result.textContent = body.extension_connected
      ? `Server up · ${body.client_count} extension connected`
      : 'Server up · waiting for the extension to connect';
  } catch (error) {
    result.dataset.tone = 'bad';
    result.textContent =
      'No server at that address. Start Claude (it launches the MCP server) and try again.';
    console.warn('[omniscrape] health check failed', error);
  }
});

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

async function renderPermissions() {
  const granted = await chrome.permissions.contains({ origins: HOST_PATTERNS });
  $('permission-text').textContent = granted
    ? 'Granted. OmniScrape can read http and https pages.'
    : 'Not granted. Scraping will fail until you allow OmniScrape to read pages.';
  $('btn-grant').disabled = granted;
  $('btn-revoke').disabled = !granted;
}

$('btn-grant').addEventListener('click', async () => {
  // Must be called directly from the click — awaiting first would lose the
  // user gesture Chrome requires for a permission prompt.
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: HOST_PATTERNS });
  } catch (error) {
    toast(`Request failed: ${error.message}`, 'error');
    return;
  }
  toast(granted ? 'Page access granted' : 'Access denied', granted ? 'success' : 'error');
  await renderPermissions();
});

$('btn-revoke').addEventListener('click', async () => {
  try {
    await chrome.permissions.remove({ origins: HOST_PATTERNS });
    toast('Page access revoked');
  } catch (error) {
    toast(`Could not revoke: ${error.message}`, 'error');
  }
  await renderPermissions();
});

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

const toastEl = $('toast');
let toastTimer = null;

function toast(message, tone = 'info') {
  toastEl.textContent = message;
  toastEl.dataset.tone = tone;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, tone === 'error' ? 6000 : 2600);
}

// ---------------------------------------------------------------------------

await loadSettings();
await renderPermissions();
