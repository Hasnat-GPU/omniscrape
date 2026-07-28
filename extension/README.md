# OmniScrape Chrome Extension

Manifest V3 extension. Point at elements on a page, and hand them to Claude.

There is **no build step**. Clone, load unpacked, done — the libraries are
prebuilt in [`vendor/`](vendor/README.md).

## Install

1. Start the MCP server side first (see [`../mcp-server`](../mcp-server)) — or
   just start Claude, which launches it for you.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and pick this `extension/` folder.
5. Click the OmniScrape toolbar icon to open the side panel.
6. Click **Grant page access** in the panel. Chrome only accepts a permission
   request that came from a button you clicked, so this cannot be automatic.

The status dot turns green once the panel reaches the server.

## Using it

**Point and click**

Press **Start Selecting Elements**, then click things on the page. While
selection mode is on, clicks belong to OmniScrape — links do not navigate.

- Hovering outlines the element and shows how many similar ones exist.
- Clicking one row of a list captures **all** of them. That is the useful case:
  pick one price, get the column.
- Each pick becomes a field. Rename it, switch it between **All** and **One**,
  or remove it.
- **Esc**, or **Stop Selecting**, ends the mode. `Alt+Shift+S` toggles it
  without opening the panel.

**Getting data to Claude**

Either ask Claude ("read the page I'm on", "scrape what I selected") and it
calls the tools, or press **Send to Claude** to push the current capture into
the server's inbox, where it appears as an MCP resource.

**Extract Full Page** converts the whole page to Markdown and previews it in the
panel, without involving Claude.

## Layout

```
manifest.json
background/
  service-worker.js   switchboard: bridge, injection, tab state, panel sync
  bridge-client.js    reconnecting WebSocket client
content/
  selector.js         selection engine + extraction (classic script)
  selector.css        highlight styles injected into the page
sidepanel/            the main UI
options/              bridge URL, token, capture defaults, permissions
shared/protocol.js    wire contract, mirrored from the server
vendor/               prebuilt turndown / readability / finder
icons/
```

## Design notes

**Host access is optional, not required at install.** The manifest asks for
`activeTab` + `scripting`, and requests `http://*/*` + `https://*/*` only when
you press the button. `activeTab` alone is not enough: it is granted by a user
gesture on a tab, and a Claude-initiated scrape has no gesture behind it. So the
persistent grant is what makes tool calls work, and putting it behind a button
means the extension installs without the "read all your data on all websites"
warning.

**A service worker is not a persistent process.** Chrome stops it after ~30s
idle, so "keep a WebSocket open" needs help: the client sends a keepalive frame
every 20s (Chrome resets the idle timer on WebSocket traffic), reconnects with
exponential backoff plus jitter, and a one-minute `chrome.alarms` timer can
restart the worker if it is killed anyway — an alarm can wake a stopped worker,
a dead socket cannot.

**Selection state lives in three places on purpose.** The content script holds
the live selection and its highlights; the worker mirrors it into
`chrome.storage.session` so it survives a worker restart; the panel only renders.
Session storage never touches disk — a scrape can contain anything you were
logged into.

**Selectors avoid state classes.** `.stock.in-stock` becomes `.stock`, because a
selector built on `in-stock` silently stops matching the moment stock changes.
Hashed CSS-modules classes are dropped for the same reason. When you click an
element, OmniScrape keeps both a unique selector and a generalised one, and shows
you the match count for whichever is live.

**Readability is given a clone, always.** `new Readability(doc).parse()` mutates
the document it is handed — passing the live one would visibly tear the page
apart under you.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Status dot stays red | The MCP server is not running. Start Claude, or `npm start` in `mcp-server`. Check `http://127.0.0.1:3000/health`. |
| "Page access needed" keeps returning | The permission was denied or revoked. Re-grant it in the panel or on the options page. |
| Buttons disabled on a tab | Chrome forbids extensions on `chrome://`, `chrome-extension://`, and the Web Store. |
| Selection lost after reload | Expected: a navigation invalidates every stored CSS selector, so they are cleared. |
| Fields show `0×` | The page changed and the selector no longer matches. Re-pick the element. |
| Panel says connected, Claude disagrees | Claude launched its own server instance. Reconnect from the panel, or check the port in Settings. |

Service worker logs: `chrome://extensions` → OmniScrape → **service worker**.
Content script logs: the page's own DevTools console.
