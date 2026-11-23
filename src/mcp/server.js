#!/usr/bin/env node
/** The stdio transport sends JSON-RPC frames on stdout. Write diagnostics with console.error only. */
import fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerReadTools } from './tools/read.js';
import { registerWriteTools } from './tools/write.js';
import { getBaseUrl } from './client.js';

const INSTRUCTIONS = fs.readFileSync(new URL('./INSTRUCTIONS.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n').trim();

const server = new McpServer({ name: 'flashback', version: '0.3.0' }, { instructions: INSTRUCTIONS });

registerReadTools(server);
registerWriteTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);

console.error(`[flashback-mcp] connected, talking to ${getBaseUrl()}`);
