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

const INSTRUCTIONS = `
Flashback is a local spaced-repetition knowledge vault. A few things aren't obvious from
individual tool schemas alone:

- THE ONE RULE FOR MAKING CARDS: every card you create comes from a highlight the USER made.
  create_flashcard requires a document \`path\` and the \`highlightHash\` of one of the user's
  highlights there, and there is no tool to highlight for them. This keeps AI cards on what the
  user chose as worth remembering and under their supervision; it exists so cards are never
  mass-produced from a document. Read freely for CONTEXT — the whole document, the passage around
  a highlight — but card only what a highlight marks. When asked to card something no highlight
  covers, say which passage the user should highlight in the app and card it once they have;
  never look for a way around the rule. One highlight may become several cards.
- Cards are either DOCUMENT-ANCHORED (they live in that document's sidecar) or STANDALONE
  (the user's own document-less cards, in the system deck). update_flashcard and
  delete_flashcard work on both and resolve the card's home automatically; passing
  \`documentPath\` (from search_flashback/list_cards \`document_path\`) just skips the lookup.
- Documents wiki-link to each other with \`[anchor text](flashback://<document globalHash>)\`
  in Markdown — hashes come from search results or a folder listing's metadata. Use this
  syntax when writing notes that should reference other notes; get_links shows a document's
  outgoing links and backlinks.
- Cards have a \`cardType\`: basic, reversible, cloze, type_answer, or custom. Non-custom types
  store their content in \`vanillaData\` (frontText/backText/media); "type_answer" adds
  \`answerText\`, the value compared to what the user types, which frees its backText to hold
  post-review notes like a mnemonic. "custom" stores raw HTML in
  \`customData.html\` instead and ignores vanillaData. This is a real storage split, not just an
  API convenience. Call list_categories before setting \`category\` on a card — an unrecognized
  name is rejected with an error.
- One reading rule for type_answer, because both shapes exist: a card written before
  \`answerText\` has it null/absent and still keeps its graded answer in \`backText\`. So the
  compared value is \`answerText\` when present, \`backText\` otherwise — and a card is only
  carrying notes when \`answerText\` is present. Read a null \`answerText\` as "this card is in
  the old shape", never as "this card has no answer". If you split one yourself with
  update_flashcard, move the text: send the answer as \`answerText\` AND send the new
  \`backText\` in the same call, or the old answer stays behind and reads as notes.
- How well a card is held is its GAP: the days between its reviews under the user's scheduler
  (\`gap\` in list_cards, null = never reviewed). The app groups cards into bands by it — new,
  up to 1 day, a week, 3 weeks, 2 months, longer — and a gap of 21+ days counts as held
  long-term; decks, sources and the Statistics report are all summed up that way. Speak in those
  terms. \`level\` is the scheduler's raw strength (0 = new, higher = better known); it means
  different things under Leitner, SM-2 and FSRS, so it is no longer what the app shows.
  get_card_overview is the one-call picture: cards per band, per source document, and flagged.
  Reviewing is the user's job: there is deliberately no tool to submit review grades.
- Decks link to cards by hash; cards aren't copied into a deck (delete_deck keeps the cards,
  delete_flashcard destroys one). One deck always has \`is_system: 1\` — it's the automatic home
  for the user's cards with no source document, and you don't need to call add_to_deck on it.
  Deck tags (update_deck) propagate to every member card.
- Answers are SMALL by default, because a vault's raw payloads run to hundreds of thousands of
  characters: list_folder gives names and counts, read_document counts a sidecar's cards and
  highlights instead of listing them, get_due_cards gives counts per source, list_cards clips
  card text. Each tool names the opt-in for the rest (sidecar: "full", queueLimit, verbose).
  search_flashback caps every group and says so in \`truncated\`; list_cards pages exhaustively.
- Cleaning up many cards is delete_flashcards: a dry run first (count, sources, sample), shown
  to the user, then the same selection with confirm and the previewed count. Never loop
  delete_flashcard over a large set.
- Sidecar changes (cards, tags, highlights) are versioned by Seal, the built-in git layer.
  Document BODY text is not — update_document overwrites irreversibly, so read_document first.
- Every card records its provenance in \`origin\`: cards created through these tools are marked
  'ai' automatically, imported ones 'import'; handmade cards have no origin (nor do cards imported
  before imports were marked, so treat a null origin as "made by the user or imported"). The workflow: the user highlights passages
  while reading, you turn them into flashcards. list_highlights (with \`uncardedOnly\`) shows which
  highlights still lack a card, with the highlighted text and its surrounding context; pass the
  highlight's \`documentPath\` and \`id\` to create_flashcard. Before drafting, study the vault's existing
  cards and MATCH THEIR STYLE (length, tone, phrasing, cloze conventions) — prefer handmade
  cards as examples (list_cards with origin 'human'), falling back to AI-made ones only when
  the vault has no handmade cards.
- Two kinds of document carry pictures that are reachable even though their prose arrives as plain
  text, and each has the same three tools: list (metadata), view (look at one), attach (put it on
  a card). An EPUB's figures: list_book_images / view_book_image / attach_book_image — those live
  inside the book's zip and have no path on disk, so attach_media cannot reach them. A saved web
  clip's downloaded pictures and short audio: list_clip_media / view_clip_image / attach_clip_media
  — a clip's assets ARE real files, so attach_media works on them too once you have their \`path\`.
  Check list_clip_media for sound on language, music and medical pages: a pronunciation recording
  makes a far better card front than a written description of one. Nothing can play audio to you,
  so view_clip_image refuses a sound and you go by its caption and heading instead. Those two view
  tools are the only place bytes flow to you, and only because a picture IS its bytes; there is
  deliberately no equivalent for PDF pages or document bodies.
- Writing a good card is a craft with real rules, and get_card_guide is where they are written
  down: decomposition, card-type selection, the house conventions this vault already follows,
  and the failure modes that make a card lapse for years. Read it before drafting cards or
  diagnosing ones that keep failing — not after.
- Before creating content, list_categories, list_decks, and list_tags are cheap ways to see
  what already exists rather than guessing or duplicating. Categories sit on priority levels
  (several per level, level 1 studied first); tags come with their reach, and rename_tag merges
  near-duplicates vault-wide.
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
