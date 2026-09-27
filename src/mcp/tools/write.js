import { z } from 'zod';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import { request, requestBuffer, upload } from '../client.js';
import { DECK_COLORS } from '../../shared/deckColors.js';
import { asText, clip as clipText } from './shape.js';

/** The most cards delete_flashcards removes in one call. */
const MAX_BULK = 500;

/** Cards named by hash, as `{ globalHash, frontText, documentPath, origin }`; unknown hashes come back in `missing`. */
async function cardsByHash(hashes) {
  const cards = [];
  const missing = [];
  for (const hash of hashes) {
    try {
      const c = await request('GET', `/api/flashcards/${encodeURIComponent(hash)}`);
      cards.push({ globalHash: c.globalHash, frontText: c.frontText ?? c.name, documentPath: c.documentPath ?? null, origin: c.origin ?? null });
    } catch (err) {
      if (err.status !== 404) throw err;
      missing.push(hash);
    }
  }
  return { cards, missing };
}

/** Every card the card browser matches for `filter`, paged through; one past MAX_BULK is enough to refuse. */
async function cardsByFilter(filter) {
  const cards = [];
  for (let offset = 0; ; offset += 500) {
    const page = await request('GET', `/api/decks/cards?${new URLSearchParams({ ...filter, limit: '500', offset: String(offset), sortBy: 'created', sortDir: 'asc' })}`);
    for (const c of page.cards) {
      cards.push({ globalHash: c.global_hash, frontText: c.frontText ?? c.name, documentPath: c.document_path ?? null, origin: c.origin ?? null });
    }
    if (page.cards.length < 500 || cards.length > MAX_BULK) return { cards, missing: [] };
  }
}

/** `[{ path, cards }]`, largest first; path null is the user's document-less cards. */
function countBySource(cards) {
  const counts = new Map();
  for (const c of cards) {
    const key = c.documentPath ? c.documentPath.replace(/\\/g, '/') : null;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([path, n]) => ({ path, cards: n })).sort((a, b) => b.cards - a.cards);
}

/** Wraps a message as an MCP error result. */
const asError = (err) => ({
  content: [{ type: 'text', text: `Flashback API error${err.status ? ` (${err.status})` : ''}: ${err.message}` }],
  isError: true,
});
/** Wraps a thrown error as an MCP tool error result. */
const asToolError = (text) => ({ content: [{ type: 'text', text }], isError: true });

const CARD_TYPES = ['basic', 'reversible', 'cloze', 'type_answer', 'custom'];

/** Registers every mutating MCP tool on the server. */
export function registerWriteTools(server) {
  server.registerTool(
    'create_flashcard',
    {
      title: 'Create flashcard',
      description:
        'Create a new flashcard FROM ONE OF THE USER\'S HIGHLIGHTS. Every card made through this tool is ' +
        'anchored to a highlight the user made while reading: `path` names the document and `highlightHash` ' +
        'the highlight (its `id` from list_highlights — use `uncardedOnly` to find the ones still waiting). ' +
        'This is a rule, not a default: it keeps AI cards on what the user chose as worth remembering, and ' +
        'keeps every one of them under their supervision, so it is never used to mass-produce cards from a ' +
        'document. Read as much of the document as you need for CONTEXT (read_document, read_document_text) ' +
        '— the passage around a highlight often decides what the card should ask — but only card what a ' +
        'highlight marks. If the user asks for cards on something no highlight covers, tell them which ' +
        'passage to highlight in the app, and card it once they have; there is no way to create a highlight ' +
        'or a document-less card from here. One highlight may become several cards when the passage holds ' +
        'several retrievals. The card is appended to the document\'s sidecar and sits in its margin beside ' +
        'the passage, same as a card made in the app. For "cloze" cards, wrap blanks in {{double curly ' +
        'braces}} in frontText and backText. For "type_answer" cards, frontText is the question, answerText ' +
        'is the expected answer (the only thing compared to what the user types), and backText is optional ' +
        'notes shown afterwards. For "custom" cards, put raw HTML in customHtml (frontText/backText are ' +
        'unused). Cards you create are permanently marked `origin: "ai"` in the data model, so the user can ' +
        'always tell them apart from handmade ones. Before drafting, look at existing HANDMADE cards ' +
        '(list_cards with origin "human", or the same document\'s cards via read_document) and match their ' +
        'style — length, tone, front/back phrasing conventions.',
      inputSchema: {
        path: z.string().describe('Relative path of the highlighted document (`documentPath` from list_highlights).'),
        highlightHash: z.string().describe('The `id` of the user\'s highlight in that document, from list_highlights. Required: every card made here comes from a highlight.'),
        cardType: z.enum(CARD_TYPES).default('basic'),
        frontText: z.string().optional(),
        backText: z.string().optional().describe('The answer side. On a "type_answer" card this is instead optional post-review notes (a mnemonic, an explanation) — shown after checking, never compared.'),
        answerText: z.string().optional().describe('"type_answer" only: the expected answer, compared case-insensitively to what the user types. Ignored by every other card type.'),
        customHtml: z.string().optional().describe('Raw HTML body, only used when cardType is "custom".'),
        name: z.string().optional().describe('Optional descriptive name for the card.'),
        category: z.string().optional().describe('Pedagogical category name. Call list_categories first to see valid values — an unrecognized name is rejected with an error, not silently dropped.'),
        tags: z.array(z.string()).optional().describe('Tags to apply to the card itself, kept in the document\'s sidecar. It also inherits the document\'s and its folders\' tags.'),
      },
    },
    async ({ path, highlightHash, cardType = 'basic', frontText, backText, answerText, customHtml, name, category, tags }) => {
      try {
        if (!path || !highlightHash) {
          return asToolError(
            'create_flashcard needs `path` and `highlightHash`: cards made through Flashback\'s AI tools ' +
            'come only from the user\'s own highlights. Call list_highlights (uncardedOnly: true) for the ' +
            'highlights still waiting for a card. If what you want to card is not highlighted, ask the user ' +
            'to highlight that passage in the app first.',
          );
        }
        const { highlights } = await request('GET', `/api/highlights?path=${encodeURIComponent(path)}`);
        if (!highlights?.some((h) => h.id === highlightHash)) {
          return asToolError(
            `No highlight ${highlightHash} in ${path}. Take the \`id\` and \`documentPath\` from ` +
            `list_highlights; if the passage has no highlight yet, ask the user to highlight it in the app.`,
          );
        }
        const formData = new FormData();
        formData.append('docPath', path);
        formData.append(
          'card',
          JSON.stringify({
            cardType,
            origin: 'ai',
            name: name || undefined,
            category: category || undefined,
            tags: tags && tags.length ? tags : undefined,
            vanillaData: {
              frontText: frontText || '',
              backText: backText || '',
              ...(cardType === 'type_answer' ? { answerText: answerText || '' } : {}),
              media: {},
              location: { type: 'highlight', id: highlightHash },
            },
            customData: { html: customHtml || '' },
          }),
        );
        const data = await upload('/api/media/vanilla', formData);
        return asText({ globalHash: data.card?.globalHash, documentPath: path, highlightHash, cardType, category: category ?? null });
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.registerTool(
    'fetch_youtube_transcript',
    {
      title: 'Fetch YouTube transcript',
      description:
        'Pull a YouTube reference document\'s captions into the vault so its spoken content becomes readable. ' +
        'Run this once on a `.youtube` document; afterwards read_document_text returns the transcript as ' +
        'timestamped segments, and its video_timestamp highlights ("@ 0:29") can be resolved to text with ' +
        'read_document_text\'s `at` parameter — the entry point for turning video moments into flashcards. ' +
        'This makes a network request to YouTube and stores the transcript in the document\'s sidecar (a ' +
        'versioned change). It fails with a 422 when the video has no captions available; there is no ' +
        'local speech-to-text fallback. The transcript is auto-generated captions unless the uploader added ' +
        'their own, so expect occasional transcription errors.',
      inputSchema: {
        path: z.string().describe('Relative path to the .youtube document from the workspace root.'),
        lang: z.string().optional().describe('Preferred caption language code, e.g. "en" or "es". Defaults to English, falling back to whatever the video has.'),
      },
    },
    async ({ path, lang }) => {
      try {
        const data = await request('POST', '/api/documents/youtube/transcript', { path, lang });
        return asText(data);
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.registerTool(
    'update_flashcard',
    {
      title: 'Update flashcard',
      description:
        'Edit an existing flashcard\'s content — standalone or document-anchored, the tool routes the edit ' +
        'automatically. Only the fields you pass change; everything else (review progress, source anchoring, ' +
        'media) is preserved.',
      inputSchema: {
        globalHash: z.string().describe('The card\'s globalHash.'),
        documentPath: z.string().optional().describe('Accepted for compatibility and ignored — the server resolves the card\'s source document from its hash.'),
        frontText: z.string().optional(),
        backText: z.string().optional().describe('The answer side; on a "type_answer" card, its post-review notes instead.'),
        answerText: z.string().optional().describe('"type_answer" only: the expected answer that gets compared. If the card predates the split (answerText null, its answer still in backText), send both fields in one call — setting this alone leaves the old answer sitting in backText, where it starts reading as notes.'),
        name: z.string().optional(),
        cardType: z.enum(CARD_TYPES).optional(),
        category: z.string().optional().describe('Call list_categories first — an unrecognized name is rejected, not silently dropped.'),
        customHtml: z.string().optional().describe('Raw HTML body for "custom" cards.'),
        tags: z.array(z.string()).optional().describe('Replaces the card\'s own tags — not what it inherits from a document, folder or deck. Works on standalone cards too.'),
      },
    },
    async ({ globalHash, frontText, backText, answerText, name, cardType, category, customHtml, tags }) => {
      try {
        const data = await request('PUT', `/api/flashcards/${encodeURIComponent(globalHash)}`,
          { frontText, backText, answerText, name, cardType, category, customHtml, tags });
        return asText({ ok: true, globalHash, ...data });
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.registerTool(
    'delete_flashcard',
    {
      title: 'Delete flashcard',
      description:
        'Permanently delete a flashcard, including its review history — this cannot be undone. Works on ' +
        'standalone and document-anchored cards alike (the source document itself is untouched), and ' +
        'unlinks the card from any decks holding it.',
      inputSchema: {
        globalHash: z.string().describe('The card\'s globalHash.'),
        documentPath: z.string().optional().describe('Ignored — the server resolves the card\'s source document itself. Accepted only so existing calls keep working.'),
      },
    },
    async ({ globalHash }) => {
      try {
        const data = await request('DELETE', `/api/flashcards/${encodeURIComponent(globalHash)}`);
        return asText({ ok: true, deleted: globalHash, documentPath: data?.documentPath ?? null });
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.registerTool(
    'delete_flashcards',
    {
      title: 'Delete many flashcards',
      description:
        'Permanently delete a set of flashcards in one call — named by `hashes`, or chosen by a `filter` ' +
        'with list_cards\' fields (e.g. { source: "document", sourcePath: "courses/R", origin: "ai" }). ' +
        'TWO STEPS, ALWAYS: called without `confirm` it is a DRY RUN that deletes nothing and returns how many ' +
        'cards match, how they spread over their source documents, and a sample. Show the user that preview ' +
        'and get their go-ahead, then call again with the same selection, `confirm: true` and `expectedCount` ' +
        'set to the count the preview reported; if the set has changed since, it refuses rather than delete ' +
        `something nobody previewed. At most ${MAX_BULK} cards per call. Each card goes with its review ` +
        'history and cannot be restored from here; the documents themselves are untouched.',
      inputSchema: {
        hashes: z.array(z.string()).optional().describe('The cards\' globalHashes. Give this or `filter`, not both.'),
        filter: z.object({
          source: z.enum(['standalone', 'document', 'folder']).optional(),
          sourcePath: z.string().optional(),
          origin: z.enum(['ai', 'human', 'import']).optional(),
          band: z.string().optional(),
          tag: z.string().optional(),
          category: z.number().int().optional(),
          anchor: z.enum(['highlight', 'missing', 'none']).optional(),
          cardType: z.enum(CARD_TYPES).optional(),
          search: z.string().optional(),
          flagKind: z.enum(['mouthful', 'probe', 'overdue_drift', 'session_fatigue']).optional(),
        }).optional().describe('Select by list_cards\' filters, all of which must match. At least one is required — there is no delete-everything.'),
        confirm: z.boolean().optional().describe('Actually delete. Omit for the dry run, which is the required first step.'),
        expectedCount: z.number().int().optional().describe('With `confirm`: the `count` the dry run reported.'),
      },
    },
    async ({ hashes, filter, confirm = false, expectedCount }) => {
      try {
        const byHashes = Array.isArray(hashes) && hashes.length > 0;
        const filterKeys = Object.entries(filter ?? {}).filter(([, v]) => v !== undefined && v !== '');
        if (byHashes === (filterKeys.length > 0)) {
          return asToolError('Give either `hashes` or a `filter` with at least one field — exactly one of the two.');
        }

        const { cards, missing } = byHashes
          ? await cardsByHash([...new Set(hashes)])
          : await cardsByFilter(Object.fromEntries(filterKeys));
        if (cards.length > MAX_BULK) {
          return asToolError(`${cards.length} cards match; one call deletes at most ${MAX_BULK}. Narrow the selection.`);
        }

        const bySource = countBySource(cards);
        if (!confirm) {
          return asText({
            dryRun: true,
            count: cards.length,
            bySource,
            sample: cards.slice(0, 10).map((c) => ({ globalHash: c.globalHash, frontText: clipText(c.frontText), documentPath: c.documentPath, origin: c.origin })),
            ...(missing.length ? { missing } : {}),
            next: cards.length
              ? `Nothing was deleted. After the user agrees, call again with the same selection, confirm: true and expectedCount: ${cards.length}.`
              : 'Nothing matches; nothing to delete.',
          });
        }
        if (expectedCount !== cards.length) {
          return asToolError(
            `The selection now holds ${cards.length} card(s), not the ${expectedCount ?? '(missing expectedCount)'} ` +
            'previewed. Nothing was deleted — run the dry run again and show the user the new preview.',
          );
        }

        const deleted = [];
        const failed = [];
        for (const c of cards) {
          try {
            await request('DELETE', `/api/flashcards/${encodeURIComponent(c.globalHash)}`);
            deleted.push(c);
          } catch (err) {
            failed.push({ globalHash: c.globalHash, error: `${err.status ?? ''} ${err.message}`.trim() });
          }
        }
        return asText({ deleted: deleted.length, bySource: countBySource(deleted), ...(failed.length ? { failed } : {}), ...(missing.length ? { missing } : {}) });
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.registerTool(
    'create_document',
    {
      title: 'Create document',
      description: 'Create a new Markdown/text document with the given content inside the workspace.',
      inputSchema: {
        name: z.string().describe('Filename, e.g. "system-design-notes.md". A .md extension is added if none is given.'),
        parentPath: z.string().optional().describe('Relative folder path to create the document in. Omit for the workspace root.'),
        content: z.string().optional().describe('Initial body content.'),
      },
    },
    async ({ name, parentPath, content }) => {
      try {
        await request('POST', '/api/documents/file', { name, parentPath: parentPath ?? '' });
        const fullPath = parentPath ? `${parentPath}/${name}` : name;
        if (content) {
          await request('PUT', '/api/documents/file', { path: fullPath, content });
        }
        return asText({ ok: true, path: fullPath });
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.registerTool(
    'create_folder',
    {
      title: 'Create folder',
      description: 'Create a new folder in the workspace, so documents can be organized into it (create_document requires its parent folder to already exist).',
      inputSchema: {
        name: z.string().describe('Folder name.'),
        parentPath: z.string().optional().describe('Relative path of the parent folder. Omit for the workspace root.'),
      },
    },
    async ({ name, parentPath }) => {
      try {
        await request('POST', '/api/documents/folder', { name, parentPath: parentPath ?? '' });
        return asText({ ok: true, path: parentPath ? `${parentPath}/${name}` : name });
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.registerTool(
    'update_document',
    {
      title: 'Update document content',
      description:
        'Replace the body content of an existing TEXT document (Markdown/plain text). This overwrites the ENTIRE ' +
        'body — always read_document first and send the full new text, even for a small edit. Document body text ' +
        'is not versioned by Seal (only sidecars are), so an overwrite is not recoverable in-app. Flashcards, tags, ' +
        'and highlights on the document are unaffected, but character-offset highlight anchors may drift if ' +
        'the highlighted text moves. Only .md/.markdown/.txt/.text bodies are writable — every other format is ' +
        'read-only in the app (a viewer, not an editor), and writing text over a PDF/EPUB would destroy it. ' +
        'To READ those formats use read_document_text; never write a fragment from it back through here.',
      inputSchema: {
        path: z.string().describe('Relative path to the document.'),
        content: z.string().describe('The full new body content.'),
      },
    },
    async ({ path, content }) => {
      try {
        await request('PUT', '/api/documents/file', { path, content });
        return asText({ ok: true, path });
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.registerTool(
    'update_tags',
    {
      title: 'Update document tags',
      description:
        'Replace the direct tags on a document or folder. Reads the current sidecar first and only changes the ' +
        '`tags` field, so existing flashcards/highlights/metadata on the document are preserved.',
      inputSchema: {
        path: z.string().describe('Relative path to the document or folder.'),
        tags: z.array(z.string()).describe('The full new set of direct tags (replaces the existing direct tags, does not merge).'),
        isFolder: z.boolean().default(false),
      },
    },
    async ({ path, tags, isFolder }) => {
      try {
        const sidecar = await request('GET', `/api/documents/sidecar?path=${encodeURIComponent(path)}&isFolder=${isFolder}`);
        const merged = { ...sidecar, tags };
        await request('PUT', '/api/documents/metadata', { path, metadata: merged, isFolder });
        return asText({ ok: true, path, tags });
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.registerTool(
    'create_deck',
    {
      title: 'Create deck',
      description: 'Create a new, empty deck to organize flashcards into (e.g. "Interview Prep"). Add cards to it afterward with add_to_deck. It gets the first box colour no other deck shows yet; update_deck changes it.',
      inputSchema: {
        name: z.string().describe('Deck name.'),
        description: z.string().optional(),
      },
    },
    async ({ name, description }) => {
      try {
        const data = await request('POST', '/api/decks', { name, description: description ?? '' });
        return asText(data);
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.registerTool(
    'update_deck',
    {
      title: 'Update deck',
      description:
        'Rename a deck, change its description or box colour, or replace its tags. Deck tags flow down to ' +
        'every member card, so tagging a deck is the fast way to tag a whole collection at once. The default ' +
        'deck (`is_system: 1`) is always kraft and refuses a colour.',
      inputSchema: {
        deckHash: z.string().describe('The deck\'s globalHash (from list_decks).'),
        name: z.string().optional(),
        description: z.string().optional(),
        color: z.enum(DECK_COLORS).nullable().optional().describe('The colour of the deck\'s box, from the app\'s palette. null drops the stored colour, and the app goes back to the one the deck\'s hash picks.'),
        tags: z.array(z.string()).optional().describe('Replaces the deck\'s full tag set (does not merge); the tags propagate to member cards.'),
      },
    },
    async ({ deckHash, name, description, color, tags }) => {
      try {
        if (name !== undefined || description !== undefined || color !== undefined) {
          await request('PUT', `/api/decks/${encodeURIComponent(deckHash)}`, { name, description, color });
        }
        let savedTags;
        if (tags !== undefined) {
          ({ tags: savedTags } = await request('PUT', `/api/decks/${encodeURIComponent(deckHash)}/tags`, { tags }));
        }
        return asText({ ok: true, deckHash, ...(savedTags !== undefined ? { tags: savedTags } : {}) });
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.registerTool(
    'delete_deck',
    {
      title: 'Delete deck',
      description:
        'Delete a deck. Cards are only LINKED to decks, so the cards themselves survive — only the grouping ' +
        'is removed. The system deck cannot be deleted.',
      inputSchema: {
        deckHash: z.string().describe('The deck\'s globalHash (from list_decks).'),
      },
    },
    async ({ deckHash }) => {
      try {
        const data = await request('DELETE', `/api/decks/${encodeURIComponent(deckHash)}`);
        return asText(data);
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.registerTool(
    'add_to_deck',
    {
      title: 'Add card to deck',
      description: 'Add an existing flashcard (by its globalHash, returned from create_flashcard or search_flashback) to a deck.',
      inputSchema: {
        deckHash: z.string().describe('The globalHash of the target deck (from list_decks).'),
        cardHash: z.string().describe('The globalHash of the flashcard to add.'),
        documentPath: z.string().optional().describe('The card\'s source document path, if it has one.'),
      },
    },
    async ({ deckHash, cardHash, documentPath }) => {
      try {
        const data = await request('POST', `/api/decks/${encodeURIComponent(deckHash)}/entries`, {
          cardHash,
          documentPath: documentPath || null,
        });
        return asText(data);
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.registerTool(
    'remove_from_deck',
    {
      title: 'Remove card from deck',
      description: 'Remove a flashcard from a deck. The card itself is untouched (delete_flashcard actually deletes it).',
      inputSchema: {
        deckHash: z.string().describe('The globalHash of the deck (from list_decks).'),
        cardHash: z.string().describe('The globalHash of the flashcard to remove.'),
      },
    },
    async ({ deckHash, cardHash }) => {
      try {
        const data = await request('DELETE', `/api/decks/${encodeURIComponent(deckHash)}/entries/${encodeURIComponent(cardHash)}`);
        return asText(data);
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.registerTool(
    'attach_media',
    {
      title: 'Attach media to flashcard',
      description:
        'Attach an image or audio file from the local filesystem to the front or back of an existing ' +
        'document-anchored vanilla flashcard (basic/reversible/cloze/type_answer — not "custom"). The media ' +
        'type is inferred from the file extension. Standalone cards cannot carry media.',
      inputSchema: {
        documentPath: z.string().describe('Relative path of the card\'s source document.'),
        flashcardHash: z.string().describe('The card\'s globalHash.'),
        filePath: z.string().describe('Absolute path to the media file on this machine.'),
        position: z.enum(['front', 'back']).describe('Which side of the card the media goes on.'),
        name: z.string().optional().describe('File name to store, including extension. Defaults to the source file\'s name.'),
      },
    },
    async ({ documentPath, flashcardHash, filePath, position, name }) => {
      try {
        const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.avif'];
        const SOUND_EXT = ['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac', '.opus'];
        const storedName = name || nodePath.basename(filePath);
        const ext = nodePath.extname(storedName).toLowerCase();
        const type = IMAGE_EXT.includes(ext) ? 'image' : SOUND_EXT.includes(ext) ? 'sound' : null;
        if (!type) {
          return asToolError(`Unsupported media extension "${ext}" — images (${IMAGE_EXT.join(' ')}) or audio (${SOUND_EXT.join(' ')}) only.`);
        }
        let buffer;
        try {
          buffer = await fs.readFile(filePath);
        } catch {
          return asToolError(`Cannot read ${filePath} — check the path exists and is accessible.`);
        }
        const formData = new FormData();
        formData.append('file', new Blob([buffer]), storedName);
        formData.append('docPath', documentPath);
        formData.append('flashcardHash', flashcardHash);
        formData.append('name', storedName);
        formData.append('type', type);
        formData.append('position', position);
        const data = await upload('/api/media/vanilla', formData);
        return asText({ ...data, name: storedName, type, position });
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.registerTool(
    'attach_book_image',
    {
      title: 'Put an EPUB figure on a flashcard',
      description:
        'Copy one image out of an EPUB and attach it to the front or back of an existing ' +
        'document-anchored vanilla flashcard. This is how a diagram from a book becomes the front ' +
        'of a card. The image lives inside the EPUB\'s zip and has no path on disk, so attach_media ' +
        'cannot reach it — use this instead, addressing the image by the `href` list_book_images ' +
        'reported. The card and the book do not have to be the same document: read a textbook, ' +
        'anchor the card to whichever document it belongs in, and pull the figure from the book. ' +
        'The bytes are copied into the card\'s document, so the card keeps working if the book is ' +
        'later removed, and the same figure can go on as many cards as you like.',
      inputSchema: {
        bookPath: z.string().describe('Relative path to the EPUB holding the image.'),
        href: z.string().describe('The image\'s `href` (or bare file name) from list_book_images.'),
        documentPath: z.string().describe('Relative path of the CARD\'s source document (often, but not always, the book itself).'),
        flashcardHash: z.string().describe('The card\'s globalHash.'),
        position: z.enum(['front', 'back']).describe('Which side of the card the image goes on.'),
        name: z.string().optional().describe('File name to store it as, including extension. Leave this off unless you need a specific name — by default the book\'s name gets a short unique suffix, which is what lets one figure be attached repeatedly. An explicit name that is already taken in that document is an error.'),
      },
    },
    async ({ bookPath, href, documentPath, flashcardHash, position, name }) => {
      try {
        const query = `?path=${encodeURIComponent(bookPath)}&href=${encodeURIComponent(href)}`;
        const { buffer, mimeType } = await requestBuffer(`/api/reader/image${query}`);

        const fromBook = nodePath.basename(String(href).split('?')[0]);
        const ext = nodePath.extname(fromBook);
        const base = nodePath.basename(fromBook, ext).replace(/[^\w.-]+/g, '_') || 'image';
        const storedName = name || `${base}-${crypto.randomUUID().slice(0, 8)}${ext}`;
        if (!nodePath.extname(storedName)) {
          return asToolError(`"${storedName}" has no file extension — pass \`name\` with one (the image is ${mimeType}).`);
        }

        const formData = new FormData();
        formData.append('file', new Blob([buffer], { type: mimeType }), storedName);
        formData.append('docPath', documentPath);
        formData.append('flashcardHash', flashcardHash);
        formData.append('name', storedName);
        formData.append('type', 'image');
        formData.append('position', position);
        const data = await upload('/api/media/vanilla', formData);
        return asText({ ...data, name: storedName, type: 'image', position, from: bookPath });
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.registerTool(
    'attach_clip_media',
    {
      title: 'Put a web clip\'s picture or sound on a flashcard',
      description:
        'Copy one asset out of a saved web clip and attach it to the front or back of an existing ' +
        'document-anchored vanilla flashcard, addressing it by the `href` list_clip_media reported. ' +
        'This is how a diagram from an article, or a pronunciation clip from a language page, ' +
        'becomes part of a card. Images land in the card\'s picture slot and sound in its sound ' +
        'slot, chosen from the asset itself — a card can carry one of each per side, and a sound ' +
        'plays automatically when that side is shown. The card and the clip do not have to be the ' +
        'same document. The bytes are copied into the card\'s document, so the card keeps working if ' +
        'the clip is later removed, and the same asset can go on as many cards as you like. An asset ' +
        'still loading from the web (`cached: false`, which is how every asset starts — capturing a ' +
        'clip downloads none of them) is fetched from its original site and saved into the clip on ' +
        'the way, so the clip keeps it too.',
      inputSchema: {
        clipPath: z.string().describe('Relative path to the .clip document holding the asset.'),
        href: z.string().describe('The asset\'s `href` (or bare file name) from list_clip_media.'),
        documentPath: z.string().describe('Relative path of the CARD\'s source document (often, but not always, the clip itself).'),
        flashcardHash: z.string().describe('The card\'s globalHash.'),
        position: z.enum(['front', 'back']).describe('Which side of the card the asset goes on.'),
        name: z.string().optional().describe('File name to store it as, including extension. Leave this off unless you need a specific name — by default the asset\'s name gets a short unique suffix, which is what lets one asset be attached repeatedly. An explicit name that is already taken in that document is an error.'),
      },
    },
    async ({ clipPath, href, documentPath, flashcardHash, position, name }) => {
      try {
        const saved = await request('POST', '/api/documents/clip/asset', { path: clipPath, href });
        const query = `?path=${encodeURIComponent(clipPath)}&href=${encodeURIComponent(saved.href)}`;
        const { buffer, mimeType } = await requestBuffer(`/api/reader/media-file${query}`);

        const type = /^audio\//i.test(mimeType ?? '') ? 'sound' : 'image';

        const fromClip = nodePath.basename(String(href).split('?')[0].split('#')[0]);
        const ext = nodePath.extname(fromClip) || nodePath.extname(saved.name || '');
        const base = nodePath.basename(fromClip, nodePath.extname(fromClip)).replace(/[^\w.-]+/g, '_') || type;
        const storedName = name || `${base}-${crypto.randomUUID().slice(0, 8)}${ext}`;
        if (!nodePath.extname(storedName)) {
          return asToolError(`"${storedName}" has no file extension — pass \`name\` with one (the asset is ${mimeType}).`);
        }

        const formData = new FormData();
        formData.append('file', new Blob([buffer], { type: mimeType }), storedName);
        formData.append('docPath', documentPath);
        formData.append('flashcardHash', flashcardHash);
        formData.append('name', storedName);
        formData.append('type', type);
        formData.append('position', position);
        const data = await upload('/api/media/vanilla', formData);
        return asText({ ...data, name: storedName, type, position, from: clipPath });
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.registerTool(
    'update_highlight',
    {
      title: 'Update highlight',
      description: 'Change the color or note of one of the user\'s highlights. Its anchored passage cannot be changed from here — only the user can highlight, in the app.',
      inputSchema: {
        path: z.string().describe('Relative path to the highlight\'s document.'),
        highlightHash: z.string().describe('The highlight\'s `id` (from the document sidecar\'s highlights[]).'),
        color: z.enum(['amber', 'green', 'blue', 'pink']).optional(),
        note: z.string().optional(),
      },
    },
    async ({ path, highlightHash, color, note }) => {
      try {
        const data = await request('PUT', `/api/highlights/${encodeURIComponent(highlightHash)}`, { path, color, note });
        return asText(data);
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.registerTool(
    'delete_highlight',
    {
      title: 'Delete highlight',
      description:
        'Delete a highlight from a document. Highlights are the user\'s own marks and cannot be recreated ' +
        'from here, so delete one only when the user asks. Flashcards anchored to it lose their source ' +
        'reference (the cards themselves survive) — check the sidecar via read_document if that matters.',
      inputSchema: {
        path: z.string().describe('Relative path to the highlight\'s document.'),
        highlightHash: z.string().describe('The highlight\'s `id`.'),
      },
    },
    async ({ path, highlightHash }) => {
      try {
        const data = await request('DELETE', `/api/highlights/${encodeURIComponent(highlightHash)}?path=${encodeURIComponent(path)}`);
        return asText(data);
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.registerTool(
    'create_category',
    {
      title: 'Create pedagogical category',
      description:
        'Add a new pedagogical category (e.g. "Concept", "Definition") that flashcards can be tagged with ' +
        'via the `category` field of create_flashcard/update_flashcard. Categories sit on priority levels ' +
        '(see list_categories): several can share one, and the Trainer studies level 1 first. To put the new ' +
        'category on an existing level, pass that level\'s `priority` from list_categories; the app itself ' +
        'puts a new category on the last level. If a name is wrong, rename it with update_category rather ' +
        'than deleting and recreating it.',
      inputSchema: {
        name: z.string().describe('Category name. Must be unique; the create fails if it already exists.'),
        priority: z.number().int().optional().describe('The stored priority of the level to join (from list_categories); lower = studied first. Defaults to 0.'),
        description: z.string().optional().describe('Optional human-readable description of what the category means.'),
      },
    },
    async ({ name, priority, description }) => {
      try {
        const data = await request('POST', '/api/categories', { name, priority, description });
        return asText({ id: data.id, name, priority: priority ?? 0, description: description ?? '' });
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.registerTool(
    'update_category',
    {
      title: 'Update pedagogical category',
      description:
        'Rename a pedagogical category, move it to another priority level, or edit its description. Identify ' +
        'it by `id` from list_categories. Every field is optional — only the ones you pass are changed. A card ' +
        'names its category in its own file, so a rename rewrites every card that uses it (one versioned ' +
        'change) and they all follow; renaming onto a name another category already has is refused (409). ' +
        'To move a category onto an existing level, pass that level\'s `priority` from list_categories.',
      inputSchema: {
        id: z.number().int().describe('The category\'s numeric `id` (from list_categories).'),
        name: z.string().optional().describe('New name. Must stay unique.'),
        priority: z.number().int().optional().describe('The stored priority of the level to move to; lower = studied first.'),
        description: z.string().optional().describe('New description.'),
      },
    },
    async ({ id, name, priority, description }) => {
      try {
        await request('PUT', `/api/categories/${encodeURIComponent(id)}`, { name, priority, description });
        return asText({ ok: true, id });
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.registerTool(
    'delete_category',
    {
      title: 'Delete pedagogical category',
      description:
        'Delete a pedagogical category. Refused (409, "In use by N flashcard(s)") while any card still uses ' +
        'it, unless `clear` is true: then those cards lose the category — their files are rewritten, the ' +
        'cards themselves stay — and the category goes. Before passing `clear`, tell the user how many cards ' +
        'lose it (`cards` in list_categories) and get their go-ahead, as the app asks before it does the same. ' +
        'To fix a wrong name, use update_category instead.',
      inputSchema: {
        id: z.number().int().describe('The category\'s numeric `id` (from list_categories).'),
        clear: z.boolean().optional().describe('Delete it even though cards use it, clearing it from them. Default false.'),
      },
    },
    async ({ id, clear }) => {
      try {
        await request('DELETE', `/api/categories/${encodeURIComponent(id)}${clear ? '?clear=1' : ''}`);
        return asText({ ok: true, deleted: id });
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.registerTool(
    'rename_tag',
    {
      title: 'Rename or remove a tag everywhere',
      description:
        'Rename a tag everywhere it is written — every folder, document, deck and card that carries it — or ' +
        'remove it from all of them by leaving `to` out. Renaming onto a tag that already exists MERGES the ' +
        'two, which is how near-duplicates from list_tags ("ml" and "machine-learning") become one. Returns ' +
        'how many sidecars and decks were rewritten; the sidecar changes are one versioned commit. This is ' +
        'the vault-wide operation; update_tags and update_deck change one item\'s tags. Confirm with the ' +
        'user before a removal or a merge — list_tags shows its reach.',
      inputSchema: {
        from: z.string().describe('The tag to rename or remove.'),
        to: z.string().optional().describe('Its new name. Omit to remove the tag everywhere.'),
      },
    },
    async ({ from, to }) => {
      try {
        const data = await request('POST', '/api/documents/tags/rename', { from, to: to ?? null });
        return asText(data);
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.registerTool(
    'set_read_progress',
    {
      title: 'Move the user reading position',
      description:
        'Record where the user has read to in a document. Use it when they TELL you where they are — ' +
        '"I read to page 40 on paper last night", "I finished chapter 3", "mark this as done" — not to ' +
        'guess on their behalf, and never merely because you read the document yourself. Reading it is ' +
        'not them reading it.\n\n' +
        'ADDRESS IT THE WAY THE FORMAT IS READ, matching read_document_text: a PDF by `page`, an EPUB by ' +
        '`section` number, a text file or clip by character `offset`, a video by `seconds`. Send `total` ' +
        '(pages, sections, characters, duration) when you know it, or a `percent` directly — without one ' +
        'or the other the position still resumes but has no percentage and cannot bound a read.\n\n' +
        'AN EPUB IS THE EXCEPTION: `total` alone buys no percentage there. Section numbers do not ' +
        'divide into one — sections vary enormously in length, and the app measures an EPUB by how ' +
        'much TEXT is behind you, not by which section you are in. Send an explicit `percent` if you ' +
        'want the reading bar to move; a section alone records a place to resume and nothing more.\n\n' +
        'This writes the user\'s own position and nobody else\'s; it produces no file change and no ' +
        'version-history commit. `mode` defaults to "manual", which is almost always what you want from ' +
        'a stated position: it sets the furthest-reached mark exactly where you say, including backwards ' +
        'if they are correcting an over-recorded position. Use "auto" only to advance a mark forward ' +
        'without ever moving it back. To mark something finished, send percent: 1.',
      inputSchema: {
        path: z.string().describe('Relative path to the document from the workspace root.'),
        unit: z.enum(['page', 'section', 'chars', 'segment'])
          .describe('page = PDF; section = EPUB; chars = markdown/text/clip; segment = video by timestamp.'),
        page: z.number().int().min(1).optional().describe('unit "page": the page number reached.'),
        section: z.number().int().min(1).optional().describe('unit "section": the EPUB section number reached.'),
        offset: z.number().int().min(0).optional().describe('unit "chars": the character offset reached.'),
        seconds: z.number().min(0).optional().describe('unit "segment": the timestamp reached, in seconds.'),
        total: z.number().optional().describe('The document length in the same unit (pages, sections, characters, seconds). Enables a percentage for every unit except the EPUB section unit - see above.'),
        percent: z.number().min(0).max(1).optional().describe('Fraction read, 0-1. Send 1 to mark it finished.'),
        mode: z.enum(['auto', 'manual']).optional().describe('Default "manual": sets the furthest mark exactly, including backwards. "auto" only ever advances it.'),
      },
    },
    async ({ path, unit, page, section, offset, seconds, total, percent, mode }) => {
      const position = { page, section, offset, seconds };
      for (const key of Object.keys(position)) if (position[key] === undefined) delete position[key];
      if (Object.keys(position).length === 0 && percent === undefined) {
        return asToolError(
          `set_read_progress needs a position: page, section, offset or seconds for unit "${unit}" (or a percent).`,
        );
      }
      try {
        const data = await request('PUT', '/api/progress', {
          path, unit, position, total, percent, mode: mode ?? 'manual',
        });
        return asText(data);
      } catch (err) {
        return asError(err);
      }
    },
  );
}
