#!/usr/bin/env node
// Flashback MCP server — a third client of the Express API (alongside the React
// renderer and any script that hits it directly). Never imports src/api/access/;
// every tool call goes over HTTP to an already-running Flashback API process.
//
// Connect a base URL with FLASHBACK_API_URL (defaults to http://localhost:50500,
// the port ConfigJSON.js ships as default). The Flashback app (or `npm run dev:api`)
// must already be running — this process does not spawn or manage it.
//
// IMPORTANT: this transport is stdio, so stdout is reserved for JSON-RPC frames.
// Never console.log() here — use console.error() for anything diagnostic.

import fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerReadTools } from './tools/read.js';
import { registerWriteTools } from './tools/write.js';
import { getBaseUrl } from './client.js';

/** The server-level guidance every client reads on connect; the prose lives in INSTRUCTIONS.md. */
const INSTRUCTIONS = fs.readFileSync(new URL('./INSTRUCTIONS.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n').trim();

const server = new McpServer({ name: 'flashback', version: '0.3.0' }, { instructions: INSTRUCTIONS });

registerReadTools(server);
registerWriteTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);

console.error(`[flashback-mcp] connected, talking to ${getBaseUrl()}`);
