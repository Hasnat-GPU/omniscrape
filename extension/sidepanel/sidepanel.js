/**
 * Side panel controller.
 *
 * Thin by design: it renders state the service worker owns and sends intents
 * back. It holds no scraping logic of its own, because the panel can be closed
 * and reopened at any moment — anything it "remembered" would be a bug.
 *
 * The one thing it must do itself is request host permissions. Chrome only
 * honours `permissions.request()` from a user gesture in an extension page, so
 * a service worker can never ask on its own.
 */

const $ = (id) => document.getElementById(id);

const el = {
  status: $('status'),
  statusDot: $('status-dot'),
  statusLabel: $('status-label'),

  permissionBanner: $('permission-banner'),
  btnGrant: $('btn-grant'),

  unscrapableBanner: $('unscrapable-banner'),
  unscrapableText: $('unscrapable-text'),

  tabTitle: $('tab-title'),
  tabUrl: $('tab-url'),

  btnSelect: $('btn-select'),
  btnSelectLabel: $('btn-select-label'),
  btnExtract: $('btn-extract'),

  fieldsSection: $('fields-section'),
  fieldsList: $('fields-list'),
  fieldCount: $('field-count'),
  btnClear: $('btn-clear'),

  emptyState: $('empty-state'),

  preview: $('preview'),
  previewBody: $('preview-body'),
  btnCopy: $('btn-copy'),

  btnSend: $('btn-send'),
  bridgeUrl: $('bridge-url'),
  btnOptions: $('btn-options'),

  toast: $('toast'),
};

const HOST_PATTERNS = ['http://*/*', 'https://*/*'];

/** Last capture text, kept only to power the Copy button. */
let lastCaptureText = '';
let currentState = null;

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

/**
 * Send an intent to the service worker.
 * Rejects with a real Error so callers can surface `error.message` directly.
 */
async function send(type, payload = {}) {
  let response;
  try {
    response = await chrome.runtime.sendMessage({ type, ...payload });
  } catch (error) {
    // The worker was asleep and the message could not be delivered, or the
    // extension was reloaded out from under this panel.
    throw new Error(`Extension background is unavailable (${error.message}). Try reopening the panel.`);
  }
  if (!response) throw new Error('No response from the extension background.');
  if (response.ok === false) throw new Error(response.error || 'Something went wrong.');
  return response;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderStatus(bridge) {
  const state = bridge?.state ?? 'disconnected';
  el.status.dataset.state = state;

  const labels = {
    connected: 'Connected',
    connecting: 'Connecting…',
    disconnected: 'Not connected',
  };
  el.statusLabel.textContent = labels[state] ?? state;

  el.status.title =
    state === 'connected'
      ? `Connected to ${bridge.url}. Click to reconnect.`
      : bridge?.lastError
        ? `${bridge.lastError}\n\nClick to retry.`
        : 'Not connected to the MCP server. Click to retry.';
}

function renderTab(state) {
  const { tab, unscrapable } = state;

  el.tabTitle.textContent = tab?.title || (tab ? '(untitled)' : 'No active tab');
  el.tabUrl.textContent = tab?.url ?? '';

  const blocked = Boolean(unscrapable);
  el.unscrapableBanner.hidden = !blocked;
  el.unscrapableText.textContent = unscrapable ?? '';

  const usable = Boolean(tab) && !blocked && state.permissions.hostAccess;
  el.btnSelect.disabled = !usable;
  el.btnExtract.disabled = !usable;
  el.btnSend.disabled = !usable;
}

function renderPermissions(state) {
  el.permissionBanner.hidden = state.permissions.hostAccess;
}

function renderSelectionButton(state) {
  const selecting = Boolean(state.selecting);
  el.btnSelectLabel.textContent = selecting ? 'Stop Selecting' : 'Start Selecting Elements';
  el.btnSelect.classList.toggle('btn--active', selecting);
  el.btnSelect.classList.toggle('btn--primary', !selecting);
}

function renderFields(fields) {
  const list = fields ?? [];
  el.fieldCount.textContent = String(list.length);
  el.fieldsSection.hidden = list.length === 0;
  el.emptyState.hidden = list.length > 0;

  el.fieldsList.replaceChildren(...list.map(fieldRow));
}

/** Build one field row. Built with DOM calls, not innerHTML — page-derived
 *  text (labels, selectors, samples) must never be parsed as markup. */
function fieldRow(field) {
  const li = document.createElement('li');
  li.className = 'field';
  li.dataset.id = field.id;

  const top = document.createElement('div');
  top.className = 'field__top';

  const label = document.createElement('input');
  label.className = 'field__label';
  label.value = field.label;
  label.spellcheck = false;
  label.setAttribute('aria-label', 'Field name');
  label.addEventListener('change', () => {
    void act(() => send('panel:rename-field', { id: field.id, label: label.value }));
  });
  label.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') label.blur();
  });

  const count = document.createElement('span');
  count.className = 'field__count';
  count.dataset.zero = String(field.matchCount === 0);
  count.textContent = `${field.matchCount}×`;
  count.title =
    field.matchCount === 0
      ? 'This selector no longer matches anything — the page may have changed.'
      : `Matches ${field.matchCount} element${field.matchCount === 1 ? '' : 's'}`;

  const scope = document.createElement('div');
  scope.className = 'field__scope';
  scope.setAttribute('role', 'group');
  scope.setAttribute('aria-label', 'Scope');
  for (const [value, text, title] of [
    ['all', 'All', 'Scrape every element this selector matches'],
    ['one', 'One', 'Scrape only the element you clicked'],
  ]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.title = title;
    button.setAttribute('aria-pressed', String(field.scope === value));
    button.addEventListener('click', () => {
      void act(() => send('panel:set-scope', { id: field.id, scope: value }));
    });
    scope.appendChild(button);
  }

  const remove = document.createElement('button');
  remove.className = 'field__remove';
  remove.type = 'button';
  remove.textContent = '×';
  remove.title = 'Remove this field';
  remove.setAttribute('aria-label', `Remove ${field.label}`);
  remove.addEventListener('click', () => {
    void act(() => send('panel:remove-field', { id: field.id }));
  });

  top.append(label, count, scope, remove);

  const selector = document.createElement('p');
  selector.className = 'field__selector';
  selector.textContent = field.selector;
  selector.title = field.selector;

  li.append(top, selector);

  if (field.sampleText) {
    const sample = document.createElement('p');
    sample.className = 'field__sample';
    sample.textContent = field.sampleText;
    sample.title = field.sampleText;
    li.appendChild(sample);
  }

  return li;
}

function render(state) {
  currentState = state;
  renderStatus(state.bridge);
  renderPermissions(state);
  renderTab(state);
  renderSelectionButton(state);
  renderFields(state.fields);
  el.bridgeUrl.textContent = state.settings.bridgeUrl;
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

let toastTimer = null;

function toast(message, tone = 'info') {
  el.toast.textContent = message;
  el.toast.dataset.tone = tone;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.hidden = true;
  }, tone === 'error' ? 6000 : 3000);
}

/** Run an action, surface failures as a toast, and refresh afterwards. */
async function act(fn, { refresh = true } = {}) {
  try {
    const result = await fn();
    if (refresh) await refreshState();
    return result;
  } catch (error) {
    toast(error.message, 'error');
    return null;
  }
}

async function refreshState() {
  try {
    const { state } = await send('panel:get-state');
    render(state);
  } catch (error) {
    toast(error.message, 'error');
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

el.btnGrant.addEventListener('click', async () => {
  // Must run inside this click handler: Chrome rejects permission requests that
  // are not tied to a user gesture, and awaiting anything first loses it.
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: HOST_PATTERNS });
  } catch (error) {
    toast(`Permission request failed: ${error.message}`, 'error');
    return;
  }

  if (!granted) {
    toast('Access denied. OmniScrape cannot read pages without it.', 'error');
    return;
  }

  toast('Page access granted', 'success');
  await act(() => send('panel:permission-granted'));
});

el.btnSelect.addEventListener('click', async () => {
  const selecting = Boolean(currentState?.selecting);
  const result = await act(() => send(selecting ? 'panel:stop-selection' : 'panel:start-selection'));
  if (result && !selecting) {
    toast('Selection mode on — click elements on the page');
  }
});

el.btnExtract.addEventListener('click', async () => {
  el.btnExtract.disabled = true;
  const result = await act(() => send('panel:extract-page'), { refresh: false });
  el.btnExtract.disabled = false;
  if (!result) return;

  const capture = result.capture;
  lastCaptureText = capture.markdown_content;
  showPreview(
    `${capture.title}\n${capture.url}\n` +
      `${capture.meta.word_count} words · ${capture.meta.readability_applied ? 'readability' : 'full body'}\n\n` +
      capture.markdown_content.slice(0, 4000),
  );
  toast(`Extracted ${capture.meta.word_count} words`, 'success');
});

el.btnSend.addEventListener('click', async () => {
  el.btnSend.disabled = true;
  const result = await act(() => send('panel:send-to-claude', { mode: 'auto' }), { refresh: false });
  el.btnSend.disabled = false;
  if (!result) return;

  const { chars, fields } = result.capture;
  toast(
    fields > 0
      ? `Sent ${fields} field${fields === 1 ? '' : 's'} to Claude`
      : `Sent ${chars.toLocaleString()} characters to Claude`,
    'success',
  );
});

el.btnClear.addEventListener('click', () => {
  void act(() => send('panel:clear-selection'));
});

el.status.addEventListener('click', () => {
  void act(async () => {
    await send('panel:reconnect');
    toast('Reconnecting…');
  });
});

el.btnOptions.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

el.btnCopy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(lastCaptureText);
    toast('Copied to clipboard', 'success');
  } catch (error) {
    toast(`Copy failed: ${error.message}`, 'error');
  }
});

function showPreview(text) {
  el.previewBody.textContent = text;
  el.preview.hidden = false;
}

// ---------------------------------------------------------------------------
// Live updates
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message) => {
  switch (message?.type) {
    case 'sw:bridge-state':
      if (currentState) {
        currentState.bridge = message.status;
        renderStatus(message.status);
      }
      break;

    case 'sw:selection':
      if (currentState && currentState.tab?.id === message.tabId) {
        currentState.fields = message.fields;
        currentState.selecting = message.selecting ?? currentState.selecting;
        renderFields(message.fields);
        renderSelectionButton(currentState);
      }
      break;

    case 'sw:state-dirty':
      void refreshState();
      break;
  }
  // We never respond; returning false lets other listeners (and the sender's
  // own callback) resolve immediately instead of waiting on us.
  return false;
});

// Chrome keeps the panel alive across tab switches, so re-read state whenever
// it becomes visible again.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void refreshState();
});

void refreshState();
