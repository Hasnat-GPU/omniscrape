#!/usr/bin/env node
/**
 * OmniScrape MCP server — entry point.
 *
 * Two transports run side by side in this one process:
 *
 *   stdio  <- JSON-RPC with the MCP client (Claude Desktop / Claude Code)
 *   ws     <- the OmniScrape Chrome extension on 127.0.0.1
 *
 * A tool call arrives on stdio, becomes a request on the WebSocket, the
 * extension scrapes the live DOM, and the answer travels back the same way.
 *
 * Reminder that governs this whole file: stdout is the MCP channel. Diagnostics
 * go to stderr via `logger`, never `console.log`.
 */

import process from 'node:process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { config, bridgeUrl, healthUrl } from './config.js';
import { logger } from './logger.js';
import { ExtensionBridge } from './bridge.js';
import { CaptureInbox } from './inbox.js';
import { registerTools } from './tools.js';
import { registerResources } from './resources.js';
import { EVENT } from './protocol.js';

async function main() {
  // ---------------------------------------------------------------------------
  // MCP server
  // ---------------------------------------------------------------------------
  const server = new McpServer(
    { name: config.name, version: config.version },
    {
      instructions:
        'OmniScrape gives you eyes on the user\'s live Chrome browser. Use ' +
        '`get_active_tab_markdown` when the user refers to a page they are looking at without ' +
        'pasting it. Use `scrape_selected_elements` when they have point-and-clicked specific ' +
        'elements, or ask for "what I selected". If either fails, call `get_bridge_status` to see ' +
        'whether the browser is connected at all. Pages the user pushes with the extension\'s ' +
        '"Send to Claude" button appear as resources under omniscrape://captures.',
    },
  );

  // ---------------------------------------------------------------------------
  // Bridge + inbox
  // ---------------------------------------------------------------------------
  const bridge = new ExtensionBridge();

  const inbox = new CaptureInbox({
    max: config.inboxMax,
    // Tell the MCP client that the resource list changed, so a pushed capture
    // becomes visible without the user having to prompt for a refresh.
    onChange: () => {
      try {
        if (server.isConnected()) server.sendResourceListChanged();
      } catch (error) {
        logger.debug('resource list notification failed', { error: error.message });
      }
    },
  });
  bridge.attachInbox(inbox);

  // "Send to Claude" in the extension arrives as an unsolicited event.
  bridge.on(`event:${EVENT.CAPTURE}`, (payload) => {
    inbox.add(payload);
  });

  bridge.on('connect', () => {
    logger.info('browser available', { clients: bridge.clients.size });
  });
  bridge.on('disconnect', () => {
    logger.info('browser unavailable', { clients: bridge.clients.size });
  });

  registerTools(server, bridge);
  registerResources(server, inbox);

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------
  // Order matters, and stdio goes first. The bridge binds a fixed TCP port, so
  // it can fail for reasons that have nothing to do with MCP: a stale server
  // from a previous session, or anything else that happens to own port 3000.
  // Letting that failure escape would kill the process during the MCP handshake
  // and register no tools at all, leaving the agent to conclude the server does
  // not exist. A server whose tools can explain the outage is far more useful
  // than no server, so connect the transport first and treat a dead bridge as a
  // degraded state rather than a fatal one.
  const transport = new StdioServerTransport();
  await server.connect(transport);

  try {
    await bridge.start();
  } catch (error) {
    logger.exception('bridge failed to start; serving in degraded mode', error);
  }

  logger.info('mcp server ready', {
    name: config.name,
    version: config.version,
    bridge: bridgeUrl(),
    health: healthUrl(),
    bridge_listening: bridge.started,
  });

  // ---------------------------------------------------------------------------
  // Shutdown
  // ---------------------------------------------------------------------------
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });
    try {
      await bridge.stop();
      await server.close();
    } catch (error) {
      logger.exception('error during shutdown', error);
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // MCP clients signal "stop" by closing our stdin. Without this the process
  // would linger after Claude Desktop quits, holding port 3000 hostage.
  process.stdin.on('close', () => void shutdown('stdin-close'));

  // Never let an unexpected throw take the process down silently — a dead MCP
  // server with no explanation is the worst debugging experience there is.
  process.on('uncaughtException', (error) => {
    logger.exception('uncaught exception', error);
  });
  process.on('unhandledRejection', (reason) => {
    logger.exception('unhandled rejection', reason instanceof Error ? reason : new Error(String(reason)));
  });
}

main().catch((error) => {
  logger.exception('fatal: server failed to start', error);
  process.exit(1);
});
