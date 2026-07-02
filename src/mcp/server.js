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

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerReadTools } from './tools/read.js';
import { registerWriteTools } from './tools/write.js';
import { getBaseUrl } from './client.js';

// Shown to the model up front, before any tool is called — this is the place for
// concepts that don't belong on any single tool's schema (data-model shape, field
// semantics, cross-tool relationships). Added after live testing showed an agent
// had to reverse-engineer the deck/level model from a stack trace and incidental
// return payloads instead of being told; see Backlog.md #38/#39 discussion.
const INSTRUCTIONS = `
Flashback is a local spaced-repetition knowledge vault. A few things aren't obvious from
individual tool schemas alone:

- Cards have a \`cardType\`: basic, reversible, cloze, type_answer, or custom. Non-custom types
  store their content in \`vanillaData\` (frontText/backText/media); "custom" stores raw HTML in
  \`customData.html\` instead and ignores vanillaData. This is a real storage split, not just an
  API convenience — call list_categories before setting \`category\` on a card, since an
  unrecognized value is silently dropped rather than rejected.
- Every card has a \`level\` field: it's the card's spaced-repetition strength, starting at 0 for
  a never-reviewed card and increasing after each correct review (Leitner box number, or grade
  history under SM-2 — either way, higher = better known, 0 = new).
- Decks link to cards by hash; cards aren't copied into a deck. One deck always has
  \`is_system: 1\` — it's the automatic home for cards with no source document. Create a
  document-less card with create_flashcard (omit \`path\`) and it lands there on its own; you
  generally don't need to call add_to_deck on it yourself.
- Before creating content, list_categories, list_decks, and list_tags are cheap ways to see
  what already exists rather than guessing or duplicating.
`.trim();

const server = new McpServer({ name: 'flashback', version: '0.1.0' }, { instructions: INSTRUCTIONS });

registerReadTools(server);
registerWriteTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);

console.error(`[flashback-mcp] connected, talking to ${getBaseUrl()}`);
