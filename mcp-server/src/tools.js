/**
 * MCP tool definitions.
 *
 * Each tool turns a Claude tool call into a bridge round trip, normalises
 * whatever the extension sent back into the canonical capture envelope, and
 * renders it for an LLM to read.
 *
 * A note on result formatting: we deliberately do NOT declare `outputSchema`
 * here. Doing so obliges the server to also emit the whole payload as a JSON
 * string for backwards compatibility, which for a scraping tool means shipping
 * the page twice and JSON-escaping every newline in the Markdown. For page text
 * we return a short header plus the raw Markdown; for point-and-click results,
 * where the data really is structured records, we return pretty JSON.
 */

import { z } from 'zod';
import { BridgeError } from './bridge.js';
import { METHOD, ERROR_CODE, makeCapture } from './protocol.js';
import { config } from './config.js';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

const text = (value) => ({ content: [{ type: 'text', text: value }] });

/**
 * Turn a thrown error into a tool result Claude can act on. Bridge failures are
 * usually operator problems (extension not loaded, wrong tab focused), so the
 * message needs to say what to actually do rather than just naming the fault.
 */
function toolError(error, toolName) {
  const code = error instanceof BridgeError ? error.code : ERROR_CODE.INTERNAL;

  const guidance = {
    [ERROR_CODE.NOT_CONNECTED]:
      'Fix: open Chrome, confirm the OmniScrape extension is enabled at chrome://extensions, ' +
      'and open its popup — the status dot should read "Connected".',
    [ERROR_CODE.TIMEOUT]:
      'Fix: the tab may still be loading or may be a heavy page. Wait for it to settle and retry.',
    [ERROR_CODE.DISCONNECTED]:
      'Fix: the browser closed or the extension service worker restarted. Retry once it reconnects.',
    [ERROR_CODE.NO_ACTIVE_TAB]:
      'Fix: focus a normal http(s) tab. Chrome forbids extensions from reading chrome://, ' +
      'chrome-extension://, and the Web Store.',
    [ERROR_CODE.CONTENT_SCRIPT_UNAVAILABLE]:
      'Fix: reload the tab. Content scripts cannot attach to pages that were already open when ' +
      'the extension loaded, nor to restricted pages.',
    [ERROR_CODE.NO_SELECTION]:
      'Fix: open the OmniScrape popup, click "Start Selecting Elements", click the elements you ' +
      'want on the page, then call this tool again.',
  }[code];

  logger.warn('tool failed', { tool: toolName, code, message: error.message });

  return {
    content: [
      {
        type: 'text',
        text: `OmniScrape error (${code}): ${error.message}${guidance ? `\n\n${guidance}` : ''}`,
      },
    ],
    isError: true,
  };
}

/** Coerce whatever the extension sent into a guaranteed-shaped envelope. */
function normalize(raw) {
  return makeCapture({
    url: typeof raw?.url === 'string' ? raw.url : '',
    title: typeof raw?.title === 'string' ? raw.title : '',
    timestamp: typeof raw?.timestamp === 'string' ? raw.timestamp : new Date().toISOString(),
    markdown_content: typeof raw?.markdown_content === 'string' ? raw.markdown_content : '',
    extracted_fields: Array.isArray(raw?.extracted_fields) ? raw.extracted_fields : [],
    meta: raw?.meta && typeof raw.meta === 'object' ? raw.meta : {},
  });
}

/**
 * Render a page capture: a compact provenance header followed by raw Markdown.
 * Keeping the body unescaped is what makes a 100 KB article affordable to read.
 */
function renderPage(capture) {
  const meta = capture.meta ?? {};
  const header = [
    '---',
    `url: ${capture.url}`,
    `title: ${capture.title}`,
    `captured_at: ${capture.timestamp}`,
    `extraction: ${meta.readability_applied ? 'mozilla-readability + turndown' : 'full-body + turndown'}`,
    typeof meta.word_count === 'number' ? `word_count: ${meta.word_count}` : null,
    meta.truncated ? `truncated: true (${meta.original_chars} chars -> ${capture.markdown_content.length})` : null,
    meta.excerpt ? `excerpt: ${JSON.stringify(meta.excerpt)}` : null,
    '---',
    '',
  ]
    .filter((line) => line !== null)
    .join('\n');

  if (!capture.markdown_content.trim()) {
    return `${header}(The page produced no readable text. It may be an app shell that renders after load, a PDF viewer, or an image-only page. Try again once it has finished rendering, or disable use_readability.)`;
  }

  return header + capture.markdown_content;
}

/**
 * Advice to attach to a status report, or undefined when all is well. Order
 * matters: a bridge that never bound is the more fundamental problem, and
 * telling someone to load the extension while nothing is listening for it
 * sends them debugging Chrome instead of the port it cannot reach.
 */
function hintFor(status) {
  if (status.start_error) {
    return `The bridge is not listening, so no extension can connect. ${status.start_error}`;
  }
  if (!status.extension_connected) {
    return (
      `Nothing is connected. The server is listening on ${status.bridge_url}. Load the ` +
      `extension from the /extension folder at chrome://extensions (Developer mode -> ` +
      `Load unpacked) and confirm its popup shows "Connected".`
    );
  }
  return undefined;
}

/** Render point-and-click results as pretty JSON — these really are records. */
function renderFields(capture) {
  const fields = capture.extracted_fields;
  if (fields.length === 0) {
    return (
      'No elements are currently selected in that tab.\n\n' +
      'Open the OmniScrape popup, click "Start Selecting Elements", click the elements you want, ' +
      'then call this tool again.'
    );
  }

  const summary = fields
    .map((f) => `  - ${f.label} (${f.selector}) -> ${f.match_count} match${f.match_count === 1 ? '' : 'es'}`)
    .join('\n');

  return (
    `Extracted ${fields.length} field${fields.length === 1 ? '' : 's'} from ${capture.url}:\n${summary}\n\n` +
    '```json\n' +
    JSON.stringify(capture, null, 2) +
    '\n```'
  );
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {import('./bridge.js').ExtensionBridge} bridge
 */
export function registerTools(server, bridge) {
  // -------------------------------------------------------------------------
  // 1. Full-page capture
  // -------------------------------------------------------------------------
  server.registerTool(
    'get_active_tab_markdown',
    {
      title: 'Read the current browser tab as Markdown',
      description:
        "Scrape the main readable content of the user's current Chrome tab and return it as clean " +
        'Markdown. By default it runs Mozilla Readability first to strip navigation, ads, cookie ' +
        'banners and footers, then converts to Markdown with Turndown. Use this to read an article, ' +
        'documentation page, or any page the user is looking at and refers to without pasting it.',
      inputSchema: {
        tab_id: z
          .number()
          .int()
          .optional()
          .describe('Chrome tab id to read. Omit to use whichever tab is currently active.'),
        use_readability: z
          .boolean()
          .default(true)
          .describe(
            'Run Mozilla Readability before converting. Leave true for articles and docs. Set ' +
              'false for dashboards, search results, or any page whose value is in its lists and ' +
              'tables — Readability tends to discard those.',
          ),
        include_links: z
          .boolean()
          .default(true)
          .describe('Keep hyperlink URLs in the Markdown. Set false for prose-only output.'),
        max_chars: z
          .number()
          .int()
          .min(0)
          .default(100_000)
          .describe(
            'Truncate the Markdown at this many characters to protect the context window. ' +
              'Truncation is always reported in the response header. Use 0 for no limit.',
          ),
      },
      annotations: {
        title: 'Read tab as Markdown',
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const result = await bridge.call(METHOD.PAGE_MARKDOWN, {
          tabId: args.tab_id,
          useReadability: args.use_readability,
          includeLinks: args.include_links,
          maxChars: args.max_chars,
        });
        return text(renderPage(normalize(result)));
      } catch (error) {
        return toolError(error, 'get_active_tab_markdown');
      }
    },
  );

  // -------------------------------------------------------------------------
  // 2. Point-and-click selection capture
  // -------------------------------------------------------------------------
  server.registerTool(
    'scrape_selected_elements',
    {
      title: 'Read the elements the user point-and-clicked',
      description:
        'Return data for the specific elements the user highlighted with OmniScrape\'s ' +
        'point-and-click selector. Each selection becomes a field with its CSS selector and every ' +
        'matching value on the page, so picking one row of a table or list yields the whole ' +
        'column. Use this when the user says "scrape what I selected" or wants specific parts of a ' +
        'page rather than the whole thing. Returns an empty result if nothing is selected yet.',
      inputSchema: {
        tab_id: z
          .number()
          .int()
          .optional()
          .describe('Chrome tab id whose selection to read. Omit to use the active tab.'),
        format: z
          .enum(['markdown', 'text', 'html'])
          .default('markdown')
          .describe(
            'Representation for each matched element. "text" is the visible text, "markdown" ' +
              'preserves links/emphasis/table structure, "html" is the element\'s raw outer HTML.',
          ),
        include_attributes: z
          .boolean()
          .default(false)
          .describe('Also return href, src, title, alt and data-* attributes for each match.'),
      },
      annotations: {
        title: 'Read selected elements',
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const result = await bridge.call(METHOD.SELECTION_SCRAPE, {
          tabId: args.tab_id,
          format: args.format,
          includeAttributes: args.include_attributes,
        });
        return text(renderFields(normalize(result)));
      } catch (error) {
        return toolError(error, 'scrape_selected_elements');
      }
    },
  );

  // -------------------------------------------------------------------------
  // 3. Bridge diagnostics
  // -------------------------------------------------------------------------
  server.registerTool(
    'get_bridge_status',
    {
      title: 'Check the OmniScrape browser connection',
      description:
        'Report whether the OmniScrape Chrome extension is connected to this server, and list the ' +
        'tabs it can currently reach. Call this first when a scrape fails, to tell "the browser ' +
        'is not connected" apart from "that page could not be read".',
      inputSchema: {
        probe: z
          .boolean()
          .default(true)
          .describe('Also round-trip a ping to the extension to list reachable tabs.'),
      },
      annotations: { title: 'Check browser connection', readOnlyHint: true },
    },
    async (args) => {
      const status = bridge.status();

      if (!args.probe || !status.extension_connected) {
        return text(
          JSON.stringify(
            {
              ...status,
              hint: hintFor(status),
            },
            null,
            2,
          ),
        );
      }

      try {
        const probe = await bridge.call(METHOD.BRIDGE_PING, {}, { timeoutMs: 5_000 });
        return text(JSON.stringify({ ...status, probe }, null, 2));
      } catch (error) {
        return text(
          JSON.stringify(
            {
              ...status,
              probe_failed: { code: error.code ?? 'internal_error', message: error.message },
            },
            null,
            2,
          ),
        );
      }
    },
  );

  logger.debug('registered tools', {
    tools: ['get_active_tab_markdown', 'scrape_selected_elements', 'get_bridge_status'],
    timeout_ms: config.requestTimeoutMs,
  });
}
