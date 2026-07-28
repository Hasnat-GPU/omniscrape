/**
 * MCP resources exposing the capture inbox.
 *
 * Tools cover the pull direction (Claude asks for a page). Resources cover the
 * push direction: the user hits "Send to Claude" in the extension, the capture
 * lands in the inbox, and we fire `notifications/resources/list_changed` so the
 * client knows fresh material is available to read.
 *
 *   omniscrape://captures          index of everything received this session
 *   omniscrape://captures/latest   the most recent capture
 *   omniscrape://captures/{id}     one specific capture by id
 */

import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { logger } from './logger.js';

const MIME_JSON = 'application/json';
const MIME_MARKDOWN = 'text/markdown';

/** Render a stored capture the way a reader wants it: header, then body. */
function renderCapture(record) {
  const { capture } = record;
  const lines = [
    '---',
    `capture_id: ${record.id}`,
    `url: ${capture.url}`,
    `title: ${capture.title}`,
    `captured_at: ${capture.timestamp}`,
    `received_at: ${record.receivedAt}`,
    `fields: ${capture.extracted_fields.length}`,
    '---',
    '',
  ];

  if (capture.extracted_fields.length > 0) {
    lines.push('## Extracted fields', '', '```json', JSON.stringify(capture.extracted_fields, null, 2), '```', '');
  }

  if (capture.markdown_content.trim()) {
    lines.push('## Page content', '', capture.markdown_content);
  }

  return lines.join('\n');
}

/**
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {import('./inbox.js').CaptureInbox} inbox
 */
export function registerResources(server, inbox) {
  // Index of the inbox. Cheap to read — descriptors only, no page bodies.
  server.registerResource(
    'captures-index',
    'omniscrape://captures',
    {
      title: 'OmniScrape captures',
      description:
        'Index of pages and selections the user has pushed from the browser with "Send to Claude" ' +
        'during this session. Read an individual entry at omniscrape://captures/{id}.',
      mimeType: MIME_JSON,
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: MIME_JSON,
          text: JSON.stringify({ count: inbox.size, captures: inbox.list() }, null, 2),
        },
      ],
    }),
  );

  // Convenience alias so Claude can grab the newest push without an id lookup.
  server.registerResource(
    'capture-latest',
    'omniscrape://captures/latest',
    {
      title: 'Latest OmniScrape capture',
      description: 'The most recent page or selection the user pushed from the browser.',
      mimeType: MIME_MARKDOWN,
    },
    async (uri) => {
      const record = inbox.latest();
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: MIME_MARKDOWN,
            text: record
              ? renderCapture(record)
              : 'No captures yet. In Chrome, open the OmniScrape popup and press "Send to Claude".',
          },
        ],
      };
    },
  );

  // One capture by id, with a list callback so clients can enumerate them.
  server.registerResource(
    'capture',
    new ResourceTemplate('omniscrape://captures/{id}', {
      list: async () => ({
        resources: inbox.list().map((item) => ({
          uri: `omniscrape://captures/${item.id}`,
          name: item.title || item.url || item.id,
          description:
            `Pushed ${item.received_at} from ${item.url} ` +
            `(${item.markdown_chars} chars, ${item.field_count} field(s))`,
          mimeType: MIME_MARKDOWN,
        })),
      }),
    }),
    {
      title: 'OmniScrape capture',
      description: 'A single page or selection pushed from the browser.',
      mimeType: MIME_MARKDOWN,
    },
    async (uri, variables) => {
      const id = Array.isArray(variables.id) ? variables.id[0] : variables.id;

      // `omniscrape://captures/latest` also matches this template, so honour it.
      const record = id === 'latest' ? inbox.latest() : inbox.get(id);

      if (!record) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: MIME_MARKDOWN,
              text: `No capture with id "${id}". Read omniscrape://captures for the current index.`,
            },
          ],
        };
      }

      return {
        contents: [{ uri: uri.href, mimeType: MIME_MARKDOWN, text: renderCapture(record) }],
      };
    },
  );

  logger.debug('registered resources', {
    uris: ['omniscrape://captures', 'omniscrape://captures/latest', 'omniscrape://captures/{id}'],
  });
}
