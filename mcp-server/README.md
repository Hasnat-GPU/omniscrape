# OmniScrape MCP Server

The local half of OmniScrape. It speaks MCP to Claude over stdio and, at the same
time, runs a loopback WebSocket that the Chrome extension dials into. A tool call
from Claude becomes a request on that socket; the extension scrapes the live DOM
and the answer travels back the same way.

```
Claude  <--stdio/JSON-RPC-->  this server  <--ws://127.0.0.1:3000-->  Chrome extension
```

## Requirements

- Node.js 20 or newer (developed on 24).

## Install

```bash
cd mcp-server
npm install
```

## Register with Claude

**Claude Code**

```bash
claude mcp add omniscrape -- node "<absolute-path>/mcp-server/src/index.js"
```

**Claude Desktop** — add to `claude_desktop_config.json`:

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

Use an absolute path; the MCP client does not launch the server from this
directory. On Windows, either escape backslashes (`C:\\Users\\...`) or use
forward slashes.

You do not start the server yourself — the MCP client spawns it and owns its
lifetime. `npm start` is for debugging only.

## Tools

| Tool | Purpose |
| --- | --- |
| `get_active_tab_markdown` | Read the current tab as clean Markdown (Readability + Turndown). |
| `scrape_selected_elements` | Return the elements the user point-and-clicked, with their CSS selectors and every matching value. |
| `get_bridge_status` | Report whether the browser is connected, and which tabs it can reach. |

`get_bridge_status` is not in the original spec — it exists because "the scrape
failed" and "the browser was never connected" are otherwise indistinguishable to
Claude, and that distinction is the difference between a useful retry and a
confusing loop.

### `get_active_tab_markdown`

| Argument | Default | Notes |
| --- | --- | --- |
| `tab_id` | active tab | Chrome tab id. |
| `use_readability` | `true` | Strips nav/ads/footers. Turn **off** for dashboards, search results, and any page whose value lives in lists and tables — Readability discards those. |
| `include_links` | `true` | Keep hyperlink URLs in the Markdown. |
| `max_chars` | `100000` | Context-window guard. Truncation is always reported in the response header. `0` disables. |

### `scrape_selected_elements`

| Argument | Default | Notes |
| --- | --- | --- |
| `tab_id` | active tab | Chrome tab id. |
| `format` | `markdown` | `markdown` \| `text` \| `html` per matched element. |
| `include_attributes` | `false` | Also return `href`, `src`, `title`, `alt`, `data-*`. |

## Resources

Tool calls are pull-shaped: Claude asks, the server answers. The extension's
**Send to Claude** button is a push, with no tool call in flight to attach it to.
MCP models that as resources, so pushed captures land in an in-memory inbox and
the server fires `notifications/resources/list_changed`.

- `omniscrape://captures` — index of this session's captures
- `omniscrape://captures/latest` — the most recent one
- `omniscrape://captures/{id}` — a specific capture

Nothing is written to disk. A scrape can contain anything the user was logged
into, so it lives for the process lifetime and no longer.

## Configuration

All settings are environment variables, because an MCP client launches the
server from a JSON config where `env` is the only channel available.

| Variable | Default | Purpose |
| --- | --- | --- |
| `OMNISCRAPE_PORT` | `3000` | Port for HTTP + WebSocket. |
| `OMNISCRAPE_HOST` | `127.0.0.1` | Bind address. Leave on loopback. |
| `OMNISCRAPE_TOKEN` | *(unset)* | Shared secret; extension must connect with `?token=…`. |
| `OMNISCRAPE_ALLOWED_ORIGINS` | `chrome-extension://*,moz-extension://*` | Origin allowlist. |
| `OMNISCRAPE_REQUEST_TIMEOUT_MS` | `30000` | How long a tool call waits for the browser. |
| `OMNISCRAPE_HEARTBEAT_MS` | `30000` | Keepalive ping interval. |
| `OMNISCRAPE_INBOX_MAX` | `25` | Captures retained before evicting the oldest. |
| `OMNISCRAPE_MAX_MESSAGE_BYTES` | `16777216` | Largest accepted WebSocket frame. |
| `OMNISCRAPE_EXPOSE_CAPTURES_HTTP` | `false` | Serve the inbox at `/captures` (debug only). |
| `OMNISCRAPE_LOG_LEVEL` | `info` | `silent` \| `error` \| `warn` \| `info` \| `debug`. |

Example with a token:

```json
{
  "mcpServers": {
    "omniscrape": {
      "command": "node",
      "args": ["<absolute-path>/mcp-server/src/index.js"],
      "env": { "OMNISCRAPE_TOKEN": "a-long-random-string" }
    }
  }
}
```

## Locking down the bridge

The bridge hands out the contents of whatever page the user is looking at, so
the handshake is guarded on three axes:

1. **Loopback only.** Binding to `127.0.0.1` keeps it off the local network.
2. **Origin allowlist.** A WebSocket is not subject to CORS — any web page you
   visit *can* open a socket to `ws://127.0.0.1:3000`. It cannot forge its
   `Origin` header, though, so requiring `chrome-extension://` is what stops a
   malicious tab from connecting and pulling your scrapes.
3. **Optional token.** The origin check does not distinguish *which* extension
   is connecting. Once you have loaded OmniScrape and know its id, pin it:

   ```
   OMNISCRAPE_ALLOWED_ORIGINS=chrome-extension://<your-extension-id>
   ```

   For a stronger guarantee, set `OMNISCRAPE_TOKEN` as well and enter the same
   value in the extension's options page.

Any local process running as your user can still connect if it sets a plausible
`Origin` — a token is the only real defence against that, and it is the reason
the option exists.

## Health check

```bash
curl http://127.0.0.1:3000/health
```

```json
{
  "ok": true,
  "listening": true,
  "bridge_url": "ws://127.0.0.1:3000",
  "extension_connected": true,
  "client_count": 1,
  "clients": [{ "id": "3f2a9c11", "origin": "chrome-extension://…", "agent": "chrome-mv3" }],
  "pending_requests": 0
}
```

## Tests

```bash
npm test
```

Spawns the real server, speaks real MCP JSON-RPC over its stdio, and connects a
fake extension over the real WebSocket — so it exercises the wiring rather than
mocks of it. Covers the handshake, tool schemas and defaults, round trips,
origin rejection, mid-flight disconnects, malformed frames, and pushed captures.

## Layout

```
src/
  index.js      entry point; wires MCP + bridge + inbox, handles shutdown
  config.js     env-driven configuration
  logger.js     stderr-only logger
  protocol.js   the WebSocket wire contract (mirrored in the extension)
  bridge.js     HTTP + WebSocket server, request correlation, heartbeat
  inbox.js      bounded in-memory store for pushed captures
  tools.js      MCP tool definitions
  resources.js  MCP resources over the inbox
test/
  e2e.test.js   end-to-end suite
```

## Gotchas

**stdout belongs to MCP.** Under the stdio transport, stdout carries
newline-delimited JSON-RPC. One stray `console.log` corrupts the stream and the
client drops the connection with an opaque parse error. Everything diagnostic
goes through `logger`, which writes to stderr. The test suite asserts this.

**Port 3000 is popular.** If the server cannot bind, it exits with a message
saying so — check the MCP client's server logs. Set `OMNISCRAPE_PORT` and update
the extension's Bridge URL to match.

**A killed client can leak the server.** The server shuts down when its stdin
closes, which is how MCP clients signal "stop". If a server is ever orphaned it
keeps the port, and the next start fails with `EADDRINUSE`.
