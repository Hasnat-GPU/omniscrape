/**
 * CaptureInbox — a bounded, in-memory ring of captures the user pushed from the
 * extension with the "Send to Claude" button.
 *
 * The reason this exists: MCP tool calls are *pull*-shaped. Claude asks, the
 * server answers. But the user pressing a button in a browser popup is a *push*,
 * with no tool call in flight to attach it to. MCP models that as resources —
 * the server holds the data, advertises it, notifies on change, and Claude reads
 * it when relevant. So pushes land here and `resources.js` exposes them.
 *
 * Nothing is persisted to disk. Scraped pages can contain anything the user was
 * logged into, so it lives for the process lifetime and no longer.
 */

import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { logger } from './logger.js';
import { makeCapture } from './protocol.js';

export class CaptureInbox {
  /** @param {{max?: number, onChange?: () => void}} [options] */
  constructor(options = {}) {
    this.max = options.max ?? config.inboxMax;
    this.onChange = options.onChange ?? (() => {});
    /** @type {Array<{id: string, receivedAt: string, capture: object}>} Newest first. */
    this.items = [];
  }

  /**
   * Store a capture. Returns the stored record (with its generated id).
   * Unknown/partial payloads are normalised rather than rejected — a capture
   * that arrives slightly malformed is still worth keeping.
   */
  add(payload) {
    const capture = makeCapture({
      url: payload?.url,
      title: payload?.title,
      timestamp: payload?.timestamp,
      markdown_content: payload?.markdown_content,
      extracted_fields: Array.isArray(payload?.extracted_fields) ? payload.extracted_fields : [],
      meta: payload?.meta && typeof payload.meta === 'object' ? payload.meta : {},
    });

    const record = {
      id: randomUUID(),
      receivedAt: new Date().toISOString(),
      capture,
    };

    this.items.unshift(record);
    if (this.items.length > this.max) {
      this.items.length = this.max; // drop the oldest
    }

    logger.info('capture received', {
      id: record.id,
      url: capture.url,
      markdown_chars: capture.markdown_content.length,
      fields: capture.extracted_fields.length,
    });

    this.onChange();
    return record;
  }

  /** Newest-first list of lightweight descriptors (no page bodies). */
  list() {
    return this.items.map((item) => ({
      id: item.id,
      received_at: item.receivedAt,
      url: item.capture.url,
      title: item.capture.title,
      markdown_chars: item.capture.markdown_content.length,
      field_count: item.capture.extracted_fields.length,
    }));
  }

  /** @returns {{id: string, receivedAt: string, capture: object}|undefined} */
  get(id) {
    return this.items.find((item) => item.id === id);
  }

  /** The most recent capture, or undefined when the inbox is empty. */
  latest() {
    return this.items[0];
  }

  /** Number of stored captures. */
  get size() {
    return this.items.length;
  }

  /** Drop everything. */
  clear() {
    const had = this.items.length;
    this.items = [];
    if (had > 0) this.onChange();
    return had;
  }
}
