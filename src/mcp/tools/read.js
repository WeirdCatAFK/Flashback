import { z } from 'zod';
import { request } from '../client.js';

const asText = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const asError = (err) => ({
  content: [{ type: 'text', text: `Flashback API error${err.status ? ` (${err.status})` : ''}: ${err.message}` }],
  isError: true,
});

// Wraps a tool handler so a failed fetch (API down, 404, etc.) comes back as a
// clean tool error instead of an unhandled rejection.
const safe = (fn) => async (args) => {
  try {
    return await fn(args);
  } catch (err) {
    return asError(err);
  }
};

function qs(params) {
  const parts = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const v of value) parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
    }
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

export function registerReadTools(server) {
  server.registerTool(
    'search_flashback',
    {
      title: 'Search Flashback',
      description:
        'Search the vault. Global mode (query only) matches against actual content — folder/document/deck ' +
        'NAMES, tag names, and flashcard frontText/backText/name — and returns results grouped by type. It does ' +
        'NOT search by theme or association: querying a deck\'s name won\'t surface cards inside it unless the ' +
        'name literally appears in the card text too (use `deck` filter mode, or list_decks + get_graph, to ' +
        'browse a deck\'s actual contents). Filter mode (any of tag/deck/document/folder) returns only ' +
        'flashcards matching all supplied filters — mirrors the in-app Ctrl+K search modal. Flashcard results ' +
        'include `level` (spaced-repetition strength, 0 = new) alongside their content.',
      inputSchema: {
        query: z.string().optional().describe('Free-text query for global mode. Omit if using filters only.'),
        tag: z.string().optional().describe('Restrict to flashcards tagged with this name.'),
        deck: z.string().optional().describe('Restrict to flashcards in this deck — accepts either the exact globalHash or a name substring.'),
        document: z.string().optional().describe('Restrict to flashcards in this document (relative path).'),
        folder: z.string().optional().describe('Restrict to flashcards under this folder (relative path, recursive).'),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    safe(async ({ query, tag, deck, document, folder, limit }) => {
      const data = await request(
        'GET',
        `/api/search${qs({ q: query, tag, deck, document, folder, limit })}`,
      );
      return asText(data);
    }),
  );

  server.registerTool(
    'list_folder',
    {
      title: 'List folder',
      description: 'List the documents and subfolders directly inside a workspace folder. Omit path for the workspace root.',
      inputSchema: {
        path: z.string().optional().describe('Relative path from the workspace root. Omit or empty string for root.'),
      },
    },
    safe(async ({ path } = {}) => {
      const data = await request('GET', `/api/documents/list${qs({ path: path ?? '' })}`);
      return asText(data);
    }),
  );

  server.registerTool(
    'read_document',
    {
      title: 'Read document',
      description:
        'Read a document\'s full content plus its sidecar metadata (existing flashcards, tags, highlights). ' +
        'Use this before drafting new cards so you can see what the document already covers.',
      inputSchema: {
        path: z.string().describe('Relative path to the document from the workspace root.'),
      },
    },
    safe(async ({ path }) => {
      const data = await request('GET', `/api/documents/read${qs({ path })}`);
      return asText(data);
    }),
  );

  server.registerTool(
    'get_due_cards',
    {
      title: 'Get due cards',
      description:
        'List flashcards that are due or new for review, optionally scoped by folder, deck, tags, or minimum ' +
        'pedagogical priority. Each card\'s `level` is its spaced-repetition strength (0 = never reviewed, ' +
        'higher = better known) — not a difficulty rating you set, it changes automatically as the card is reviewed.',
      inputSchema: {
        folder: z.string().optional().describe('Restrict to a folder subtree (relative path).'),
        deck: z.string().optional().describe('Restrict to a deck (by globalHash).'),
        tags: z.array(z.string()).optional().describe('Restrict to cards carrying any of these tags.'),
        minPriority: z.number().int().optional().describe('Only include cards whose category priority >= this value.'),
        maxNew: z.number().int().optional().describe('Cap on how many never-reviewed cards to include.'),
      },
    },
    safe(async ({ folder, deck, tags, minPriority, maxNew }) => {
      const data = await request(
        'GET',
        `/api/srs/due${qs({ folder, deck, tag: tags, minPriority, maxNew })}`,
      );
      return asText(data);
    }),
  );

  server.registerTool(
    'list_decks',
    {
      title: 'List decks',
      description:
        'List every deck in the vault. Exactly one has `is_system: 1` — it automatically holds every ' +
        'document-less card (created via create_flashcard with no `path`) and you should not need to call ' +
        'add_to_deck on it directly; use create_deck for a named deck to organize cards into instead.',
      inputSchema: {},
    },
    safe(async () => {
      const data = await request('GET', '/api/decks');
      return asText(data);
    }),
  );

  server.registerTool(
    'list_tags',
    {
      title: 'List tags',
      description: 'List every tag already used in the vault, so new content can reuse existing tags instead of creating near-duplicates.',
      inputSchema: {},
    },
    safe(async () => {
      const data = await request('GET', '/api/documents/tags');
      return asText(data);
    }),
  );

  server.registerTool(
    'list_categories',
    {
      title: 'List pedagogical categories',
      description:
        'List the valid pedagogical category names (e.g. "Concept", "Definition") that can be passed as ' +
        '`category` to create_flashcard, along with each one\'s review priority (lower = studied first).',
      inputSchema: {},
    },
    safe(async () => {
      const data = await request('GET', '/api/categories');
      return asText(data);
    }),
  );

  server.registerTool(
    'get_graph',
    {
      title: 'Get knowledge graph',
      description: 'Return the full node/edge graph of the vault (documents, folders, flashcards, tags, decks and their connections). Coarse-grained — useful for reasoning about topic coverage, not for reading specific card content.',
      inputSchema: {},
    },
    safe(async () => {
      const data = await request('GET', '/api/documents/graph');
      return asText(data);
    }),
  );
}
