# OmniScrape MCP

A free, open-source point-and-click web scraper that plugs your browser straight
into Claude over the Model Context Protocol.

Highlight elements on any page with your mouse, and Claude can read exactly what
you picked — or the whole page as clean Markdown — without you copying, pasting,
or handing an API key to a scraping service.

Pick one price in a list and OmniScrape finds the other 47.

## How it fits together

An MCP server is a local Node process. The scraping has to happen inside a real
browser, in a real page's DOM. Those two worlds cannot see each other, so the
extension dials into a loopback WebSocket the server owns:

```
┌──────────┐   stdio    ┌──────────────────┐   ws://127.0.0.1:3000   ┌───────────────────┐
│  Claude  │◄──────────►│  MCP server      │◄───────────────────────►│ Chrome extension  │
│          │  JSON-RPC  │  (Node)          │      request/response   │  (Manifest V3)    │
└──────────┘            └──────────────────┘                         └─────────┬─────────┘
                                                                               │ scripting
                                                                     ┌─────────▼─────────┐
                                                                     │  the page's DOM   │
                                                                     └───────────────────┘
```

Data flows two ways:

- **Pull** — Claude calls a tool, the server asks the extension, the extension
  scrapes and answers. Exposed as MCP *tools*.
- **Push** — you click **Send to Claude**. There is no tool call in flight to
  attach that to, so captures land in a server-side inbox exposed as MCP
  *resources*, and the server fires `resources/list_changed`.

## Install

Requires Node 20+ and Chrome 114+.

```bash
git clone <this-repo> && cd omniscrape-mcp
npm run install:all
```

Register the server with Claude Code:

```bash
claude mcp add omniscrape -- node "$(pwd)/mcp-server/src/index.js"
```

<details>
<summary>Claude Desktop instead</summary>

```json
{
  "mcpServers": {
    "omniscrape": {
      "command": "node",
      "args": ["<absolute-path>/mcp-server/src/index.js"]
    }
  }
}
```
</details>

Then load the extension — there is no build step:

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → pick the `extension/` folder
3. Click the OmniScrape icon, then **Grant page access**

The status dot goes green when the panel reaches the server. Claude launches the
server itself, so start Claude first (or run `npm start` in `mcp-server` to test
standalone).

## Using it

Say things like:

- *"Read the page I'm looking at and summarise the argument."*
- *"Scrape what I selected and put it in a table."*
- *"Pull every product name and price off this page."*

Or drive it from the panel: **Start Selecting Elements** → click things → **Send
to Claude**.

Selection mode swallows page clicks, so picking a product title does not navigate
away. Hovering shows how many similar elements exist; clicking one row of a list
captures the whole column. Each pick becomes a field you can rename, scope to
**All** or **One**, or drop. `Esc` exits.

## Tools

| Tool | What it does |
| --- | --- |
| `get_active_tab_markdown` | Current tab as clean Markdown (Readability + Turndown, GFM tables). |
| `scrape_selected_elements` | The elements you point-and-clicked, with selectors and every match. |
| `get_bridge_status` | Whether the browser is connected, and which tabs it can reach. |

Plus resources at `omniscrape://captures` for anything pushed with the button.

Full options in [`mcp-server/README.md`](mcp-server/README.md).

## Repository layout

```
mcp-server/    Node MCP server + WebSocket bridge
extension/     Manifest V3 Chrome extension (no build step)
tests/         Extension tests: engine, bridge integration, package integrity
```

## Tests

```bash
npm test
```

71 tests, none of them mocking the thing under test:

- **Server (17)** — spawns the real server, speaks real MCP JSON-RPC over its
  stdio, connects a fake extension over the real WebSocket. Covers the
  handshake, tool schemas and defaults, origin rejection, mid-flight
  disconnects, malformed frames, and pushed captures.
- **Selection engine (26)** — loads the real content script and the real
  vendored libraries into a jsdom page and drives it through the same message
  interface the service worker uses. Covers selector generalisation, state-class
  filtering, click suppression, Markdown/table/link conversion, truncation, and
  that Readability never touches the live DOM.
- **Bridge integration (11)** — imports the shipped WebSocket client unchanged,
  points it at a spawned server, and drives that same process over stdio, so a
  tool call travels the whole path. Includes killing the server mid-session and
  asserting the client reconnects on its own and still works.
- **Package integrity (11)** — every file the manifest references exists, no
  inline scripts the extension CSP would block, vendored libraries expose their
  globals and are not ESM, and the two copies of the wire protocol match.

## Security posture

The bridge serves the contents of whatever page you are looking at, so it is
deliberately narrow:

- **Loopback only.** Bound to `127.0.0.1`, never the network.
- **Origin allowlist.** A WebSocket is exempt from CORS, so any page you visit
  *can* open a socket to `ws://127.0.0.1:3000`. It cannot forge its `Origin`
  header, so requiring `chrome-extension://` is what stops a malicious tab from
  connecting and reading your scrapes. Two tests cover this.
- **Optional token.** The origin check does not prove *which* extension is
  connecting, and any local process running as you could present a plausible
  origin. Set `OMNISCRAPE_TOKEN` if that matters to you.
- **Nothing on disk.** Captures live in memory for the process lifetime.
- **Page access is opt-in**, requested from a button rather than demanded at
  install.

See [Locking down the bridge](mcp-server/README.md#locking-down-the-bridge).

## Known limits

- **Top frame only.** Content inside iframes is not scraped.
- **Selectors are structural.** A page that re-renders with different markup
  invalidates them; the panel shows `0×` when that happens.
- **Readability is all or nothing.** Turn it off for dashboards, search results,
  and tables — it discards exactly that kind of content.
- **One browser at a time.** With several profiles connected, requests go to the
  most recently active one.

## License

MIT. Vendored libraries keep their own licenses — see
[`extension/vendor/`](extension/vendor/README.md).
