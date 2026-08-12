import { z } from 'zod';
import { request, requestBuffer } from '../client.js';
import cardGuide from '../skills/flashbackCards.js';

// A picture inside a captured document is the one thing here a model has to SEE
// rather than read — there is no text form of a diagram — so view_book_image and
// view_clip_image return real image content blocks. That is a deliberate, narrow
// exception to the rule that document bodies reach this server as text or not at all
// (CLAUDE.md § MCP server), and it turns on the picture BEING the content: it does
// not generalize to rasterized PDF pages or any document body. Sound is outside it
// too — nothing can play audio to a model, so view_clip_image refuses one. The
// ceiling stops a single full-page plate from swallowing a context window; nothing
// here resizes an image.
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

const asText = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
// The guide is Markdown meant to be read as prose. JSON-stringifying it would bury it in
// escapes for no gain, so it goes back verbatim.
const asMarkdown = (text) => ({ content: [{ type: 'text', text }] });
const asError = (err) => ({
  content: [{ type: 'text', text: `Flashback API error${err.status ? ` (${err.status})` : ''}: ${err.message}` }],
  isError: true,
});
const asToolError = (text) => ({ content: [{ type: 'text', text }], isError: true });

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

const GUIDE_SECTIONS = Object.keys(cardGuide.references);

export function registerReadTools(server) {
  // Registered first because it is the tool that should be called first. Everything else
  // here reads the vault; this one explains what to do with what you read.
  server.registerTool(
    'get_card_guide',
    {
      title: 'Get the card-authoring guide',
      description:
        `${cardGuide.description}\n\n` +
        'Returns the guide as Markdown — the vault\'s house style, card-type selection, the ' +
        'properties every card is checked against, and the syntax/code-card rules that are where ' +
        'cards most often fail. Call it BEFORE drafting cards, not after: it changes what you write, ' +
        'and it is cheap compared to a deck the user has to live with for years. It reads no vault ' +
        'data and takes no lock, so calling it speculatively costs nothing.\n\n' +
        'Deeper material is split into sections fetched on demand: ' +
        GUIDE_SECTIONS.map(s => `"${s}" — ${cardGuide.references[s].summary}`).join(' ') +
        ' Fetch a section when the guide points you at it or the material calls for it.',
      inputSchema: {
        section: z.enum(GUIDE_SECTIONS).optional()
          .describe('A reference section to fetch instead of the main guide. Omit for the main guide, which lists what is available.'),
      },
    },
    async ({ section } = {}) => {
      if (!section) {
        return asMarkdown(
          `${cardGuide.body}\n\n---\n\n` +
          `## Reference sections\n\n` +
          `Fetch with get_card_guide({ section }):\n\n` +
          GUIDE_SECTIONS.map(s => `- \`${s}\` — ${cardGuide.references[s].summary}`).join('\n'),
        );
      }
      const ref = cardGuide.references[section];
      // Reachable when a caller bypasses the schema (the tests do). Naming the valid
      // sections beats an undefined body that reads like an empty guide.
      if (!ref) {
        return {
          content: [{ type: 'text', text: `No such guide section: "${section}". Available: ${GUIDE_SECTIONS.join(', ')}.` }],
          isError: true,
        };
      }
      return asMarkdown(ref.body);
    },
  );

  server.registerTool(
    'search_flashback',
    {
      title: 'Search Flashback',
      description:
        'Search the vault. Global mode (query only) matches against actual content — folder/document/deck ' +
        'NAMES, tag names, and flashcard frontText/backText/answerText/name — and returns results grouped by ' +
        'type. It does ' +
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
      // A .youtube stub's readable content is its transcript, which lives in the
      // sidecar and can be large. Keep it out of read_document (which dumps the whole
      // sidecar) and steer to read_document_text, mirroring the binary branch above.
      if (typeof path === 'string' && path.toLowerCase().endsWith('.youtube')) {
        const cues = data.metadata?.source?.transcript;
        if (Array.isArray(cues)) {
          const trimmed = {
            ...data,
            metadata: {
              ...data.metadata,
              source: {
                ...data.metadata.source,
                transcript: `<${cues.length} transcript cues — read them with read_document_text (path="${path}"), ` +
                  `or pass at=<seconds> to jump to a timestamp highlight's moment>`,
              },
            },
          };
          return asText(trimmed);
        }
        return {
          content: [{
            type: 'text',
            text:
              `This YouTube reference has no transcript in the vault yet, so its spoken content isn't ` +
              `readable and its timestamp highlights can't be resolved to text. Call fetch_youtube_transcript ` +
              `with path="${path}" to pull the video's captions in, then read it with read_document_text.\n\n` +
              JSON.stringify(data, null, 2),
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
        'Get the readable TEXT of a PDF, an EPUB, a saved web clip, or a YouTube video\'s transcript — the ' +
        'formats read_document returns as `content: null` (or as a bare stub) — or a window of a long text ' +
        'file. THIS is how you read a PDF, EPUB, or video; a null `content` from read_document is not a dead ' +
        'end, it is the signal to call this. Extraction happens on the server; you get plain UTF-8. ' +
        'ADDRESSING FOLLOWS THE FORMAT: a PDF is read by `index` = page number (1-based, `count` for a few ' +
        'pages at once), an EPUB by `index` = spine section number or its href, a YouTube transcript by ' +
        'timestamped `segment` (walk with `index`/`count`, or pass `at`=<seconds> to jump straight to the ' +
        'passage around a moment — e.g. a video_timestamp highlight\'s `start`), Markdown/text/clips by ' +
        '`offset`/`limit` character window. Call it with only `path` to get the first unit, then follow ' +
        '`next` (and `nextCharOffset` if `truncated`) until `hasMore` is false. Each response reports ' +
        '`total` (pages, sections, segments, or characters) and a `label` such as "p. 37" or a "m:ss" ' +
        'timestamp — cite that label when a card comes from a specific place. Scanned PDFs have no text ' +
        'layer and return nothing readable; a YouTube document with no transcript yet says how to fetch one. ' +
        'This is READ-ONLY and returns a FRAGMENT: never pass its output to update_document, which ' +
        'overwrites an entire body — and which refuses these formats anyway.',
      inputSchema: {
        path: z.string().describe('Relative path to the document from the workspace root.'),
        index: z.union([z.number().int(), z.string()]).optional().describe('PDF: page number (1-based). EPUB: section number (1-based) or its spine href. YouTube transcript: segment number (1-based). Ignored for character-window text formats. Default 1.'),
        count: z.number().int().min(1).max(10).optional().describe('How many pages/sections/segments to return in one call. Default 1.'),
        offset: z.number().int().min(0).optional().describe('Character-window text formats only: character offset to start at. Default 0.'),
        limit: z.number().int().min(1).optional().describe('Character-window text formats only: how many characters to return. Capped server-side.'),
        charOffset: z.number().int().min(0).optional().describe('Resume inside a single oversized page/section — pass the `nextCharOffset` from a truncated response.'),
        at: z.number().min(0).optional().describe('YouTube transcript only: seconds to jump to. Lands on the transcript block covering that moment (e.g. a video_timestamp highlight\'s `start`); pass `count` for surrounding blocks.'),
      },
    },
    safe(async ({ path, index, count, offset, limit, charOffset, at }) => {
      const data = await request('GET', `/api/reader/read${qs({ path, index, count, offset, limit, charOffset, at })}`);
      return asText(data);
    }),
  );

  server.registerTool(
    'list_book_images',
    {
      title: 'List an EPUB\'s images',
      description:
        'List the figures, diagrams, plates and photographs an EPUB contains — the pictures ' +
        'read_document_text cannot give you, because it returns prose only. This is metadata, not ' +
        'the pictures themselves: each entry has an `href` (how you address it), `alt` text, the ' +
        '`caption` of its figure, the `section` it appears in, `sectionIndex` (the number to pass ' +
        'read_document_text to read the surrounding page), `bytes`, and `isCover`. Images come back ' +
        'in READING ORDER, so entry 1 is the first picture in the book. Usually the alt text and ' +
        'caption are enough to know which figure is which; when they are missing or ambiguous, call ' +
        'view_book_image to actually look at it. To put one on a card, pass its `href` to ' +
        'attach_book_image — never try to read the file off disk, it lives inside the EPUB\'s zip. ' +
        'EPUB only: PDFs and other formats have no extractable image list.',
      inputSchema: {
        path: z.string().describe('Relative path to the EPUB from the workspace root.'),
        section: z.number().int().min(1).optional().describe('Only images appearing in this section number (as reported by read_document_text / list_book_images `sectionIndex`). Omit for the whole book.'),
      },
    },
    safe(async ({ path, section }) => {
      const data = await request('GET', `/api/reader/images${qs({ path })}`);
      if (section == null) return asText(data);
      const images = data.images.filter((i) => i.sectionIndex === section);
      return asText({ ...data, total: images.length, section, images });
    }),
  );

  server.registerTool(
    'view_book_image',
    {
      title: 'Look at one of an EPUB\'s images',
      description:
        'Return one image from an EPUB so you can actually SEE it — use this when a figure\'s alt ' +
        'text and caption from list_book_images do not tell you what it depicts, and you need to ' +
        'know before writing a card about it or attaching it. Address it by the `href` ' +
        'list_book_images gave you. This is the ONLY tool that returns bytes rather than text; do ' +
        'not go looking for an equivalent for PDF pages or document bodies, there isn\'t one. Very ' +
        'large images are refused rather than resized — attach_book_image can still put one on a ' +
        'card without either of us looking at it.',
      inputSchema: {
        path: z.string().describe('Relative path to the EPUB from the workspace root.'),
        href: z.string().describe('The image\'s `href` (or bare file name) from list_book_images.'),
      },
    },
    safe(async ({ path, href }) => {
      const { buffer, mimeType } = await requestBuffer(`/api/reader/image${qs({ path, href })}`);
      if (buffer.length > MAX_IMAGE_BYTES) {
        return asToolError(
          `"${href}" is ${(buffer.length / 1024 / 1024).toFixed(1)} MB, over the ` +
          `${MAX_IMAGE_BYTES / 1024 / 1024} MB viewing limit. Nothing here can resize it. You can ` +
          `still attach it to a card with attach_book_image, or go by its alt text and caption ` +
          `from list_book_images.`,
        );
      }
      return { content: [{ type: 'image', data: buffer.toString('base64'), mimeType }] };
    }),
  );

  server.registerTool(
    'list_clip_media',
    {
      title: 'List a web clip\'s pictures and sound',
      description:
        'List the media a saved web clip (.clip) downloaded when it was captured — the pictures and ' +
        'short audio read_document cannot give you, because it returns the page\'s prose only. ' +
        'Metadata, not the bytes: each entry has `kind` ("image" or "audio"), an `href` (how you ' +
        'address it here), `alt` text, the `caption` of its figure, the `heading` it sits under, ' +
        '`bytes`, and `cached`. Entries come back in DOCUMENT ORDER, so entry 1 is the first one in ' +
        'the article. When `cached` is false the clipper could not download that asset — it still ' +
        'loads from the web, its `href` is the remote URL, and its alt text and caption are all ' +
        'that can be known about it; nothing here will fetch it. A cached entry also carries `path`, ' +
        'its real location in the vault, so attach_media works on it as well as attach_clip_media. ' +
        'Sound is worth checking for on language, music and medical pages: a pronunciation clip ' +
        'makes a far better card front than a written description of one. Clips only.',
      inputSchema: {
        path: z.string().describe('Relative path to the .clip document from the workspace root.'),
        kind: z.enum(['image', 'audio']).optional().describe('Only assets of this kind. Omit for everything the clip holds.'),
      },
    },
    safe(async ({ path, kind }) => {
      const data = await request('GET', `/api/reader/media${qs({ path })}`);
      if (kind == null) return asText(data);
      const media = data.media.filter((m) => m.kind === kind);
      return asText({ ...data, total: media.length, kind, media });
    }),
  );

  server.registerTool(
    'view_clip_image',
    {
      title: 'Look at one of a web clip\'s images',
      description:
        'Return one picture from a saved web clip so you can actually SEE it — use this when an ' +
        'image\'s alt text and caption from list_clip_media do not tell you what it depicts, and you ' +
        'need to know before writing a card about it or attaching it. Address it by the `href` ' +
        'list_clip_media gave you. Images only: there is no way to play a sound to you, so an audio ' +
        'entry is refused — go by its caption and heading, and attach it unheard with ' +
        'attach_clip_media if the surrounding text says what it is. Very large images are refused ' +
        'rather than resized.',
      inputSchema: {
        path: z.string().describe('Relative path to the .clip document from the workspace root.'),
        href: z.string().describe('The image\'s `href` (or bare file name) from list_clip_media.'),
      },
    },
    safe(async ({ path, href }) => {
      const { buffer, mimeType } = await requestBuffer(`/api/reader/media-file${qs({ path, href })}`);
      if (/^audio\//i.test(mimeType ?? '')) {
        return asToolError(
          `"${href}" is a sound file, and nothing here can play one to you. Use its caption, alt ` +
          `text and heading from list_clip_media to decide what it is, then attach it with ` +
          `attach_clip_media.`,
        );
      }
      if (buffer.length > MAX_IMAGE_BYTES) {
        return asToolError(
          `"${href}" is ${(buffer.length / 1024 / 1024).toFixed(1)} MB, over the ` +
          `${MAX_IMAGE_BYTES / 1024 / 1024} MB viewing limit. Nothing here can resize it. You can ` +
          `still attach it to a card with attach_clip_media, or go by its alt text and caption ` +
          `from list_clip_media.`,
        );
      }
      return { content: [{ type: 'image', data: buffer.toString('base64'), mimeType }] };
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
        algorithm: z.enum(['leitner', 'sm2', 'fsrs']).optional().describe('Scheduling algorithm to compute dueness with. Leave it out unless you have a reason to override: the server infers the user\'s actual scheduler from their review history, and the response echoes back the one it used.'),
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
        algorithm: z.enum(['leitner', 'sm2', 'fsrs']).optional().describe('Algorithm to compute schedule-dependent stats with. Leave it out unless you have a reason to override: the server infers the user\'s actual scheduler from their review history, and the returned `algorithm` field is the one it used.'),
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
        'by an AI assistant, null = handmade). Each card also carries `flags`: a comma-joined list of ' +
        'card-health signatures the app raised from the user\'s own review behaviour, or null. ' +
        'IMPORTANT: "mouthful" means the card keeps resetting to a short interval and its answer is long ' +
        'for this vault — a genuine candidate for splitting. "probe" means the card fails often but ' +
        'recovers to LONGER intervals each time: that is the card working, and rewriting or splitting it ' +
        'would destroy the useful difficulty. "overdue_drift" and "session_fatigue" say the failures are ' +
        'about when the card was reviewed, not how it is built — do not propose card changes for those. ' +
        'The kind alone is not enough to act on: call get_card_health for the numbers behind it, which will ' +
        'sometimes show the flag is weak and should be argued with. ' +
        'Never rewrite a card on flags alone; show the user what you would change and why.',
      inputSchema: {
        search: z.string().optional().describe('Substring filter on front/back text, a type_answer card\'s answerText, and card name.'),
        level: z.number().int().optional().describe('Exact spaced-repetition level to filter on (0 = never reviewed).'),
        cardType: z.enum(['basic', 'reversible', 'cloze', 'type_answer', 'custom']).optional(),
        origin: z.enum(['ai', 'human']).optional().describe('Filter by provenance: "human" = handmade cards only — use these as style examples when drafting new cards; "ai" = AI-created cards only.'),
        flagged: z.boolean().optional().describe('Only cards carrying a live card-health flag of any kind.'),
        flagKind: z.enum(['mouthful', 'probe', 'overdue_drift', 'session_fatigue']).optional().describe('Only cards carrying this specific signature. Use "mouthful" to find cards actually worth rewriting — it is far more selective than sorting by lapses, which cannot tell a badly-built card from a productively hard one.'),
        sortBy: z.enum(['level', 'name', 'last_recall', 'lapses', 'difficulty']).optional().describe('Sort key. Default "level". "lapses" (descending) surfaces the cards the user keeps failing — but note that a high lapse count alone does NOT mean a card is badly written; prefer flagKind "mouthful" for that. "difficulty" (descending) is the FSRS estimate of how much effort a card costs; it is null for cards never rated under FSRS, and those always sort last.'),
        sortDir: z.enum(['asc', 'desc']).optional().describe('Sort direction. Default "desc".'),
        limit: z.number().int().min(1).max(200).optional().describe('Page size. Default 50, max 200.'),
        offset: z.number().int().min(0).optional().describe('Pagination offset.'),
      },
    },
    safe(async ({ search, level, cardType, origin, flagged, flagKind, sortBy, sortDir, limit, offset } = {}) => {
      const data = await request(
        'GET',
        `/api/decks/cards${qs({ search, level, cardType, origin, flagged: flagged ? '1' : undefined, flagKind, sortBy, sortDir, limit, offset })}`,
      );
      return asText(data);
    }),
  );

  server.registerTool(
    'get_card_health',
    {
      title: 'Get card health',
      description:
        'Explain why one card was flagged. list_cards tells you a card is a "mouthful"; this tells you what ' +
        'the app actually observed, so you can judge whether you agree. Returns each live flag with its ' +
        '`confidence` ("moderate" or "high"), a human-readable `title`/`detail`/`action`, and an `evidence` ' +
        'object holding the numbers behind the verdict. For "mouthful"/"probe" that is `peaks` (the longest ' +
        'interval, in days, the card reached in each relearn cycle — the whole classification rests on whether ' +
        'this series climbs), `peakSlope`, `difficultySlope`, `answerTokens` vs the vault\'s ' +
        '`medianAnswerTokens`, `lapses`, and `windowDays`. The two guards report timing instead: how many ' +
        'failures came in overdue and by how much, or how late in a session they happened. Returns an empty ' +
        'array for a card that is fine — which is most cards.\n\n' +
        'READ THE EVIDENCE BEFORE PROPOSING ANYTHING. A flag is a hypothesis from grades and timing, not a ' +
        'verdict on the writing: the app never sees what the user actually typed or thought. Cases where the ' +
        'flag is likely wrong and you should say so: `peaks` is short (2-3 cycles) or its values barely ' +
        'differ, so the trend is noise; `memoryModel` is "approximated", meaning the user is on Leitner or ' +
        'SM-2 and there is no difficulty signal at all; or `answerTokens` is only just above the vault ' +
        'median, making "overloaded" a weak call. Disagreeing with a flag and explaining why is a correct, ' +
        'useful answer — the user can dismiss it in the app. ' +
        'Never rewrite or split a card on a flag alone; propose the change and let the user decide.',
      inputSchema: {
        cardHash: z.string().describe('globalHash of the card (from list_cards, search_flashback, or a document listing).'),
      },
    },
    safe(async ({ cardHash }) => {
      const data = await request('GET', `/api/flashcards/${encodeURIComponent(cardHash)}/flags`);
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
