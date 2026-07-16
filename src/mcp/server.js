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

- Cards are either DOCUMENT-ANCHORED (created with a \`path\`; they live in that document's
  sidecar) or STANDALONE (no path; they live in the system deck). update_flashcard and
  delete_flashcard work on both and resolve the card's home automatically; passing
  \`documentPath\` (from search_flashback/list_cards \`document_path\`) just skips the lookup.
- Documents wiki-link to each other with \`[anchor text](flashback://<document globalHash>)\`
  in Markdown — hashes come from search results or a folder listing's metadata. Use this
  syntax when writing notes that should reference other notes; get_links shows a document's
  outgoing links and backlinks.
- Cards have a \`cardType\`: basic, reversible, cloze, type_answer, or custom. Non-custom types
  store their content in \`vanillaData\` (frontText/backText/media); "custom" stores raw HTML in
  \`customData.html\` instead and ignores vanillaData. This is a real storage split, not just an
  API convenience. Call list_categories before setting \`category\` on a card — an unrecognized
  name is rejected with an error.
- Every card has a \`level\` field: it's the card's spaced-repetition strength, starting at 0 for
  a never-reviewed card and increasing after each correct review — higher = better known, 0 = new.
  Reviewing is the user's job: there is deliberately no tool to submit review grades.
- Decks link to cards by hash; cards aren't copied into a deck (delete_deck keeps the cards,
  delete_flashcard destroys one). One deck always has \`is_system: 1\` — it's the automatic home
  for cards with no source document. Create a document-less card with create_flashcard (omit
  \`path\`) and it lands there on its own; you generally don't need to call add_to_deck on it
  yourself. Deck tags (update_deck) propagate to every member card.
- Sidecar changes (cards, tags, highlights) are versioned by Seal, the built-in git layer.
  Document BODY text is not — update_document overwrites irreversibly, so read_document first.
- Every card records its provenance in \`origin\`: cards created through these tools are marked
  'ai' automatically; handmade cards have no origin. The core highlight→card workflow: the user
  highlights passages while reading, you turn them into flashcards. list_highlights (with
  \`uncardedOnly\`) shows which highlights still lack a card, with the highlighted text and its
  surrounding context; anchor each new card to its source passage by passing the highlight's
  \`id\` as create_flashcard's \`highlightHash\`. Before drafting, study the vault's existing
  cards and MATCH THEIR STYLE (length, tone, phrasing, cloze conventions) — prefer handmade
  cards as examples (list_cards with origin 'human'), falling back to AI-made ones only when
  the vault has no handmade cards.
- Before creating content, list_categories, list_decks, and list_tags are cheap ways to see
  what already exists rather than guessing or duplicating.
- The diary tools (diary_list/diary_get_summary/diary_get_entry) read a personal, per-day study
  record kept outside the vault. They are OFF by default: unless the user has enabled diary access
  for AI assistants in Flashback's settings, every diary call returns a 403. Don't retry on that
  error — tell the user how to enable it if they want you to use it. Entries are private prose;
  treat anything you do read as confidential.
`.trim();

const server = new McpServer({ name: 'flashback', version: '0.3.0' }, { instructions: INSTRUCTIONS });

registerReadTools(server);
registerWriteTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);

console.error(`[flashback-mcp] connected, talking to ${getBaseUrl()}`);
