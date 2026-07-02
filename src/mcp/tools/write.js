import { z } from 'zod';
import { request, upload } from '../client.js';

const asText = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const asError = (err) => ({
  content: [{ type: 'text', text: `Flashback API error${err.status ? ` (${err.status})` : ''}: ${err.message}` }],
  isError: true,
});

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
        'For "type_answer" cards, frontText is the question and backText is the expected answer. For "custom" ' +
        'cards, put raw HTML in customHtml (frontText/backText are unused).',
      inputSchema: {
        path: z.string().optional().describe('Relative path of the document to attach this card to. Omit for a standalone card.'),
        cardType: z.enum(CARD_TYPES).default('basic'),
        frontText: z.string().optional(),
        backText: z.string().optional(),
        customHtml: z.string().optional().describe('Raw HTML body, only used when cardType is "custom".'),
        name: z.string().optional().describe('Optional descriptive name for the card.'),
        category: z.string().optional().describe('Pedagogical category name. Call list_categories first to see valid values — an unrecognized name is rejected with an error, not silently dropped.'),
        tags: z.array(z.string()).optional().describe('Tags to apply to the card. Only used for document-anchored cards.'),
      },
    },
    async ({ path, cardType, frontText, backText, customHtml, name, category, tags }) => {
      try {
        if (path) {
          const formData = new FormData();
          formData.append('docPath', path);
          formData.append(
            'card',
            JSON.stringify({
              cardType,
              name: name || undefined,
              category: category || undefined,
              tags: tags && tags.length ? tags : undefined,
              vanillaData: { frontText: frontText || '', backText: backText || '', media: {} },
              customData: { html: customHtml || '' },
            }),
          );
          const data = await upload('/api/media/vanilla', formData);
          // Normalize against the standalone branch below — this one returns the full
          // sidecar card object under `card`, that one returns a bare { globalHash }.
          return asText({ globalHash: data.card?.globalHash, documentPath: path, cardType, category: category ?? null });
        }
        const data = await request('POST', '/api/flashcards', { frontText, backText, name, cardType, category, customHtml });
        return asText({ globalHash: data.globalHash, documentPath: null, cardType, category: category ?? null });
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
        'Edit an existing standalone flashcard\'s content (front/back text, name, type, or category). Only works ' +
        'on standalone cards (created via create_flashcard with no `path`) — a document-anchored card must be ' +
        'edited from its document instead, this will return an error if given one.',
      inputSchema: {
        globalHash: z.string().describe('The card\'s globalHash.'),
        frontText: z.string().optional(),
        backText: z.string().optional(),
        name: z.string().optional(),
        cardType: z.enum(CARD_TYPES).optional(),
        category: z.string().optional().describe('Call list_categories first — an unrecognized name is rejected, not silently dropped.'),
      },
    },
    async ({ globalHash, frontText, backText, name, cardType, category }) => {
      try {
        const data = await request('PUT', `/api/flashcards/${encodeURIComponent(globalHash)}`, { frontText, backText, name, cardType, category });
        return asText(data);
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
    'create_highlight',
    {
      title: 'Create highlight',
      description:
        'Create a highlight anchored to a passage in a document, so a flashcard can later reference the exact ' +
        'text it came from. Prefer `snippet` — an exact-substring quote copied from read_document\'s output — ' +
        'over `start`/`end`: hand-counted character offsets are error-prone and easy to get off-by-one. If the ' +
        'snippet appears more than once, the first occurrence is used. Only meaningful for plain-text documents ' +
        '(type "text_offset") — PDF/video anchoring requires page/bbox or timestamp data this tool does not compute.',
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
        if (snippet) {
          const doc = await request('GET', `/api/documents/read?path=${encodeURIComponent(path)}`);
          const idx = doc.content.indexOf(snippet);
          if (idx === -1) {
            return {
              content: [{ type: 'text', text: `Snippet not found verbatim in ${path}. Re-check whitespace/punctuation against read_document's output and try again.` }],
              isError: true,
            };
          }
          start = idx;
          end = idx + snippet.length;
        } else if (start == null || end == null) {
          return { content: [{ type: 'text', text: 'Provide either `snippet`, or both `start` and `end`.' }], isError: true };
        }
        const data = await request('POST', '/api/highlights', { path, type: 'text_offset', start, end, color, note });
        return asText(data);
      } catch (err) {
        return asError(err);
      }
    },
  );
}
