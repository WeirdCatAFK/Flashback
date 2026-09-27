import { z } from 'zod';
import { request, requestBuffer } from '../client.js';
import cardGuide from '../skills/flashbackCards.js';
import { GAP_BANDS, LONG_TERM_DAYS } from '../../shared/intervals.js';
import { asText, clip } from './shape.js';

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

const BAND_IDS = GAP_BANDS.map((b) => b.id);

/** The bands as the app labels them, for tool descriptions: `new` = never reviewed, `d1` ≤ 1 day, … */
const BANDS_TEXT = GAP_BANDS.map((b, i) => {
  if (b.max == null) return `"${b.id}" = never reviewed`;
  if (b.max === Infinity) return `"${b.id}" = over ${GAP_BANDS[i - 1].max} days`;
  return `"${b.id}" = up to ${b.max} day${b.max === 1 ? '' : 's'}`;
}).join(', ');

/**
 * Folds consecutive commits with the same message by the same author into one entry with a
 * `count`, as the Seal History tab folds a reading session's run of highlight and card edits
 * to one document. Anything in between breaks the run, so the order of events survives.
 */
function foldRuns(entries) {
  const out = [];
  for (const e of entries) {
    const last = out[out.length - 1];
    if (last && last.message === e.message && last.author === e.author) {
      last.count += 1;
      last.since = e.date;
      continue;
    }
    out.push({ ...e, count: 1, since: e.date });
  }
  return out.map(({ since, ...e }) => (e.count > 1 ? { ...e, since } : e));
}

/** A card-browser row with its long fields clipped, for the compact listing. */
const compactCard = ({ frontText, backText, answerText, custom_html: html, ...row }) => ({
  ...row,
  document_name: undefined,
  frontText: clip(frontText),
  backText: clip(backText),
  answerText: clip(answerText),
  ...(html ? { custom_html: clip(html) } : {}),
});

/**
 * A sidecar with its card and highlight arrays replaced by counts. The arrays are what makes
 * a heavily-carded book's read_document run to hundreds of thousands of characters, and both
 * have their own paged tools.
 */
function sidecarSummary(meta, relPath) {
  if (!meta || typeof meta !== 'object') return meta;
  const { flashcards, highlights, ...rest } = meta;
  return {
    ...rest,
    flashcards: Array.isArray(flashcards) ? flashcards.length : 0,
    highlights: Array.isArray(highlights) ? highlights.length : 0,
    _arrays: `Counts only. list_cards with source "document" and sourcePath "${String(relPath).replace(/\\/g, '/')}" ` +
      `pages its cards; list_highlights with this path lists its highlights; pass sidecar: "full" for the raw arrays.`,
  };
}

/** The due queue as counts per source document, plus the first `queueLimit` cards clipped. */
function dueSummary(data, queueLimit) {
  const newHashes = new Set((data.new ?? []).map((c) => c.global_hash));
  const byDoc = new Map();
  for (const c of [...(data.due ?? []), ...(data.new ?? [])]) {
    const key = c.document_path ? c.document_path.replace(/\\/g, '/') : null;
    const entry = byDoc.get(key) ?? { path: key, due: 0, new: 0 };
    entry[newHashes.has(c.global_hash) ? 'new' : 'due'] += 1;
    byDoc.set(key, entry);
  }
  const queue = (data.queue ?? data.due ?? []).slice(0, queueLimit).map((c) => ({
    global_hash: c.global_hash,
    card_type: c.card_type,
    frontText: clip(c.frontText ?? c.name),
    document_path: c.document_path ?? null,
    category: c.category ?? null,
    level: c.level,
    new: newHashes.has(c.global_hash),
    ...(data.preview?.[c.global_hash] ? { preview: data.preview[c.global_hash] } : {}),
  }));
  return {
    algorithm: data.algorithm,
    counts: data.counts,
    nextDue: data.nextDue ?? null,
    bySource: [...byDoc.values()].sort((a, b) => (b.due + b.new) - (a.due + a.new)),
    queue,
    ...(queueLimit < (data.queue ?? data.due ?? []).length
      ? { _queue: `First ${queueLimit} of the session's ${(data.queue ?? data.due ?? []).length} cards; raise queueLimit (max 100) to see more.` }
      : {}),
  };
}

const asMarkdown = (text) => ({ content: [{ type: 'text', text }] });
const asError = (err) => ({
  content: [{ type: 'text', text: `Flashback API error${err.status ? ` (${err.status})` : ''}: ${err.message}` }],
  isError: true,
});
const asToolError = (text) => ({ content: [{ type: 'text', text }], isError: true });

const safe = (fn) => async (args) => {
  try {
    return await fn(args);
  } catch (err) {
    return asError(err);
  }
};

/** Builds a query string, dropping null and undefined values. */
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

/** Registers every read-only MCP tool on the server. */
export function registerReadTools(server) {
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
        'include `level` (the scheduler\'s raw strength, 0 = new) alongside their content; for how well a card ' +
        'is held in the terms the app shows — the gap between reviews — use list_cards. Every group is capped ' +
        'at `limit` (default 20, max 100), and `truncated` says which groups had more: when ' +
        '`truncated.flashcards` is true you are NOT seeing every match — narrow the query, or use list_cards, ' +
        'which pages exhaustively and returns a `total`.',
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
      description:
        'List the documents and subfolders directly inside a workspace folder. Omit path for the workspace ' +
        'root. Each item is `{ name, type, globalHash, tags, flashcardCount, highlights }`: `flashcardCount` ' +
        'counts every card beneath a folder; `highlights` is a document\'s highlight count; `globalHash` is ' +
        'what a flashback:// wiki link points at. For one document\'s cards or highlights use list_cards ' +
        '(source "document") or list_highlights.',
      inputSchema: {
        path: z.string().optional().describe('Relative path from the workspace root. Omit or empty string for root.'),
      },
    },
    safe(async ({ path } = {}) => {
      const data = await request('GET', `/api/documents/list${qs({ path: path ?? '' })}`);
      return asText(data.map(({ name, type, metadata, flashcardCount }) => ({
        name,
        type,
        globalHash: metadata?.globalHash ?? null,
        tags: metadata?.tags ?? [],
        flashcardCount,
        ...(type === 'file' ? { highlights: metadata?.highlights?.length ?? 0 } : {}),
      })));
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
        'document is unreadable. The response also spells out the exact next call. ' +
        'The sidecar metadata comes back SUMMARISED by default: its `flashcards` and `highlights` arrays are ' +
        'replaced by counts, because a well-studied book carries hundreds of each. Page its cards with ' +
        'list_cards (source "document") and its highlights with list_highlights; pass `sidecar: "full"` only ' +
        'when you need the raw arrays.',
      inputSchema: {
        path: z.string().describe('Relative path to the document from the workspace root.'),
        sidecar: z.enum(['summary', 'full']).optional().describe('"summary" (default): card and highlight counts. "full": the raw sidecar arrays — large on a heavily carded document.'),
      },
    },
    safe(async ({ path, sidecar = 'summary' }) => {
      const raw = await request('GET', `/api/documents/read${qs({ path })}`);
      const data = sidecar === 'full' ? raw : { ...raw, metadata: sidecarSummary(raw.metadata, path) };
      if (data.binary) {
        const kb = data.size != null ? `${Math.max(1, Math.round(data.size / 1024)).toLocaleString()} KB` : 'unknown size';
        const cards = raw.metadata?.flashcards?.length ?? 0;
        const highlights = raw.metadata?.highlights?.length ?? 0;
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
        } catch { }

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
        'Pass `upTo: "progress"` to clamp the window to how far the user has actually read - use it for any '
        + 'request phrased around what THEY have read, so you never hand back a page they have not reached. '
        + 'This is READ-ONLY and returns a FRAGMENT: never pass its output to update_document, which ' +
        'overwrites an entire body — and which refuses these formats anyway.',
      inputSchema: {
        path: z.string().describe('Relative path to the document from the workspace root.'),
        index: z.union([z.number().int(), z.string()]).optional().describe('PDF: page number (1-based). EPUB: section number (1-based) or its spine href. YouTube transcript: segment number (1-based). Ignored for character-window text formats. Default 1.'),
        count: z.number().int().min(1).max(10).optional().describe('How many pages/sections/segments to return in one call. Default 1.'),
        offset: z.number().int().min(0).optional().describe('Character-window text formats only: character offset to start at. Default 0.'),
        limit: z.number().int().min(1).optional().describe('Character-window text formats only: how many characters to return. Capped server-side.'),
        charOffset: z.number().int().min(0).optional().describe('Resume inside a single oversized page/section — pass the `nextCharOffset` from a truncated response.'),
        at: z.number().min(0).optional().describe('YouTube transcript only: seconds to jump to. Lands on the transcript block covering that moment (e.g. a video_timestamp highlight\'s `start`); pass `count` for surrounding blocks.'),
        upTo: z.literal('progress').optional().describe('Clamp the read to how far the user has actually read. Pass "progress" whenever the request is about what THEY have read ("summarise what I have read so far") - it stops you reading past their mark, so you cannot spoil a document they are partway through. Cards still come only from their highlights. Errors if they have no recorded position here.'),
      },
    },
    safe(async ({ path, index, count, offset, limit, charOffset, at, upTo }) => {
      const data = await request('GET', `/api/reader/read${qs({ path, index, count, offset, limit, charOffset, at, upTo })}`);
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
        'List the media a saved web clip (.clip) carries — the pictures and short audio ' +
        'read_document cannot give you, because it returns the page\'s prose only. ' +
        'Metadata, not the bytes: each entry has `kind` ("image" or "audio"), an `href` (how you ' +
        'address it here), `alt` text, the `caption` of its figure, the `heading` it sits under, ' +
        '`bytes`, and `cached`. Entries come back in DOCUMENT ORDER, so entry 1 is the first one in ' +
        'the article. `cached` says where the asset lives, not whether you can use it: capturing a ' +
        'clip downloads no media, so most entries start `cached: false` with their original web ' +
        'address as `href`, and viewing or attaching one is what brings it into the vault. A cached ' +
        'entry also carries `path`, its real location there, so attach_media works on it as well as ' +
        'attach_clip_media. Sound is worth checking for on language, music and medical pages: a ' +
        'pronunciation clip makes a far better card front than a written description of one. A sound is ' +
        'listed whether the page carries it as a player or, far more often, as a link to the audio ' +
        'file — either way it is addressed here by `href` and attaches the same. Clips only.',
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
        'attach_clip_media if the surrounding text says what it is. An image still out on the web ' +
        '(`cached: false`) is downloaded into the vault to show it to you, so looking is not free: ' +
        'read the alt text and caption first and view the one you are unsure about. Very large ' +
        'images are refused rather than resized.',
      inputSchema: {
        path: z.string().describe('Relative path to the .clip document from the workspace root.'),
        href: z.string().describe('The image\'s `href` (or bare file name) from list_clip_media.'),
      },
    },
    safe(async ({ path, href }) => {
      const saved = await request('POST', '/api/documents/clip/asset', { path, href });
      const soundRefusal = asToolError(
        `"${href}" is a sound file, and nothing here can play one to you. Use its caption, alt ` +
        `text and heading from list_clip_media to decide what it is, then attach it with ` +
        `attach_clip_media.`,
      );
      if (saved.kind === 'audio') return soundRefusal;

      const { buffer, mimeType } = await requestBuffer(`/api/reader/media-file${qs({ path, href: saved.href })}`);
      if (/^audio\//i.test(mimeType ?? '')) return soundRefusal;
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
        'the ONLY way into card-making: every card you create must come from one of these highlights, which ' +
        'the user made while reading. Use `uncardedOnly` to find the highlights still waiting for a card, then ' +
        'create_flashcard with `path` = `documentPath` and `highlightHash` = the highlight\'s `id`. When the ' +
        'user wants cards on something no highlight covers, ask them to highlight it in the app — you cannot ' +
        'highlight for them. Before writing the cards, look at the vault\'s existing HANDMADE cards (list_cards ' +
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
        'What is due or new for review, optionally scoped by folder, deck, tags, or minimum pedagogical ' +
        'priority — the Trainer\'s queue. Returns a SUMMARY: `counts` ({ due, new }, new capped at `maxNew`), ' +
        '`nextDue` (when the next card falls due once today\'s are done), and `bySource` — due and new per ' +
        'source document (path null = the user\'s document-less cards), busiest first. Add `queueLimit` to also ' +
        'see the first cards of the session in the order the Trainer would show them, text clipped; each ' +
        'carries `level` (the scheduler\'s raw strength, 0 = never reviewed) and, under FSRS, `preview`: the ' +
        'gap in days each grade (again/hard/good/easy) would give it now — what the app shows on its grade ' +
        'buttons. For a card\'s full text use list_cards or search_flashback.',
      inputSchema: {
        folder: z.string().optional().describe('Restrict to a folder subtree (relative path).'),
        deck: z.string().optional().describe('Restrict to a deck (by globalHash).'),
        tags: z.array(z.string()).optional().describe('Restrict to cards carrying any of these tags.'),
        minPriority: z.number().int().optional().describe('Only include cards whose category priority >= this value.'),
        maxNew: z.number().int().optional().describe('Cap on how many never-reviewed cards to include.'),
        algorithm: z.enum(['leitner', 'sm2', 'fsrs']).optional().describe('Scheduling algorithm to compute dueness with. Leave it out unless you have a reason to override: the server infers the user\'s actual scheduler from their review history, and the response echoes back the one it used.'),
        queueLimit: z.number().int().min(0).max(100).optional().describe('How many cards of the session to list, in Trainer order. Default 0: counts only.'),
      },
    },
    safe(async ({ folder, deck, tags, minPriority, maxNew, algorithm, queueLimit = 0 }) => {
      const data = await request(
        'GET',
        `/api/srs/due${qs({ folder, deck, tag: tags, minPriority, maxNew, algorithm })}`,
      );
      return asText(dueSummary(data, queueLimit));
    }),
  );

  server.registerTool(
    'get_statistics',
    {
      title: 'Get study statistics',
      description:
        'Vault-wide spaced-repetition analytics — the data behind the app\'s Statistics report, which reads top ' +
        'to bottom as: how complete the vault is (`completeness`: how much has been READ and how well its cards ' +
        'are KNOWN, each 0-1, plus their mean), what is coming (`forecast`, `overdue`), whether it is staying ' +
        '(`totals.retention30` / `retentionAll`), where the cards are (`bands`), and the reviews themselves ' +
        '(`activity` per day, `streak`). Lead with those when ' +
        `summarising progress. \`bands\` counts cards by the gap between reviews — ${BANDS_TEXT} — the same ` +
        'bands the app\'s Flashcards screen groups by; it works the same under every scheduler, so prefer it to ' +
        '`maturity`, the older and coarser new/young/mature split kept for compatibility. ' +
        'Retention counts only reviews past a card\'s learning phase (its first few reviews); the learning ' +
        'phase is reported separately in `acquisition` (new-card pass rate, first-recall rate, attempts to ' +
        'learn a card). Read-only.',
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
        'Browse every flashcard in the vault with filters, sorting, grouping and pagination — the app\'s ' +
        'Flashcards catalogue. Unlike search_flashback (fuzzy text match, capped results), this can enumerate ' +
        'exhaustively: e.g. all cloze cards, every card from one document, or the cards held longest. Returns ' +
        '`total` so you know when to paginate with offset. ' +
        'HOW WELL A CARD IS HELD is its `gap`: the days between its reviews under the user\'s scheduler, null ' +
        `for a card never reviewed. The app sorts cards into bands by it — ${BANDS_TEXT} — and a gap of ` +
        `${LONG_TERM_DAYS} days or more counts as held long-term. Talk about cards in those terms ("12 cards are ` +
        'still on a 1-day gap"), not by `level`, which is the scheduler\'s raw box/repetition count and means ' +
        'different things under Leitner, SM-2 and FSRS. `groupBy` adds `groups` (counts per band or per source ' +
        'over every page, in display order). For just the counts, get_card_overview is one cheap call. ' +
        'Rows come back COMPACT, their text fields clipped to 160 characters; pass `verbose` for the full text. ' +
        'Each card includes its `document_path` (null for standalone cards) — the ' +
        'value update_flashcard/delete_flashcard need as `documentPath` — and its `origin`: \'ai\' = created ' +
        'by an AI assistant, \'import\' = imported from Anki or Obsidian, null = handmade (and, for cards ' +
        'imported before imports were marked, imported — those cannot be told apart). Each card carries ' +
        '`highlight_hash`, the highlight it was made from (null if none), and `anchor_status`: "live", or ' +
        '"missing" when that highlight has since been deleted — filter with `anchor` to find either. Each card also carries `flags`: a comma-joined list of ' +
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
        band: z.enum(BAND_IDS).optional().describe(`Only cards in this gap-between-reviews band: ${BANDS_TEXT}.`),
        source: z.enum(['standalone', 'document', 'folder']).optional().describe('Where the cards come from: "standalone" = the default deck\'s own document-less cards; "document" or "folder" with `sourcePath` (a folder matches everything beneath it).'),
        sourcePath: z.string().optional().describe('With source "document" or "folder": the relative path, forward slashes.'),
        tag: z.string().optional().describe('Only cards carrying this tag — their own, or inherited from a folder, document or deck.'),
        category: z.number().int().optional().describe('Only cards in this pedagogical category — its numeric `id` from list_categories.'),
        anchor: z.enum(['highlight', 'missing', 'none']).optional().describe('By the highlight a card was made from: "highlight" = anchored to one that still exists; "missing" = anchored to a highlight since deleted, so the card has lost its passage; "none" = made from no highlight.'),
        level: z.number().int().optional().describe('Exact raw scheduler level (0 = never reviewed). Prefer `band`, which means the same thing under every scheduler.'),
        cardType: z.enum(['basic', 'reversible', 'cloze', 'type_answer', 'custom']).optional(),
        origin: z.enum(['ai', 'human', 'import']).optional().describe('Filter by provenance: "human" = cards with no origin, i.e. handmade — use these as style examples when drafting new cards; "import" = imported from Anki or Obsidian; "ai" = AI-created cards only.'),
        flagged: z.boolean().optional().describe('Only cards carrying a live card-health flag of any kind.'),
        flagKind: z.enum(['mouthful', 'probe', 'overdue_drift', 'session_fatigue']).optional().describe('Only cards carrying this specific signature. Use "mouthful" to find cards actually worth rewriting — it is far more selective than sorting by lapses, which cannot tell a badly-built card from a productively hard one.'),
        sortBy: z.enum(['gap', 'due', 'source', 'front', 'created', 'level', 'name', 'last_recall', 'lapses', 'difficulty']).optional().describe('Sort key. Default "level". The app\'s own orders are "due" (next review first with sortDir "asc"; never-reviewed cards last), "source", "front" (A to Z with "asc") and "created" (newest first); "gap" orders by how well each card is held. "lapses" (descending) surfaces the cards the user keeps failing — but note that a high lapse count alone does NOT mean a card is badly written; prefer flagKind "mouthful" for that. "difficulty" (descending) is the FSRS estimate of how much effort a card costs; it is null for cards never rated under FSRS, and those always sort last.'),
        sortDir: z.enum(['asc', 'desc']).optional().describe('Sort direction. Default "desc".'),
        groupBy: z.enum(['gap', 'source']).optional().describe('Group the listing by band or by source document, keeping `sortBy` order within each group, and return `groups`: [{ key, count }] over every page.'),
        algorithm: z.enum(['leitner', 'sm2', 'fsrs']).optional().describe('Scheduler to compute `gap`, `band`, "due" and grouping under. Leave it out: the server uses the one the user\'s review history says they use.'),
        limit: z.number().int().min(1).max(500).optional().describe('Page size. Default 50, max 500.'),
        offset: z.number().int().min(0).optional().describe('Pagination offset.'),
        verbose: z.boolean().optional().describe('Return every field in full. Default false: frontText, backText, answerText and custom_html are clipped to 160 characters, enough to recognise a card; read one card in full with verbose on a narrow search.'),
      },
    },
    safe(async ({ search, band, source, sourcePath, tag, category, anchor, level, cardType, origin, flagged, flagKind, sortBy, sortDir, groupBy, algorithm, limit, offset, verbose = false } = {}) => {
      const data = await request(
        'GET',
        `/api/decks/cards${qs({ search, band, source, sourcePath, tag, category, anchor, level, cardType, origin, flagged: flagged ? '1' : undefined, flagKind, sortBy, sortDir, groupBy, algorithm, limit, offset })}`,
      );
      return asText(verbose ? data : { ...data, cards: data.cards.map(compactCard) });
    }),
  );

  server.registerTool(
    'get_card_overview',
    {
      title: 'Where the cards are',
      description:
        'The whole card collection in one cheap read — the app\'s Flashcards sidebar. Returns `total`; ' +
        '`bands`, how many cards sit in each gap-between-reviews band ' +
        `(${BANDS_TEXT}); \`documents\`, every source document with its \`cards\` and \`longTerm\` count ` +
        `(cards held ${LONG_TERM_DAYS}+ days), plus \`standalone\` for the default deck's document-less cards; ` +
        'and `flags`, how many cards carry a card-health flag (`any`, `mouthful`, `probe`). Start here to ' +
        'answer "how are my cards doing?" or "which sources are weakest?" — `longTerm / cards` per document ' +
        'is the thin line the app draws under each source — then use list_cards with `band` or ' +
        '`source`/`sourcePath` to see the cards behind a number.',
      inputSchema: {
        algorithm: z.enum(['leitner', 'sm2', 'fsrs']).optional().describe('Scheduler to compute gaps under. Leave it out: the server uses the one the user\'s review history says they use.'),
      },
    },
    safe(async ({ algorithm } = {}) => asText(await request('GET', `/api/decks/cards/summary${qs({ algorithm })}`))),
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
        'List every deck in the vault. The app draws each deck as a box of cards: each row carries ' +
        '`entry_count`, its `color` (a palette id, or null when none is stored and the app picks one from ' +
        'its hash) and `standing` — `{ due, fresh, longTerm }`: cards past their gap and due now, cards never ' +
        `reviewed, and cards held ${LONG_TERM_DAYS}+ days. That standing is how the app sums a deck up; use ` +
        'it to say how a deck is doing. Exactly one deck has `is_system: 1` — the default deck (drawn in ' +
        'kraft), which automatically holds every document-less card the user made; you should not need to ' +
        'call add_to_deck on it directly. Use create_deck for a named deck to organize cards into instead.',
      inputSchema: {
        algorithm: z.enum(['leitner', 'sm2', 'fsrs']).optional().describe('Scheduler to compute `standing` under. Leave it out: the server uses the one the user\'s review history says they use.'),
      },
    },
    safe(async ({ algorithm } = {}) => {
      const data = await request('GET', `/api/decks${qs({ algorithm })}`);
      return asText(data);
    }),
  );

  server.registerTool(
    'list_tags',
    {
      title: 'List tags',
      description:
        'List every tag used in the vault with its reach, as the app\'s Metadata screen shows it: each ' +
        '`{ name, folders, documents, decks, cardsDirect, cards }` — how many folders, documents and decks ' +
        'apply it directly, how many cards carry it themselves, and how many carry it at all (their own, or ' +
        'inherited from a folder, document or deck). Check it before tagging anything, so new content reuses ' +
        'an existing tag instead of creating a near-duplicate; list_cards with `tag` shows the cards behind ' +
        'a count, and rename_tag merges duplicates.',
      inputSchema: {},
    },
    safe(async () => {
      const data = await request('GET', '/api/documents/tags/overview');
      return asText(data);
    }),
  );

  server.registerTool(
    'list_categories',
    {
      title: 'List pedagogical categories',
      description:
        'List the valid pedagogical category names (e.g. "Concept", "Definition") that can be passed as ' +
        '`category` to create_flashcard. Each row is `{ id, name, priority, description, cards, level }`. ' +
        'The app arranges categories on priority LEVELS: several categories can share one, and the Trainer ' +
        'studies level 1 first. `level` is that 1-based position — the number the user sees — and ' +
        '`priority` the stored value behind it (lower = studied first; levels are the distinct priorities in ' +
        'order). `cards` is how many cards use the category; list_cards with `category` (the `id`) shows them.',
      inputSchema: {},
    },
    safe(async () => {
      const data = await request('GET', '/api/categories');
      const levels = [...new Set(data.map((c) => c.priority))].sort((a, b) => a - b);
      return asText(data.map((c) => ({ ...c, level: levels.indexOf(c.priority) + 1 })));
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
        'lately" or to show the user what you just modified. Like the app\'s Seal History, a run of identical ' +
        'consecutive commits by one author — a reading session\'s highlight and card edits to one document — ' +
        'comes back as ONE entry with `count` > 1: `ref` and `date` are the newest commit\'s, `since` the ' +
        'oldest\'s. Read-only.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe('Max commits to read, newest first, before runs fold. Default 20.'),
      },
    },
    safe(async ({ limit } = {}) => {
      const log = await request('GET', `/api/seal/log${qs({ limit })}`);
      const entries = (log ?? []).map((e) => ({
        ref: e.oid,
        message: e.commit?.message?.trim() ?? '',
        author: e.commit?.author?.name ?? null,
        date: e.commit?.author?.timestamp ? new Date(e.commit.author.timestamp * 1000).toISOString() : null,
      }));
      return asText(foldRuns(entries));
    }),
  );

  server.registerTool(
    'diary_list',
    {
      title: 'List diary days',
      description:
        'List the days that have a diary summary and/or a written entry, newest first. Each item is ' +
        '{ date, hasSummary, hasEntry, reviews } (the day’s review count), plus the entry’s firstLine when the ' +
        'user allows full diary access. Requires the user to have enabled diary access for AI assistants ' +
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

  server.registerTool(
    'get_read_progress',
    {
      title: 'Where the user has read to',
      description:
        'How far the user has read into ONE document. Returns their current position, the furthest ' +
        'point they have reached, a percentage, and whether it counts as finished. Call this before ' +
        'making cards "from what I have read", before summarising a book they are partway through, or ' +
        'any time you are about to read a long document on their behalf — then pass ' +
        '`upTo: "progress"` to read_document_text so you stay behind their mark. ' +
        'A null result means they have never opened it, which is different from being at the start. ' +
        '`stale` (text formats only) means the body was edited after the position was recorded, so the ' +
        'percentage still holds but the exact offset no longer does.',
      inputSchema: {
        path: z.string().describe('Relative path to the document from the workspace root.'),
      },
    },
    safe(async ({ path }) => asText(await request('GET', `/api/progress${qs({ path })}`))),
  );

  server.registerTool(
    'list_reading',
    {
      title: 'What the user is in the middle of',
      description:
        'Every document the user has started and not finished, most recently read first. This is how ' +
        'you answer "what am I in the middle of?", "what should I get back to?", or pick up work across ' +
        'several documents at once. Each entry carries the path, the position and the percentage, so you ' +
        'can go straight to read_document_text from here. Finished documents are excluded unless you ask ' +
        'for them. Documents nobody has opened never appear — absence means unread, not zero.',
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional().describe('Maximum documents to return. Default 50.'),
        includeFinished: z.boolean().optional().describe('Include documents already read to the end. Default false.'),
      },
    },
    safe(async ({ limit, includeFinished }) =>
      asText(await request('GET', `/api/progress/reading${qs({ limit, includeFinished })}`))),
  );

  server.registerTool(
    'reading_rollup',
    {
      title: 'How far through a folder or subscription',
      description:
        'Aggregate reading progress over a FOLDER and everything beneath it: how many documents are ' +
        'finished, how many are started, how many have never been opened, and the overall percentage. ' +
        'Use it for "how far through this course/magazine/collection am I?" and to decide what to work ' +
        'on next after a large import. Unread documents count in the total (as zero), so the percentage ' +
        'describes the whole folder rather than only the parts already touched. When the folder is a ' +
        'subscription target the result carries a `subscription` label, which is what makes the answer ' +
        '"12 of 47 issues" rather than "12 of 47 documents". Omit `path` for the whole vault.',
      inputSchema: {
        path: z.string().optional().describe('Relative folder path. Defaults to the workspace root.'),
      },
    },
    safe(async ({ path }) => asText(await request('GET', `/api/progress/rollup${qs({ path })}`))),
  );

  server.registerTool(
    'reading_coverage',
    {
      title: 'Read but not yet carded',
      description:
        'The gap between how far the user has READ into a document and how far the flashcards for it ' +
        'go — "read to page 120, the last card is from page 44". This is the tool that turns a big ' +
        'import back into a to-do list: call it to find where card-making should resume, then card the ' +
        'user\'s highlights in that span (list_highlights with `path`, `uncardedOnly`), reading around them ' +
        'with read_document_text for context. A span with no highlights is not yours to card: tell the user ' +
        'what is uncarded so they can highlight what they want kept. `gap` is null when the cards already reach ' +
        'the mark; with no cards at all it is everything read so far, because "nothing carded yet" is ' +
        'not the same answer as "nothing left to card" — check `gapKnown` to tell a real absence ' +
        'from an undeterminable one. `cardedTo` is null for EPUBs, whose cards are anchored by CFI and cannot be ordered ' +
        'server-side — for those, fall back to reading the sections and judging coverage yourself.',
      inputSchema: {
        path: z.string().describe('Relative path to the document from the workspace root.'),
      },
    },
    safe(async ({ path }) => asText(await request('GET', `/api/progress/coverage${qs({ path })}`))),
  );
}
