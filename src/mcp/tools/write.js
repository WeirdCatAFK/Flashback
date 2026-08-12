import { z } from 'zod';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import { request, requestBuffer, upload } from '../client.js';

const asText = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const asError = (err) => ({
  content: [{ type: 'text', text: `Flashback API error${err.status ? ` (${err.status})` : ''}: ${err.message}` }],
  isError: true,
});
const asToolError = (text) => ({ content: [{ type: 'text', text }], isError: true });

const CARD_TYPES = ['basic', 'reversible', 'cloze', 'type_answer', 'custom'];

export function registerWriteTools(server) {
  server.registerTool(
    'create_flashcard',
    {
      title: 'Create flashcard',
      description:
        'Create a new flashcard. Pass `path` to anchor it to a document (it is appended to that document\'s ' +
        'sidecar, same as creating a card from the Inspector); omit `path` to create a standalone card in the ' +
        'system deck. For "cloze" cards, wrap blanks in {{double curly braces}} in frontText and backText. ' +
        'For "type_answer" cards, frontText is the question, answerText is the expected answer (the only ' +
        'thing compared to what the user types), and backText is optional notes shown afterwards. For "custom" ' +
        'cards, put raw HTML in customHtml (frontText/backText are unused). Pass `highlightHash` (from ' +
        'create_highlight or the document sidecar\'s highlights[]) to anchor the card to the exact passage it ' +
        'came from. Cards you create are permanently marked `origin: "ai"` in the data model, so the user can ' +
        'always tell them apart from handmade ones. Before drafting, look at existing HANDMADE cards ' +
        '(list_cards with origin "human", or the same document\'s cards via read_document) and match their ' +
        'style — length, tone, front/back phrasing conventions.',
      inputSchema: {
        path: z.string().optional().describe('Relative path of the document to attach this card to. Omit for a standalone card.'),
        cardType: z.enum(CARD_TYPES).default('basic'),
        frontText: z.string().optional(),
        backText: z.string().optional().describe('The answer side. On a "type_answer" card this is instead optional post-review notes (a mnemonic, an explanation) — shown after checking, never compared.'),
        answerText: z.string().optional().describe('"type_answer" only: the expected answer, compared case-insensitively to what the user types. Ignored by every other card type.'),
        customHtml: z.string().optional().describe('Raw HTML body, only used when cardType is "custom".'),
        name: z.string().optional().describe('Optional descriptive name for the card.'),
        category: z.string().optional().describe('Pedagogical category name. Call list_categories first to see valid values — an unrecognized name is rejected with an error, not silently dropped.'),
        tags: z.array(z.string()).optional().describe('Tags to apply to the card. Only used for document-anchored cards.'),
        highlightHash: z.string().optional().describe('The `id` of a highlight in the same document to anchor this card to (returned by create_highlight, listed in the sidecar\'s highlights[]). Requires `path`.'),
      },
    },
    async ({ path, cardType, frontText, backText, answerText, customHtml, name, category, tags, highlightHash }) => {
      try {
        if (highlightHash && !path) {
          return asToolError('`highlightHash` requires `path` — a highlight anchor only makes sense on a document-anchored card.');
        }
        if (path) {
          if (highlightHash) {
            // Verify the anchor exists so we never write a dangling reference.
            // Sidecar highlights carry their hash in `id`.
            const { highlights } = await request('GET', `/api/highlights?path=${encodeURIComponent(path)}`);
            if (!highlights?.some((h) => h.id === highlightHash)) {
              return asToolError(`No highlight ${highlightHash} in ${path}. Read the document's sidecar (read_document) or create one with create_highlight first.`);
            }
          }
          const formData = new FormData();
          formData.append('docPath', path);
          formData.append(
            'card',
            JSON.stringify({
              cardType,
              origin: 'ai', // provenance marker — every MCP-created card carries it
              name: name || undefined,
              category: category || undefined,
              tags: tags && tags.length ? tags : undefined,
              vanillaData: {
                frontText: frontText || '',
                backText: backText || '',
                // Only type_answer has a compared value distinct from its back text; on
                // every other type the key would be dead weight in the sidecar.
                ...(cardType === 'type_answer' ? { answerText: answerText || '' } : {}),
                media: {},
                location: highlightHash ? { type: 'highlight', id: highlightHash } : undefined,
              },
              customData: { html: customHtml || '' },
            }),
          );
          const data = await upload('/api/media/vanilla', formData);
          // Normalize against the standalone branch below — this one returns the full
          // sidecar card object under `card`, that one returns a bare { globalHash }.
          return asText({ globalHash: data.card?.globalHash, documentPath: path, cardType, category: category ?? null });
        }
        const data = await request('POST', '/api/flashcards', { frontText, backText, answerText, name, cardType, category, customHtml, origin: 'ai' });
        return asText({ globalHash: data.globalHash, documentPath: null, cardType, category: category ?? null });
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
        tags: z.array(z.string()).optional().describe('Replaces the card\'s tags. Document-anchored cards only.'),
      },
    },
    // One call: PUT /api/flashcards/:hash resolves whether the card lives in a
    // document's sidecar or the system deck and merges the patch server-side. This
    // used to fetch the sidecar, splice the card and save the whole file back, which
    // silently reverted anything else written to that sidecar in between — the same
    // race delete_flashcard was moved off.
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
    // One server-side call: the API resolves whether the card lives in a document's
    // sidecar or the system deck, unlinks it from every deck, and deletes it. This
    // used to be a sidecar read-modify-write from here, which raced any concurrent
    // write to the same sidecar and left the card's deck entries dangling.
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
      description: 'Create a new, empty deck to organize flashcards into (e.g. "Interview Prep"). Add cards to it afterward with add_to_deck.',
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
        'Rename a deck, change its description, or replace its tags. Deck tags flow down to every member ' +
        'card, so tagging a deck is the fast way to tag a whole collection at once.',
      inputSchema: {
        deckHash: z.string().describe('The deck\'s globalHash (from list_decks).'),
        name: z.string().optional(),
        description: z.string().optional(),
        tags: z.array(z.string()).optional().describe('Replaces the deck\'s full tag set (does not merge); the tags propagate to member cards.'),
      },
    },
    async ({ deckHash, name, description, tags }) => {
      try {
        if (name !== undefined || description !== undefined) {
          await request('PUT', `/api/decks/${encodeURIComponent(deckHash)}`, { name, description });
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

        // Default to the book's own file name plus a short unique suffix — the same
        // scheme documents.createFlashcard uses, and for the same reason: a document's
        // media/ dir is shared by all its cards, and files.addVanillaData refuses to
        // overwrite. Book figures have fixed names ("fig1.png"), so without this the
        // second card built from one diagram would fail. An explicit `name` is honoured
        // as given, collision and all, because asking for a name means meaning it.
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
        'the clip is later removed, and the same asset can go on as many cards as you like. Only an ' +
        'asset the clipper actually downloaded (`cached: true`) can be attached; one still loading ' +
        'from the web is refused rather than fetched.',
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
        const query = `?path=${encodeURIComponent(clipPath)}&href=${encodeURIComponent(href)}`;
        const { buffer, mimeType } = await requestBuffer(`/api/reader/media-file${query}`);

        // The slot follows the bytes, not a parameter: a caller who had to say
        // "this is a sound" could say it wrong, and a mp3 in an image slot fails
        // silently at review time rather than here.
        const type = /^audio\//i.test(mimeType ?? '') ? 'sound' : 'image';

        // Default to the asset's own file name plus a short unique suffix, for the
        // same reason attach_book_image does: a document's media/ dir is shared by all
        // its cards and files.addVanillaData refuses to overwrite. A clip asset's name
        // is a content hash, so without this the second card built from one picture
        // would fail. An explicit `name` is honoured as given, collision and all.
        const fromClip = nodePath.basename(String(href).split('?')[0]);
        const ext = nodePath.extname(fromClip);
        const base = nodePath.basename(fromClip, ext).replace(/[^\w.-]+/g, '_') || type;
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
    'create_highlight',
    {
      title: 'Create highlight',
      description:
        'Create a highlight anchored to a passage in a document, so a flashcard can later reference the exact ' +
        'text it came from (pass the returned globalHash as create_flashcard\'s `highlightHash`). Prefer ' +
        '`snippet` — an exact-substring quote copied from read_document\'s output — over `start`/`end`: ' +
        'hand-counted character offsets are error-prone and easy to get off-by-one. If the snippet appears ' +
        'more than once, the first occurrence is used. Works on plain-text and Markdown documents; for ' +
        'Markdown, keep the snippet inside one paragraph and avoid spans containing links or images (the app ' +
        're-anchors it against the rendered text). PDF/video anchoring requires page/bbox or timestamp data ' +
        'this tool does not compute.',
      inputSchema: {
        path: z.string().describe('Relative path to the document.'),
        snippet: z.string().optional().describe('Exact text to anchor to, copied verbatim from the document. Preferred over start/end.'),
        start: z.number().int().optional().describe('Character offset where the highlight starts. Only used if snippet is omitted.'),
        end: z.number().int().optional().describe('Character offset where the highlight ends. Only used if snippet is omitted.'),
        color: z.enum(['amber', 'green', 'blue', 'pink']).default('amber'),
        note: z.string().optional(),
      },
    },
    async ({ path, snippet, start, end, color, note }) => {
      try {
        let text = snippet || null;
        if (snippet) {
          const doc = await request('GET', `/api/documents/read?path=${encodeURIComponent(path)}`);
          // Character offsets only mean something in a decoded text body; a PDF or
          // EPUB anchors by page/bbox or CFI, which the app computes from a real
          // selection. Say so plainly instead of failing on a null body.
          if (doc.binary || doc.content == null) {
            return asToolError(
              `${path} is a binary document (PDF/EPUB/media), so text-offset highlights do not apply to it. ` +
              `Highlights on these formats have to be made in the app by selecting the passage; you can then ` +
              `read them with list_highlights and build cards from them with create_flashcard's highlightHash.`,
            );
          }
          const idx = doc.content.indexOf(snippet);
          if (idx === -1) {
            return asToolError(`Snippet not found verbatim in ${path}. Re-check whitespace/punctuation against read_document's output and try again.`);
          }
          start = idx;
          end = idx + snippet.length;
        } else if (start == null || end == null) {
          return asToolError('Provide either `snippet`, or both `start` and `end`.');
        } else {
          // Offset mode: snapshot the covered text anyway so the highlight is
          // self-describing in list_highlights and survives re-anchoring.
          try {
            const doc = await request('GET', `/api/documents/read?path=${encodeURIComponent(path)}`);
            text = doc.content?.slice(start, end) || null;
          } catch { /* snapshot is best-effort */ }
        }
        const data = await request('POST', '/api/highlights', { path, type: 'text_offset', start, end, color, note, text });
        return asText(data);
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.registerTool(
    'update_highlight',
    {
      title: 'Update highlight',
      description: 'Change the color or note of an existing highlight. Its anchored text range cannot be changed — delete and recreate for that.',
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
        'Delete a highlight from a document. Flashcards anchored to it lose their source reference (the ' +
        'cards themselves survive) — check the sidecar via read_document if that matters.',
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

  // Pedagogical categories are create/update only by design — there is no
  // delete_category tool. Categories are referenced by every flashcard that
  // carries one, so removing a name would orphan those cards; the vault's
  // migration policy is strictly additive. Rename or re-prioritize instead.
  server.registerTool(
    'create_category',
    {
      title: 'Create pedagogical category',
      description:
        'Add a new pedagogical category (e.g. "Concept", "Definition") that flashcards can be tagged with ' +
        'via the `category` field of create_flashcard/update_flashcard. Priority orders review — lower is ' +
        'studied first. There is deliberately no way to delete a category; if a name is wrong, rename it ' +
        'with update_category rather than removing it.',
      inputSchema: {
        name: z.string().describe('Category name. Must be unique; the create fails if it already exists.'),
        priority: z.number().int().optional().describe('Review priority; lower = studied first. Defaults to 0.'),
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
        'Rename a pedagogical category, change its review priority, or edit its description. Identify it by ' +
        '`id` from list_categories. Every field is optional — only the ones you pass are changed. Renaming ' +
        'keeps all flashcards linked (they reference the category by id), which is why this, not a ' +
        'delete-and-recreate, is the correct way to fix a category.',
      inputSchema: {
        id: z.number().int().describe('The category\'s numeric `id` (from list_categories).'),
        name: z.string().optional().describe('New name. Must stay unique.'),
        priority: z.number().int().optional().describe('New review priority; lower = studied first.'),
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
}
