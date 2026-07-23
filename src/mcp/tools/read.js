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
        'Use this before drafting new cards so you can see what the document already covers. ' +
        'Only TEXT documents (Markdown, plain text, and the app\'s .clip/.youtube stubs) return a readable `content` ' +
        'HERE. For a PDF, EPUB, image, audio or video document this returns `content: null` — this does NOT mean ' +
        'the text is unavailable: it means the body is not plain text and you must read it with the companion tool ' +
        '**read_document_text**, which extracts and paginates it (PDF by page, EPUB by section). Rule of thumb: if ' +
        '`content` comes back null, immediately call read_document_text with the SAME path — never conclude the ' +
        'document is unreadable. The response also spells out the exact next call.',
      inputSchema: {
        path: z.string().describe('Relative path to the document from the workspace root.'),
      },
    },
    safe(async ({ path }) => {
      const data = await request('GET', `/api/documents/read${qs({ path })}`);
      // A PDF/EPUB/media body is bytes. Decoding it would hand back megabytes of
      // mojibake, so say what the file is and route to the tool that CAN read it —
      // with its real unit count, so the next call is obvious.
      if (data.binary) {
        const kb = data.size != null ? `${Math.max(1, Math.round(data.size / 1024)).toLocaleString()} KB` : 'unknown size';
        const cards = data.metadata?.flashcards?.length ?? 0;
        const highlights = data.metadata?.highlights?.length ?? 0;
        // Best-effort: if the format is extractable, lead with that. A failure here
        // (unsupported format, scanned PDF) just means no such line.
        let readable = null;
        try {
          const info = await request('GET', `/api/reader/info${qs({ path })}`);
          if (info.extractable) {
            readable = info.unit === 'chars'
              ? `- read_document_text with path="${path}" — its text (${info.total.toLocaleString()} characters), a window at a time.`
              : `- read_document_text with path="${path}" — its text, ${info.unit} by ${info.unit} (${info.total} ${info.unit}${info.total === 1 ? '' : 's'}). Start with index=1.`;
          } else if (info.note) {
            readable = `- read_document_text does not help here: ${info.note}`;
          }
        } catch { /* not an extractable format — the other routes still apply */ }

        return {
          content: [{
            type: 'text',
            text:
              `${path} is a binary document (${kb}); its bytes cannot be read as text through THIS tool, and ` +
              `any text you appear to "read" from it would be garbage.\n\n` +
              `What is available instead:\n` +
              (readable ? `${readable}\n` : '') +
              `- list_highlights with path="${path}" — the passages the user highlighted while reading, with ` +
              `surrounding context (${highlights} highlight${highlights === 1 ? '' : 's'} on this one).\n` +
              `- list_cards / search_flashback — the ${cards} flashcard${cards === 1 ? '' : 's'} already made from it.\n` +
              `- The sidecar metadata below (tags, cards, highlights) is complete and safe to act on.\n\n` +
              `Do NOT call update_document on this path: it writes text over the whole body and is refused ` +
              `for this format.\n\n` +
              JSON.stringify({ path, binary: true, size: data.size, metadata: data.metadata }, null, 2),
          }],
        };
      }
      return asText(data);
    }),
  );

  server.registerTool(
    'read_document_text',
    {
      title: 'Read PDF / EPUB / long text (paginated)',
      description:
        'Get the readable TEXT of a PDF, an EPUB, or a saved web clip — the formats read_document returns as ' +
        '`content: null` — or a window of a long text file. THIS is how you read a PDF or EPUB; a null `content` ' +
        'from read_document is not a dead end, it is the signal to call this. Extraction happens on the server; ' +
        'you get plain UTF-8. ' +
        'ADDRESSING FOLLOWS THE FORMAT: a PDF is read by `index` = page number (1-based, `count` for a few ' +
        'pages at once), an EPUB by `index` = spine section number or its href, Markdown/text/clips by ' +
        '`offset`/`limit` character window. Call it with only `path` to get the first unit, then follow ' +
        '`next` (and `nextCharOffset` if `truncated`) until `hasMore` is false. Each response reports ' +
        '`total` (pages, sections, or characters) and a `label` such as "p. 37" — cite that label when a ' +
        'card comes from a specific place. Scanned PDFs have no text layer and return nothing readable. ' +
        'This is READ-ONLY and returns a FRAGMENT: never pass its output to update_document, which ' +
        'overwrites an entire body — and which refuses these formats anyway.',
      inputSchema: {
        path: z.string().describe('Relative path to the document from the workspace root.'),
        index: z.union([z.number().int(), z.string()]).optional().describe('PDF: page number (1-based). EPUB: section number (1-based) or its spine href. Ignored for text formats. Default 1.'),
        count: z.number().int().min(1).max(10).optional().describe('How many pages/sections to return in one call. Default 1.'),
        offset: z.number().int().min(0).optional().describe('Text formats only: character offset to start at. Default 0.'),
        limit: z.number().int().min(1).optional().describe('Text formats only: how many characters to return. Capped server-side.'),
        charOffset: z.number().int().min(0).optional().describe('Resume inside a single oversized page/section — pass the `nextCharOffset` from a truncated response.'),
      },
    },
    safe(async ({ path, index, count, offset, limit, charOffset }) => {
      const data = await request('GET', `/api/reader/read${qs({ path, index, count, offset, limit, charOffset })}`);
      return asText(data);
    }),
  );

  server.registerTool(
    'list_highlights',
    {
      title: 'List highlights',
      description:
        'List highlights with everything needed to act on them: the highlighted text, ~200 chars of ' +
        'surrounding document context, the user\'s note/color, and which flashcards already anchor to each ' +
        'one (`hasCards`/`cardHashes`). Vault-wide by default; pass `path` to scope to one document. This is ' +
        'the entry point for the highlight→flashcard workflow: the user highlights passages while reading, ' +
        'you turn them into cards. Use `uncardedOnly` to find the highlights still waiting for a card, then ' +
        'create_flashcard with `highlightHash` set to the highlight\'s `id` so the card stays anchored to its ' +
        'source passage. Before writing the cards, look at the vault\'s existing HANDMADE cards (list_cards ' +
        'with origin "human" — prefer them over AI-made ones as style examples) and match their conventions.',
      inputSchema: {
        path: z.string().optional().describe('Relative path to one document. Omit for a vault-wide listing.'),
        color: z.enum(['amber', 'green', 'blue', 'pink']).optional().describe('Only highlights of this color. Users sometimes reserve a color for "make a card of this" — ask before assuming.'),
        uncardedOnly: z.boolean().optional().describe('Only highlights that no flashcard anchors to yet.'),
        limit: z.number().int().min(1).max(500).optional().describe('Max highlights to return, newest first. Default 100.'),
      },
    },
    safe(async ({ path, color, uncardedOnly, limit } = {}) => {
      const data = await request(
        'GET',
        `/api/highlights/annotated${qs({ path, color, uncarded: uncardedOnly ? 'true' : undefined, limit })}`,
      );
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
        algorithm: z.enum(['leitner', 'sm2', 'fsrs']).optional().describe('Scheduling algorithm to compute dueness with. Should match the algorithm the user reviews with (a UI preference the server cannot see); the server default is used if omitted.'),
      },
    },
    safe(async ({ folder, deck, tags, minPriority, maxNew, algorithm }) => {
      const data = await request(
        'GET',
        `/api/srs/due${qs({ folder, deck, tag: tags, minPriority, maxNew, algorithm })}`,
      );
      return asText(data);
    }),
  );

  server.registerTool(
    'get_statistics',
    {
      title: 'Get study statistics',
      description:
        'Vault-wide spaced-repetition analytics: retention rate, card maturity distribution, due-date ' +
        'forecast, review activity heatmap, and streaks — the same data as the app\'s Stats view. Read-only. ' +
        'Retention counts only reviews past a card\'s learning phase (its first few reviews); the learning ' +
        'phase is reported separately in `acquisition` (new-card pass rate, first-recall rate, attempts to learn a card).',
      inputSchema: {
        algorithm: z.enum(['leitner', 'sm2', 'fsrs']).optional().describe('Algorithm to compute schedule-dependent stats with. Should match the user\'s reviewing algorithm; server default if omitted.'),
      },
    },
    safe(async ({ algorithm } = {}) => {
      const data = await request('GET', `/api/srs/statistics${qs({ algorithm })}`);
      return asText(data);
    }),
  );

  server.registerTool(
    'list_cards',
    {
      title: 'List cards',
      description:
        'Browse every flashcard in the vault with filters, sorting, and pagination — unlike search_flashback ' +
        '(fuzzy text match, capped results), this can enumerate exhaustively: e.g. all cloze cards, all ' +
        'never-reviewed cards (level 0), or the strongest cards first. Returns `total` so you know when to ' +
        'paginate with offset. Each card includes its `document_path` (null for standalone cards) — the ' +
        'value update_flashcard/delete_flashcard need as `documentPath` — and its `origin` (\'ai\' = created ' +
        'by an AI assistant, null = handmade).',
      inputSchema: {
        search: z.string().optional().describe('Substring filter on front/back text and card name.'),
        level: z.number().int().optional().describe('Exact spaced-repetition level to filter on (0 = never reviewed).'),
        cardType: z.enum(['basic', 'reversible', 'cloze', 'type_answer', 'custom']).optional(),
        origin: z.enum(['ai', 'human']).optional().describe('Filter by provenance: "human" = handmade cards only — use these as style examples when drafting new cards; "ai" = AI-created cards only.'),
        sortBy: z.enum(['level', 'name', 'last_recall', 'lapses']).optional().describe('Sort key. Default "level". "lapses" (descending) surfaces the cards the user keeps failing — usually a sign the card is badly written and worth rewriting.'),
        sortDir: z.enum(['asc', 'desc']).optional().describe('Sort direction. Default "desc".'),
        limit: z.number().int().min(1).max(200).optional().describe('Page size. Default 50, max 200.'),
        offset: z.number().int().min(0).optional().describe('Pagination offset.'),
      },
    },
    safe(async ({ search, level, cardType, origin, sortBy, sortDir, limit, offset } = {}) => {
      const data = await request(
        'GET',
        `/api/decks/cards${qs({ search, level, cardType, origin, sortBy, sortDir, limit, offset })}`,
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

  server.registerTool(
    'search_content',
    {
      title: 'Search document contents',
      description:
        'Substring search inside document BODIES — use this when the term is in the ' +
        'prose of a note rather than in a name, tag, or flashcard (search_flashback covers those). ' +
        'Case-insensitive; returns matching documents with per-document match counts and context snippets. ' +
        'Covers .md/.markdown/.txt bodies ONLY: PDFs, EPUBs and media are never searched, so a miss here is not ' +
        'evidence the vault lacks the topic — check list_highlights and the cards on those documents too.',
      inputSchema: {
        query: z.string().describe('Text to find inside document bodies.'),
        limit: z.number().int().min(1).max(100).optional().describe('Max documents to return. Default 20.'),
      },
    },
    safe(async ({ query, limit }) => {
      const data = await request('GET', `/api/documents/search/content${qs({ q: query, limit })}`);
      return asText(data);
    }),
  );

  server.registerTool(
    'get_links',
    {
      title: 'Get document links',
      description:
        'The flashback:// wiki-link neighborhood of one document: `outgoing` (documents it links to), ' +
        '`backlinks` (documents linking to it), and `pending` (link targets that don\'t exist yet). Use it to ' +
        'navigate related notes; get_graph is the whole-vault view.',
      inputSchema: {
        path: z.string().describe('Relative path to the document.'),
      },
    },
    safe(async ({ path }) => {
      const data = await request('GET', `/api/documents/links${qs({ path })}`);
      return asText(data);
    }),
  );

  server.registerTool(
    'get_recent_changes',
    {
      title: 'Get recent changes',
      description:
        'Recent commits from Seal, the vault\'s built-in versioning of the canonical layer (sidecars and deck ' +
        'files — every card/tag/highlight/deck change, including ones made through these tools). Messages ' +
        'follow "<action>: <sidecar-path>" (create/edit/move/delete/reconcile). Use it to answer "what changed ' +
        'lately" or to show the user what you just modified. Read-only.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe('Max commits to return, newest first. Default 20.'),
      },
    },
    safe(async ({ limit } = {}) => {
      const log = await request('GET', `/api/seal/log${qs({ limit })}`);
      // Flatten isomorphic-git's log shape to what a model actually needs.
      const entries = (log ?? []).map((e) => ({
        ref: e.oid,
        message: e.commit?.message?.trim() ?? '',
        author: e.commit?.author?.name ?? null,
        date: e.commit?.author?.timestamp ? new Date(e.commit.author.timestamp * 1000).toISOString() : null,
      }));
      return asText(entries);
    }),
  );

  // ── Diary (privacy-gated) ──────────────────────────────────────────────────
  // The diary is a personal, per-day record of study activity kept OUTSIDE the
  // workspace (never in the graph, search, or cards). These tools are read-only and
  // are refused with a 403 unless the user has explicitly allowed AI-assistant access
  // in Flashback → Config → AI Assistant. Dates are 'YYYY-MM-DD' (UTC).

  server.registerTool(
    'diary_list',
    {
      title: 'List diary days',
      description:
        'List the days that have a diary summary and/or a written entry, newest first. Each item is ' +
        '{ date, hasSummary, hasEntry }. Requires the user to have enabled diary access for AI assistants ' +
        '(otherwise every diary tool returns a 403). Read-only.',
      inputSchema: {
        from: z.string().optional().describe('Inclusive lower bound, YYYY-MM-DD.'),
        to: z.string().optional().describe('Inclusive upper bound, YYYY-MM-DD.'),
      },
    },
    safe(async ({ from, to } = {}) => {
      const data = await request('GET', `/api/diary${qs({ from, to })}`);
      return asText(data);
    }),
  );

  server.registerTool(
    'diary_get_summary',
    {
      title: 'Get diary summary',
      description:
        'Get the machine-derived study summary for a day: review counts, new cards, pass rate, per-deck and ' +
        'per-document breakdowns, cards the user struggled with, and streak. Derived from review history — ' +
        'no personal prose. Returns a not-found error if that day has no summary. Requires diary access to be ' +
        'enabled for AI assistants. Read-only.',
      inputSchema: {
        date: z.string().describe('The day to fetch, YYYY-MM-DD (UTC).'),
      },
    },
    safe(async ({ date }) => {
      const data = await request('GET', `/api/diary/summary/${encodeURIComponent(date)}`);
      return asText(data);
    }),
  );

  server.registerTool(
    'diary_get_entry',
    {
      title: 'Get diary entry',
      description:
        'Get the user\'s own written reflection (markdown) for a day, or empty content if none exists. This is ' +
        'personal prose — treat it as private. Requires FULL diary access: if the user has granted only ' +
        'summaries-only access, this tool is refused with a 403 while diary_get_summary still works. Read-only.',
      inputSchema: {
        date: z.string().describe('The day to fetch, YYYY-MM-DD (UTC).'),
      },
    },
    safe(async ({ date }) => {
      const data = await request('GET', `/api/diary/entry/${encodeURIComponent(date)}`);
      return asText(data);
    }),
  );
}
