// MCP tool integration tests — exercises the MCP server's tool handlers against
// a real HTTP API (port 0) backed by a real SQLite DB, exactly the way the MCP
// process talks to the app. Tool handlers are captured with a stub `server`
// object, so no stdio transport is involved.
// Run after `npm run tests` has built better-sqlite3 for system Node, or via the
// full suite. Standalone: node --test tests/mcp.test.js
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import process from 'process';
import validate from '../src/api/config/validate.js';
import { sealTools } from '../src/api/seal/seal.js';
import db from '../src/api/access/primitives/database.js';
import Documents from '../src/api/access/orchestration/documents.js';
import Api from '../src/api/api.js';
import { getWorkspacePath } from '../src/api/access/primitives/config.js';
import { buildPdf, buildEpub, buildPng } from './fixtures.js';
import { registerReadTools } from '../src/mcp/tools/read.js';
import { registerWriteTools } from '../src/mcp/tools/write.js';

process.env.USER_DATA_PATH = path.join(process.cwd(), 'data');

const API_TOKEN = 'mcp-test-token-0123456789abcdef';
const ROOT = 'McpTestWorkspace';
const docRel = `${ROOT}/notes.md`;
const DOC_TEXT = 'The mitochondria is the powerhouse of the cell. Photosynthesis creates glucose from light.';

// Capture every tool handler; mcp/client.js reads FLASHBACK_API_URL lazily, so
// registering before the API is up is fine.
const tools = new Map();
const stub = { registerTool: (name, _def, handler) => tools.set(name, handler) };
registerReadTools(stub);
registerWriteTools(stub);

// NOTE: this bypasses the MCP SDK's zod layer, so schema defaults are NOT
// applied — tests must pass every field they rely on explicitly.
const call = async (name, args = {}) => {
    const handler = tools.get(name);
    assert.ok(handler, `tool ${name} is registered`);
    const res = await handler(args);
    const text = res.content[0].text;
    let data = null;
    try { data = JSON.parse(text); } catch { /* error strings aren't JSON */ }
    return { isError: !!res.isError, text, data };
};

const cardRow = async (hash) => await db.prepare(`
    SELECT f.global_hash, f.name, f.card_type, f.document_id, c.frontText, c.backText, c.custom_html
    FROM Flashcards f JOIN FlashcardContent c ON f.content_id = c.id
    WHERE f.global_hash = ?
`).get(hash);

// Delete through the orchestrator so the DB rows go too. Removing the folder with
// fs alone leaves orphaned Documents rows behind, and the NEXT run of this file then
// collides on Documents.global_hash — a rerun has to start from the same clean slate
// as a first run. fs.rmSync is the fallback for anything not in the index.
const rmWorkspace = async () => {
    try { await new Documents().delete(ROOT, true); } catch { /* not indexed */ }
    try {
        const absPath = path.join(getWorkspacePath(), ROOT);
        if (fs.existsSync(absPath)) fs.rmSync(absPath, { recursive: true, force: true });
    } catch { /* ignore */ }
};

describe('MCP tools', () => {
    let api;
    let anchoredHash;   // document-anchored card under test
    let highlightHash;

    before(async () => {
        if (!await validate()) throw new Error('Validation failed');
        await rmWorkspace();
        await sealTools.init();
        api = new Api({ port: 0, logFormat: 'tiny', apiToken: API_TOKEN });
        const server = await api.start();
        process.env.FLASHBACK_API_URL = `http://localhost:${server.address().port}`;
        process.env.FLASHBACK_API_TOKEN = API_TOKEN;
        await new Documents().createFolder(ROOT);
    });

    after(async () => {
        await rmWorkspace();
        await api.stop();
    });

    it('registers the full tool set', () => {
        const expected = [
            // read
            'get_card_guide',
            'search_flashback', 'list_folder', 'read_document', 'read_document_text', 'get_due_cards',
            'list_book_images', 'view_book_image',
            'list_clip_media', 'view_clip_image',
            'list_decks', 'list_tags', 'list_categories', 'get_graph',
            'get_statistics', 'list_cards', 'get_card_health', 'search_content', 'get_links', 'get_recent_changes',
            'list_highlights', 'diary_list', 'diary_get_summary', 'diary_get_entry',
            // write
            'create_flashcard', 'update_flashcard', 'delete_flashcard',
            'create_document', 'update_document', 'create_folder', 'update_tags',
            'fetch_youtube_transcript',
            'create_deck', 'update_deck', 'delete_deck', 'add_to_deck', 'remove_from_deck',
            'create_highlight', 'update_highlight', 'delete_highlight', 'attach_media',
            'attach_book_image', 'attach_clip_media',
            'create_category', 'update_category',
        ];
        for (const name of expected) assert.ok(tools.has(name), `missing tool: ${name}`);
    });

    describe('get_card_guide', () => {
        it('serves the main guide as Markdown and advertises its reference sections', async () => {
            const res = await call('get_card_guide');
            assert.equal(res.isError, false, res.text);
            assert.equal(res.data, null, 'Markdown, not a JSON payload');
            assert.match(res.text, /^# Authoring Flashback cards/);
            assert.match(res.text, /One card, one retrieval/);
            // Progressive disclosure only works if the model is told the sections exist.
            assert.match(res.text, /## Reference sections/);
            assert.match(res.text, /`knowledge-types`/);
        });

        it('serves a reference section on request, and only that section', async () => {
            const res = await call('get_card_guide', { section: 'knowledge-types' });
            assert.equal(res.isError, false, res.text);
            assert.match(res.text, /^# Prompt patterns by knowledge type/);
            assert.ok(!res.text.includes('# Authoring Flashback cards'), 'the main guide is not repeated');
        });

        it('names the valid sections when asked for one that does not exist', async () => {
            const res = await call('get_card_guide', { section: 'no-such-section' });
            assert.equal(res.isError, true);
            assert.match(res.text, /knowledge-types/);
        });

        // The guide tells the model which tools to call. If a tool is ever renamed or
        // dropped, the guide silently starts teaching a dead API — so pin it here rather
        // than discovering it when an assistant follows the instructions and fails.
        it('every MCP tool the guide names is actually registered', async () => {
            const guide = await call('get_card_guide');
            const refs = await call('get_card_guide', { section: 'knowledge-types' });
            const named = new Set(
                `${guide.text}\n${refs.text}`.match(
                    /\b(?:get|list|read|create|update|delete|search|add|remove|attach|fetch)_[a-z_]+\b/g,
                ) ?? [],
            );
            assert.ok(named.size >= 10, `expected the guide to name real tools, found ${named.size}`);
            for (const name of named) {
                assert.ok(tools.has(name), `the guide tells the model to call ${name}, which is not registered`);
            }
        });
    });

    it('create_document writes content readable via read_document', async () => {
        const created = await call('create_document', { name: 'notes.md', parentPath: ROOT, content: DOC_TEXT });
        assert.equal(created.isError, false, created.text);
        const read = await call('read_document', { path: docRel });
        assert.equal(read.isError, false, read.text);
        assert.ok(read.data.content.includes('mitochondria'));
    });

    it('update_document replaces the body', async () => {
        const appended = `${DOC_TEXT}\n\nATP is the cell's energy currency.`;
        const res = await call('update_document', { path: docRel, content: appended });
        assert.equal(res.isError, false, res.text);
        const read = await call('read_document', { path: docRel });
        assert.ok(read.data.content.includes('ATP'));
    });

    it('create_flashcard anchors a card to the document', async () => {
        const res = await call('create_flashcard', {
            path: docRel, cardType: 'basic',
            frontText: 'What organelle powers the cell?', backText: 'The mitochondria',
            tags: ['mcp-test'],
        });
        assert.equal(res.isError, false, res.text);
        anchoredHash = res.data.globalHash;
        assert.ok(anchoredHash, 'globalHash assigned');
        assert.equal(res.data.documentPath, docRel);

        const read = await call('read_document', { path: docRel });
        const card = read.data.metadata.flashcards.find((f) => f.globalHash === anchoredHash);
        assert.ok(card, 'card in sidecar');
        const row = await cardRow(anchoredHash);
        assert.ok(row?.document_id, 'card linked to a document in the DB');
    });

    it('update_flashcard without documentPath auto-resolves the card\'s document', async () => {
        const res = await call('update_flashcard', { globalHash: anchoredHash, name: 'auto-resolved edit' });
        assert.equal(res.isError, false, res.text);
        assert.equal(res.data.documentPath.replace(/\\/g, '/'), docRel, 'resolved to the right document');
        assert.equal((await cardRow(anchoredHash)).name, 'auto-resolved edit');
        assert.equal((await cardRow(anchoredHash)).frontText, 'What organelle powers the cell?', 'omitted fields untouched');
    });

    it('update_flashcard on an unknown hash is a clean not-found error', async () => {
        const res = await call('update_flashcard', { globalHash: 'no-such-card-hash', frontText: 'x' });
        assert.equal(res.isError, true);
        assert.match(res.text, /not found/i);
    });

    it('update_flashcard with documentPath edits the anchored card, preserving omitted fields', async () => {
        const res = await call('update_flashcard', {
            globalHash: anchoredHash, documentPath: docRel,
            frontText: 'Which organelle is the powerhouse of the cell?',
            tags: ['mcp-test', 'edited'],
        });
        assert.equal(res.isError, false, res.text);

        const read = await call('read_document', { path: docRel });
        const card = read.data.metadata.flashcards.find((f) => f.globalHash === anchoredHash);
        assert.equal(card.vanillaData.frontText, 'Which organelle is the powerhouse of the cell?');
        assert.equal(card.vanillaData.backText, 'The mitochondria', 'omitted backText preserved');
        assert.deepEqual(card.tags, ['mcp-test', 'edited']);

        const row = await cardRow(anchoredHash);
        assert.equal(row.frontText, 'Which organelle is the powerhouse of the cell?', 'derived layer synced');
    });

    it('create_category adds a category that list_categories then reports, and update_category renames it', async () => {
        const uniqueName = `MCP Concept ${Date.now()}`;
        const created = await call('create_category', { name: uniqueName, priority: 7, description: 'from mcp test' });
        assert.equal(created.isError, false, created.text);
        assert.ok(Number.isInteger(created.data.id), 'returns numeric id');

        let listed = await call('list_categories');
        assert.ok(listed.data.some((c) => c.name === uniqueName && c.priority === 7), 'category is listed');

        const renamed = `${uniqueName} (renamed)`;
        const updated = await call('update_category', { id: created.data.id, name: renamed, priority: 3 });
        assert.equal(updated.isError, false, updated.text);

        listed = await call('list_categories');
        const row = listed.data.find((c) => c.id === created.data.id);
        assert.ok(row, 'category survives update (kept by id)');
        assert.equal(row.name, renamed);
        assert.equal(row.priority, 3);
    });

    it('update_flashcard rejects an unknown category on the sidecar path', async () => {
        const res = await call('update_flashcard', {
            globalHash: anchoredHash, documentPath: docRel, category: 'NotARealCategory',
        });
        assert.equal(res.isError, true);
        assert.match(res.text, /Unknown category/);
    });

    // The tool no longer resolves the card itself (it used to fetch the sidecar and
    // splice the card in the client, which raced every other write to that file) —
    // the API resolves the hash to its home, so an unknown hash is its 404.
    it('update_flashcard errors clearly when the card does not exist', async () => {
        const res = await call('update_flashcard', {
            globalHash: 'no-such-card-hash', documentPath: docRel, frontText: 'x',
        });
        assert.equal(res.isError, true);
        assert.match(res.text, /404.*not found/i);
    });

    it('create_highlight + highlight-anchored create_flashcard', async () => {
        const hl = await call('create_highlight', {
            path: docRel, snippet: 'Photosynthesis creates glucose', color: 'green', note: 'key process',
        });
        assert.equal(hl.isError, false, hl.text);
        highlightHash = hl.data.highlight.id;
        assert.ok(highlightHash);

        const bogus = await call('create_flashcard', {
            path: docRel, cardType: 'basic', frontText: 'q', backText: 'a', highlightHash: 'bogus-hash',
        });
        assert.equal(bogus.isError, true);
        assert.match(bogus.text, /No highlight/);

        const res = await call('create_flashcard', {
            path: docRel, cardType: 'basic',
            frontText: 'What does photosynthesis create?', backText: 'Glucose',
            highlightHash,
        });
        assert.equal(res.isError, false, res.text);

        const read = await call('read_document', { path: docRel });
        const card = read.data.metadata.flashcards.find((f) => f.globalHash === res.data.globalHash);
        assert.deepEqual(card.vanillaData.location, { type: 'highlight', id: highlightHash });
    });

    it('list_highlights surfaces text, context, and card linkage; MCP cards are marked origin ai', async () => {
        // Relies on the highlight + anchored card created in the previous test.
        const res = await call('list_highlights', { path: docRel });
        assert.equal(res.isError, false, res.text);
        const hl = res.data.highlights.find((h) => h.id === highlightHash);
        assert.ok(hl, 'created highlight is listed');
        assert.equal(hl.text, 'Photosynthesis creates glucose', 'snippet snapshot persisted on creation');
        assert.ok(hl.context?.includes('powerhouse of the cell'), 'context includes surrounding body text');
        assert.equal(hl.hasCards, true);
        assert.equal(hl.cardHashes.length, 1);

        const uncarded = await call('list_highlights', { path: docRel, uncardedOnly: true });
        assert.equal(uncarded.isError, false, uncarded.text);
        assert.ok(!uncarded.data.highlights.some((h) => h.id === highlightHash), 'uncardedOnly excludes carded highlights');

        // Provenance: the anchored card is origin 'ai' in the sidecar (canonical) and the DB row.
        const read = await call('read_document', { path: docRel });
        const aiCard = read.data.metadata.flashcards.find((f) => f.vanillaData?.location?.id === highlightHash);
        assert.equal(aiCard.origin, 'ai');
        const row = await db.prepare('SELECT origin FROM Flashcards WHERE global_hash = ?').get(aiCard.globalHash);
        assert.equal(row.origin, 'ai');

        // list_cards can slice by provenance so handmade cards can serve as style examples.
        const ai = await call('list_cards', { origin: 'ai', limit: 200 });
        assert.equal(ai.isError, false, ai.text);
        assert.ok(ai.data.cards.some((c) => c.global_hash === aiCard.globalHash));
        assert.ok(ai.data.cards.every((c) => c.origin === 'ai'));
        const human = await call('list_cards', { origin: 'human', limit: 200 });
        assert.equal(human.isError, false, human.text);
        assert.ok(!human.data.cards.some((c) => c.global_hash === aiCard.globalHash));
    });

    it('standalone create_flashcard is marked origin ai too', async () => {
        const res = await call('create_flashcard', {
            cardType: 'basic', frontText: 'Standalone provenance Q', backText: 'A',
        });
        assert.equal(res.isError, false, res.text);
        const row = await db.prepare('SELECT origin FROM Flashcards WHERE global_hash = ?').get(res.data.globalHash);
        assert.equal(row.origin, 'ai');
        await call('delete_flashcard', { globalHash: res.data.globalHash });
    });

    it('highlightHash without path is rejected up front', async () => {
        const res = await call('create_flashcard', { cardType: 'basic', frontText: 'q', backText: 'a', highlightHash: 'h' });
        assert.equal(res.isError, true);
        assert.match(res.text, /requires `path`/);
    });

    it('update_highlight and delete_highlight round-trip', async () => {
        const upd = await call('update_highlight', { path: docRel, highlightHash, color: 'pink', note: 'updated' });
        assert.equal(upd.isError, false, upd.text);
        assert.equal(upd.data.highlight.color, 'pink');

        const del = await call('delete_highlight', { path: docRel, highlightHash });
        assert.equal(del.isError, false, del.text);
        const read = await call('read_document', { path: docRel });
        assert.ok(!(read.data.metadata.highlights ?? []).some((h) => h.id === highlightHash));
    });

    it('standalone card: partial update merges instead of wiping omitted fields', async () => {
        const created = await call('create_flashcard', {
            cardType: 'basic', frontText: 'Standalone Q', backText: 'Standalone A', name: 'Standalone card',
        });
        assert.equal(created.isError, false, created.text);
        const hash = created.data.globalHash;
        assert.equal(created.data.documentPath, null);

        const res = await call('update_flashcard', { globalHash: hash, frontText: 'Standalone Q (edited)' });
        assert.equal(res.isError, false, res.text);
        const row = await cardRow(hash);
        assert.equal(row.frontText, 'Standalone Q (edited)');
        assert.equal(row.backText, 'Standalone A', 'omitted backText preserved');
        assert.equal(row.name, 'Standalone card', 'omitted name preserved');

        const del = await call('delete_flashcard', { globalHash: hash });
        assert.equal(del.isError, false, del.text);
        assert.equal(await cardRow(hash), undefined);
    });

    it('standalone custom card: customHtml is editable', async () => {
        const created = await call('create_flashcard', { cardType: 'custom', customHtml: '<b>front v1</b>', name: 'Custom card' });
        assert.equal(created.isError, false, created.text);
        const hash = created.data.globalHash;
        assert.equal((await cardRow(hash)).custom_html, '<b>front v1</b>');

        const res = await call('update_flashcard', { globalHash: hash, customHtml: '<b>front v2</b>' });
        assert.equal(res.isError, false, res.text);
        const row = await cardRow(hash);
        assert.equal(row.custom_html, '<b>front v2</b>');
        assert.equal(row.card_type, 'custom', 'omitted cardType preserved');

        await call('delete_flashcard', { globalHash: hash });
    });

    it('delete_flashcard on an anchored card auto-resolves and removes it everywhere', async () => {
        const res = await call('delete_flashcard', { globalHash: anchoredHash });
        assert.equal(res.isError, false, res.text);
        assert.equal(res.data.documentPath.replace(/\\/g, '/'), docRel, 'resolved to the right document');
        const read = await call('read_document', { path: docRel });
        assert.ok(!read.data.metadata.flashcards.some((f) => f.globalHash === anchoredHash), 'gone from sidecar');
        assert.equal(await cardRow(anchoredHash), undefined, 'gone from DB');
    });

    it('deck lifecycle: create → update+tags → add/remove entry → delete', async () => {
        const created = await call('create_deck', { name: 'MCP Test Deck', description: 'temp' });
        assert.equal(created.isError, false, created.text);
        const deckHash = created.data.globalHash;

        const upd = await call('update_deck', { deckHash, name: 'MCP Test Deck (renamed)', tags: ['mcp-deck-tag'] });
        assert.equal(upd.isError, false, upd.text);
        assert.deepEqual(upd.data.tags, ['mcp-deck-tag']);

        const card = await call('create_flashcard', {
            path: docRel, cardType: 'basic', frontText: 'deck member Q', backText: 'deck member A',
        });
        const added = await call('add_to_deck', { deckHash, cardHash: card.data.globalHash, documentPath: docRel });
        assert.equal(added.isError, false, added.text);

        const removed = await call('remove_from_deck', { deckHash, cardHash: card.data.globalHash });
        assert.equal(removed.isError, false, removed.text);

        const del = await call('delete_deck', { deckHash });
        assert.equal(del.isError, false, del.text);
        assert.equal((await cardRow(card.data.globalHash))?.global_hash, card.data.globalHash, 'member card survives deck deletion');
        await call('delete_flashcard', { globalHash: card.data.globalHash, documentPath: docRel });
    });

    it('delete_deck refuses the system deck', async () => {
        const decks = await call('list_decks', {});
        const system = decks.data.find((d) => d.is_system === 1);
        assert.ok(system, 'system deck exists');
        const res = await call('delete_deck', { deckHash: system.global_hash });
        assert.equal(res.isError, true);
        assert.match(res.text, /(403|system deck)/i);
    });

    it('get_statistics, list_cards, and get_due accept the algorithm/filters', async () => {
        const stats = await call('get_statistics', { algorithm: 'fsrs' });
        assert.equal(stats.isError, false, stats.text);
        assert.ok(stats.data && typeof stats.data === 'object');

        const cards = await call('list_cards', { limit: 5, sortBy: 'level', sortDir: 'desc' });
        assert.equal(cards.isError, false, cards.text);
        assert.ok(Array.isArray(cards.data.cards));
        assert.equal(typeof cards.data.total, 'number');
        if (cards.data.cards.length) {
            assert.ok('document_path' in cards.data.cards[0], 'cards expose document_path for update/delete tools');
        }

        const due = await call('get_due_cards', { algorithm: 'fsrs' });
        assert.equal(due.isError, false, due.text);
    });

    it('create_folder makes a folder create_document can target', async () => {
        const res = await call('create_folder', { name: 'chapters', parentPath: ROOT });
        assert.equal(res.isError, false, res.text);
        const doc = await call('create_document', { name: 'ch1.md', parentPath: `${ROOT}/chapters`, content: 'Chapter one.' });
        assert.equal(doc.isError, false, doc.text);
        const listing = await call('list_folder', { path: ROOT });
        assert.ok(listing.data.some((e) => e.name === 'chapters' && e.type === 'folder'));
    });

    it('search_content finds text in document bodies with snippets', async () => {
        const res = await call('search_content', { query: 'energy currency' });
        assert.equal(res.isError, false, res.text);
        const hit = res.data.find((r) => r.path.replace(/\\/g, '/') === docRel);
        assert.ok(hit, 'notes.md matched by body text');
        assert.ok(hit.matches >= 1);
        assert.match(hit.snippets[0], /energy currency/);
        // name-index search does NOT see body text — that's the whole point of the tool
        const indexed = await call('search_flashback', { query: 'energy currency' });
        assert.equal(indexed.data.documents.length, 0);
    });

    it('get_links reports outgoing, backlinks, and pending wiki links', async () => {
        const read = await call('read_document', { path: docRel });
        const notesHash = read.data.metadata.globalHash;
        const linkedRel = `${ROOT}/linked.md`;
        const created = await call('create_document', {
            name: 'linked.md', parentPath: ROOT,
            content: `See [my notes](flashback://${notesHash}) and [a ghost](flashback://00000000-dead-beef-0000-000000000000).`,
        });
        assert.equal(created.isError, false, created.text);

        const fromLinked = await call('get_links', { path: linkedRel });
        assert.equal(fromLinked.isError, false, fromLinked.text);
        assert.ok(fromLinked.data.outgoing.some((d) => d.global_hash === notesHash), 'outgoing edge to notes.md');
        assert.equal(fromLinked.data.pending.length, 1, 'ghost target is pending');

        const fromNotes = await call('get_links', { path: docRel });
        assert.ok(fromNotes.data.backlinks.some((d) => d.path.replace(/\\/g, '/') === linkedRel), 'backlink from linked.md');

        const missing = await call('get_links', { path: `${ROOT}/nope.md` });
        assert.equal(missing.isError, true);
    });

    it('get_recent_changes returns flattened Seal commits', async () => {
        const res = await call('get_recent_changes', { limit: 10 });
        assert.equal(res.isError, false, res.text);
        assert.ok(Array.isArray(res.data) && res.data.length > 0, 'has commits');
        const entry = res.data[0];
        assert.equal(typeof entry.ref, 'string');
        assert.equal(typeof entry.message, 'string');
        assert.ok(entry.date === null || !Number.isNaN(Date.parse(entry.date)));
        assert.ok(res.data.some((e) => /^(create|edit|move|delete|reconcile):/.test(e.message)), 'messages follow the Seal convention');
    });

    it('attach_media puts a local image on a card', async () => {
        const png = Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
            'base64',
        );
        const tmpFile = path.join(process.cwd(), 'data', `mcp-attach-${Date.now()}.png`);
        fs.writeFileSync(tmpFile, png);
        try {
            const card = await call('create_flashcard', {
                path: docRel, cardType: 'basic', frontText: 'media Q', backText: 'media A',
            });
            assert.equal(card.isError, false, card.text);

            const rejected = await call('attach_media', {
                documentPath: docRel, flashcardHash: card.data.globalHash,
                filePath: tmpFile, position: 'front', name: 'evil.exe',
            });
            assert.equal(rejected.isError, true);
            assert.match(rejected.text, /Unsupported media extension/);

            const res = await call('attach_media', {
                documentPath: docRel, flashcardHash: card.data.globalHash, filePath: tmpFile, position: 'front',
            });
            assert.equal(res.isError, false, res.text);
            assert.equal(res.data.type, 'image');

            const read = await call('read_document', { path: docRel });
            const saved = read.data.metadata.flashcards.find((f) => f.globalHash === card.data.globalHash);
            assert.ok(saved.vanillaData.media?.front_img, 'front image reference stored in the sidecar');

            await call('delete_flashcard', { globalHash: card.data.globalHash });
        } finally {
            fs.rmSync(tmpFile, { force: true });
        }
    });

    // A PDF/EPUB/media document has no readable body. Decoding one used to hand the
    // assistant megabytes of mojibake; these pin the tools that touch a body, and the
    // route from "you can't read this" to the tool that can.
    describe('binary documents', () => {
        const scanRel = `${ROOT}/scan.pdf`;
        const bookRel = `${ROOT}/book.pdf`;
        const epubRel = `${ROOT}/book.epub`;
        const ytRel = `${ROOT}/talk.youtube`;
        const bareRel = `${ROOT}/bare.youtube`;
        // No text layer and unparseable — stands in for a scanned document.
        const scanBytes = Buffer.concat([
            Buffer.from('%PDF-1.4\n'),
            Buffer.from([0x00, 0x01, 0x02, 0x00]),
            Buffer.alloc(4096, 0xa7),
        ]);

        before(async () => {
            const d = new Documents();
            await d.importFile('scan.pdf', ROOT, scanBytes, {});
            await d.importFile('book.pdf', ROOT, buildPdf([
                ['Page one about mitochondria.'],
                ['Page two about chloroplasts.'],
            ]), {});
            await d.importFile('book.epub', ROOT, buildEpub([
                { href: 'ch1.xhtml', title: 'Chapter One', body: '<p>The cell is the unit of life.</p>' },
            ]), {});
            await d.importFile('illustrated.epub', ROOT, buildEpub([
                {
                    href: 'ch1.xhtml', title: 'Cells',
                    body: '<p>The cell is the unit of life.</p>'
                        + '<figure><img src="images/fig1.png" alt="A mitochondrion"/>'
                        + '<figcaption>Figure 1. The powerhouse.</figcaption></figure>',
                },
                { href: 'ch2.xhtml', title: 'Light', body: '<p>Photosynthesis.</p><img src="images/fig2.png" alt="A chloroplast"/>' },
            ], [
                { href: 'images/fig1.png' },
                { href: 'images/fig2.png' },
            ]), {});
            // Each cue's text exceeds the transcript block cap, so cue == block and the
            // block starts (0:00, 1:30) are deterministic for `at` addressing.
            const ytFiller = 'detail '.repeat(80);
            await d.importFile('talk.youtube', ROOT, Buffer.from(JSON.stringify({
                url: 'https://youtu.be/xyz', videoId: 'xyz', title: 'Cells Talk',
            })), {
                source: {
                    videoId: 'xyz',
                    transcript: [
                        { start: 0, dur: 30, text: `ALPHA ${ytFiller}` },
                        { start: 90, dur: 30, text: `CHARLIE ${ytFiller}` },
                    ],
                    transcriptMeta: { lang: 'en', kind: 'asr' },
                },
            });
            await d.importFile('bare.youtube', ROOT, Buffer.from(JSON.stringify({
                url: 'https://youtu.be/bare', videoId: 'bare', title: 'No Captions',
            })), {});

            // A clip that has been read for a while: a picture and a sound already saved
            // into the vault (a card was built from each), and one picture still loading
            // from the site it was clipped from, as every asset starts out.
            await d.importFile('article.clip', ROOT, Buffer.from(
                '<h1>Birdsong</h1><p>Prose about calls.</p>'
                + '<figure><img src="./media/clip-aaaaaaaaaaaa.png" alt="A wren"/>'
                + '<figcaption>Figure 1. A wren.</figcaption></figure>'
                + '<audio src="./media/clip-cccccccccccc.mp3" controls></audio>'
                + '<img src="https://example.test/remote.png" alt="Never downloaded"/>',
            ), {});
            const clipMediaDir = path.join(getWorkspacePath(), ROOT, 'media');
            fs.mkdirSync(clipMediaDir, { recursive: true });
            fs.writeFileSync(path.join(clipMediaDir, 'clip-aaaaaaaaaaaa.png'), buildPng(1));
            fs.writeFileSync(path.join(clipMediaDir, 'clip-cccccccccccc.mp3'), Buffer.from('ID3-fake-mp3'));
        });

        it('read_document returns metadata and guidance instead of decoded bytes', async () => {
            const read = await call('read_document', { path: scanRel });
            // Not a tool error: the sidecar is still perfectly useful.
            assert.equal(read.isError, false, read.text);
            assert.match(read.text, /binary document/i);
            assert.match(read.text, /list_highlights/, 'points at where the readable substance is');
            assert.match(read.text, /update_document/, 'warns against the destructive write');
            assert.ok(!read.text.includes('%PDF'), 'no decoded file bytes leak into the response');
        });

        it('read_document routes an extractable PDF to read_document_text with its page count', async () => {
            const read = await call('read_document', { path: bookRel });
            assert.equal(read.isError, false, read.text);
            assert.match(read.text, /read_document_text/);
            assert.match(read.text, /2 pages/, 'says how much there is to read');
        });

        it('read_document_text reads a PDF page by page', async () => {
            const p1 = await call('read_document_text', { path: bookRel });
            assert.equal(p1.isError, false, p1.text);
            assert.equal(p1.data.unit, 'page');
            assert.equal(p1.data.total, 2);
            assert.match(p1.data.text, /mitochondria/);
            assert.equal(p1.data.next, 2);

            const p2 = await call('read_document_text', { path: bookRel, index: p1.data.next });
            assert.match(p2.data.text, /chloroplasts/);
            assert.equal(p2.data.hasMore, false);
        });

        // A figure is content read_document_text structurally cannot return, and the
        // only bytes this server hands a model. These pin all three halves: choosing
        // an image by its metadata, seeing one, and getting one onto a card.
        describe('EPUB images', () => {
            const illRel = `${ROOT}/illustrated.epub`;

            it('list_book_images describes each figure without sending it', async () => {
                const res = await call('list_book_images', { path: illRel });
                assert.equal(res.isError, false, res.text);
                assert.equal(res.data.total, 2);
                const [fig1] = res.data.images;
                assert.equal(fig1.name, 'fig1.png');
                assert.equal(fig1.alt, 'A mitochondrion');
                assert.equal(fig1.caption, 'Figure 1. The powerhouse.');
                assert.equal(fig1.section, 'Cells');
                assert.equal(fig1.sectionIndex, 1);
                assert.ok(!/base64|PNG/.test(res.text), 'metadata only — no bytes in the response');
            });

            it('list_book_images narrows to one section', async () => {
                const res = await call('list_book_images', { path: illRel, section: 2 });
                assert.equal(res.data.total, 1);
                assert.equal(res.data.images[0].name, 'fig2.png');
            });

            it('list_book_images refuses a format with no images', async () => {
                const res = await call('list_book_images', { path: bookRel });
                assert.equal(res.isError, true);
                assert.match(res.text, /only EPUBs/);
            });

            it('view_book_image returns a real image block, not text', async () => {
                // call() unwraps content[0].text, which an image block does not have —
                // go through the handler so the block itself can be inspected.
                const res = await tools.get('view_book_image')({ path: illRel, href: 'images/fig1.png' });
                assert.ok(!res.isError, JSON.stringify(res));
                const block = res.content[0];
                assert.equal(block.type, 'image');
                assert.equal(block.mimeType, 'image/png');
                // buildEpub tints by position, so this is provably the FIRST figure.
                assert.deepEqual(Buffer.from(block.data, 'base64'), buildPng(1));
            });

            it('view_book_image refuses an image the book does not declare', async () => {
                const res = await call('view_book_image', { path: illRel, href: 'images/ghost.png' });
                assert.equal(res.isError, true);
                assert.match(res.text, /No image/);
            });

            it('attach_book_image copies a figure out of the zip onto a card', async () => {
                const card = await call('create_flashcard', {
                    path: docRel, cardType: 'basic', frontText: 'Which organelle?', backText: 'Mitochondrion',
                });
                assert.equal(card.isError, false, card.text);
                try {
                    const res = await call('attach_book_image', {
                        bookPath: illRel, href: 'images/fig1.png',
                        documentPath: docRel, flashcardHash: card.data.globalHash, position: 'front',
                    });
                    assert.equal(res.isError, false, res.text);
                    assert.equal(res.data.type, 'image');
                    // The book's name plus a short unique suffix, not the bare name.
                    assert.match(res.data.name, /^fig1-[0-9a-f]{8}\.png$/);

                    const read = await call('read_document', { path: docRel });
                    const saved = read.data.metadata.flashcards.find((f) => f.globalHash === card.data.globalHash);
                    assert.ok(saved.vanillaData.media?.front_img, 'the sidecar references it');

                    // The bytes are copied into the CARD's document, not linked back into
                    // the book — so the card survives the book being deleted.
                    const copied = path.join(
                        getWorkspacePath(), path.dirname(docRel), 'media',
                        path.basename(saved.vanillaData.media.front_img),
                    );
                    assert.ok(fs.existsSync(copied), `media file written to ${copied}`);
                    assert.deepEqual(fs.readFileSync(copied), buildPng(1), 'byte-for-byte the book\'s figure');

                    const row = await db.prepare('SELECT name FROM Media WHERE absolute_path = ?').get(copied);
                    assert.ok(row, 'and registered in the Media table');
                } finally {
                    await call('delete_flashcard', { globalHash: card.data.globalHash });
                }
            });

            it('attach_book_image puts one figure on several cards in the same document', async () => {
                // A document's media/ dir is shared by all its cards and
                // files.addVanillaData refuses to overwrite, so a fixed book name like
                // "fig1.png" made the second card fail. One diagram feeding several
                // cards is ordinary use, not an edge case.
                const cards = [];
                for (const n of [1, 2]) {
                    const c = await call('create_flashcard', {
                        path: docRel, cardType: 'basic', frontText: `organelle Q${n}`, backText: `A${n}`,
                    });
                    assert.equal(c.isError, false, c.text);
                    cards.push(c.data.globalHash);
                }
                try {
                    const names = [];
                    for (const hash of cards) {
                        const res = await call('attach_book_image', {
                            bookPath: illRel, href: 'images/fig1.png',
                            documentPath: docRel, flashcardHash: hash, position: 'front',
                        });
                        assert.equal(res.isError, false, res.text);
                        names.push(res.data.name);
                    }
                    assert.notEqual(names[0], names[1], 'each attachment gets its own file');

                    const read = await call('read_document', { path: docRel });
                    for (const [i, hash] of cards.entries()) {
                        const saved = read.data.metadata.flashcards.find((f) => f.globalHash === hash);
                        assert.equal(saved.vanillaData.media.front_img, `./media/${names[i]}`);
                        const abs = path.join(getWorkspacePath(), path.dirname(docRel), 'media', names[i]);
                        assert.deepEqual(fs.readFileSync(abs), buildPng(1), 'both are the same figure');
                    }
                } finally {
                    for (const hash of cards) await call('delete_flashcard', { globalHash: hash });
                }
            });

            it('attach_book_image refuses a name it cannot type from its extension', async () => {
                const res = await call('attach_book_image', {
                    bookPath: illRel, href: 'images/fig1.png', documentPath: docRel,
                    flashcardHash: 'whatever', position: 'front', name: 'figure',
                });
                assert.equal(res.isError, true);
                assert.match(res.text, /no file extension/);
            });
        });

        // The clip half of the same three-tool split. Its one real difference from a
        // book: these assets are files on disk, so a listing has to say so, and sound
        // exists at all — which view_clip_image must refuse rather than fumble.
        describe('clip media', () => {
            const clipRel = `${ROOT}/article.clip`;

            it('list_clip_media describes each asset without sending it', async () => {
                const res = await call('list_clip_media', { path: clipRel });
                assert.equal(res.isError, false, res.text);
                assert.equal(res.data.total, 3);

                const [wren] = res.data.media;
                assert.equal(wren.kind, 'image');
                assert.equal(wren.alt, 'A wren');
                assert.equal(wren.caption, 'Figure 1. A wren.');
                assert.equal(wren.heading, 'Birdsong');
                assert.equal(wren.cached, true);
                assert.ok(wren.path, 'a clip asset reports where it really is');
                assert.ok(!/base64/.test(res.text), 'metadata only — no bytes in the response');

                const remote = res.data.media.find((m) => m.name === 'remote.png');
                assert.equal(remote.cached, false, 'an undownloaded picture is reported, not hidden');
                assert.equal(remote.path, null);
            });

            it('list_clip_media narrows to one kind', async () => {
                const res = await call('list_clip_media', { path: clipRel, kind: 'audio' });
                assert.equal(res.data.total, 1);
                assert.equal(res.data.media[0].name, 'clip-cccccccccccc.mp3');
            });

            it('list_clip_media refuses a format that carries no media', async () => {
                const res = await call('list_clip_media', { path: bookRel });
                assert.equal(res.isError, true);
                assert.match(res.text, /EPUBs and saved web clips/);
            });

            it('view_clip_image returns a real image block, not text', async () => {
                const res = await tools.get('view_clip_image')({ path: clipRel, href: './media/clip-aaaaaaaaaaaa.png' });
                assert.ok(!res.isError, JSON.stringify(res));
                assert.equal(res.content[0].type, 'image');
                assert.deepEqual(Buffer.from(res.content[0].data, 'base64'), buildPng(1));
            });

            it('view_clip_image refuses a sound instead of returning bytes nobody can hear', async () => {
                const res = await call('view_clip_image', { path: clipRel, href: 'clip-cccccccccccc.mp3' });
                assert.equal(res.isError, true);
                assert.match(res.text, /cannot play|nothing here can play/i);
                assert.match(res.text, /attach_clip_media/, 'points at what CAN be done with it');
            });

            it('view_clip_image goes and gets an asset still on the web, and says why when it cannot', async () => {
                // Capturing a clip downloads no media, so most of what list_clip_media
                // reports is still on the original site. Looking at one saves it into
                // the vault first — it is no longer a refusal. Here the host does not
                // exist, so what comes back is that failure rather than the old
                // "nothing here will fetch it".
                const res = await call('view_clip_image', { path: clipRel, href: 'https://example.test/remote.png' });
                assert.equal(res.isError, true);
                assert.match(res.text, /could not reach|refused/i, res.text);
                assert.ok(!/never downloaded/.test(res.text), 'not refused for being remote');
            });

            it('attach_clip_media puts a clipped picture on a card', async () => {
                const card = await call('create_flashcard', {
                    path: docRel, cardType: 'basic', frontText: 'Which bird?', backText: 'A wren',
                });
                assert.equal(card.isError, false, card.text);
                try {
                    const res = await call('attach_clip_media', {
                        clipPath: clipRel, href: './media/clip-aaaaaaaaaaaa.png',
                        documentPath: docRel, flashcardHash: card.data.globalHash, position: 'front',
                    });
                    assert.equal(res.isError, false, res.text);
                    assert.equal(res.data.type, 'image');

                    const read = await call('read_document', { path: docRel });
                    const saved = read.data.metadata.flashcards.find((f) => f.globalHash === card.data.globalHash);
                    assert.ok(saved.vanillaData.media?.front_img, 'lands in the picture slot');

                    const copied = path.join(
                        getWorkspacePath(), path.dirname(docRel), 'media',
                        path.basename(saved.vanillaData.media.front_img),
                    );
                    assert.deepEqual(fs.readFileSync(copied), buildPng(1), 'byte-for-byte the clipped picture');
                } finally {
                    await call('delete_flashcard', { globalHash: card.data.globalHash });
                }
            });

            it('attach_clip_media routes a sound to the sound slot, not the picture slot', async () => {
                // The slot follows the bytes rather than a caller-supplied flag: an mp3 in
                // an image slot would fail silently at review time instead of here.
                const card = await call('create_flashcard', {
                    path: docRel, cardType: 'basic', frontText: 'Name this call', backText: 'Wren',
                });
                assert.equal(card.isError, false, card.text);
                try {
                    const res = await call('attach_clip_media', {
                        clipPath: clipRel, href: 'clip-cccccccccccc.mp3',
                        documentPath: docRel, flashcardHash: card.data.globalHash, position: 'front',
                    });
                    assert.equal(res.isError, false, res.text);
                    assert.equal(res.data.type, 'sound');

                    const read = await call('read_document', { path: docRel });
                    const saved = read.data.metadata.flashcards.find((f) => f.globalHash === card.data.globalHash);
                    assert.ok(saved.vanillaData.media?.front_sound, 'lands in the sound slot');
                    assert.ok(!saved.vanillaData.media?.front_img, 'and not in the picture slot');
                } finally {
                    await call('delete_flashcard', { globalHash: card.data.globalHash });
                }
            });

            it('attach_clip_media fetches an asset still on the web on its way to the card', async () => {
                // Same change of contract as view_clip_image: an asset that is not in
                // the vault yet is saved into the clip rather than refused. The host in
                // this fixture does not resolve, so the failure that surfaces is the
                // download's, not a policy.
                const res = await call('attach_clip_media', {
                    clipPath: clipRel, href: 'https://example.test/remote.png',
                    documentPath: docRel, flashcardHash: 'whatever', position: 'front',
                });
                assert.equal(res.isError, true);
                assert.match(res.text, /could not reach|refused/i, res.text);
            });

            it('attach_clip_media still refuses an address that is not in the clip', async () => {
                // The check that keeps this from being a downloader for any URL on the
                // internet, writing into the vault under the user's own token.
                const res = await call('attach_clip_media', {
                    clipPath: clipRel, href: 'https://elsewhere.test/anything.png',
                    documentPath: docRel, flashcardHash: 'whatever', position: 'front',
                });
                assert.equal(res.isError, true);
                assert.match(res.text, /not part of this clip/i, res.text);
            });
        });

        it('read_document_text reads an EPUB section', async () => {
            const res = await call('read_document_text', { path: epubRel, index: 1 });
            assert.equal(res.isError, false, res.text);
            assert.equal(res.data.unit, 'section');
            assert.match(res.data.text, /the unit of life/);
        });

        it('read_document_text resolves a YouTube transcript moment via `at`', async () => {
            const res = await call('read_document_text', { path: ytRel, at: 100 });
            assert.equal(res.isError, false, res.text);
            assert.equal(res.data.unit, 'segment');
            assert.equal(res.data.label, '1:30', 'the block covering 100s starts at 1:30');
            assert.match(res.data.text, /CHARLIE/);
        });

        it('read_document steers a YouTube stub to read_document_text without dumping the transcript', async () => {
            const res = await call('read_document', { path: ytRel });
            assert.equal(res.isError, false, res.text);
            assert.match(res.text, /read_document_text/);
            assert.match(res.text, /transcript cues/);
            assert.ok(!res.text.includes('ALPHA'), 'the raw cue text is not dumped into read_document');
        });

        it('read_document tells you to fetch a transcript when the video has none yet', async () => {
            const res = await call('read_document', { path: bareRel });
            assert.equal(res.isError, false, res.text);
            assert.match(res.text, /fetch_youtube_transcript/);
        });

        it('read_document_text reports a scanned PDF as unreadable rather than returning noise', async () => {
            const res = await call('read_document_text', { path: scanRel });
            assert.equal(res.isError, true);
            assert.match(res.text, /415/);
        });

        it('update_document refuses to overwrite it, leaving the file intact', async () => {
            const res = await call('update_document', { path: scanRel, content: 'plain text' });
            assert.equal(res.isError, true);
            assert.match(res.text, /editable bodies/i);

            const abs = path.join(getWorkspacePath(), ROOT, 'scan.pdf');
            assert.equal(fs.statSync(abs).size, scanBytes.length, 'the PDF still has its original bytes');
        });

        it('create_highlight rejects a text-offset anchor on it', async () => {
            const res = await call('create_highlight', { path: scanRel, snippet: 'anything', color: 'amber' });
            assert.equal(res.isError, true);
            assert.match(res.text, /binary document/i);
        });
    });

    // list_cards reports *that* a card is flagged; get_card_health reports why, so an
    // assistant can disagree with the verdict instead of acting on a bare kind string.
    // The classifier itself is exercised in tests/cardHealth.test.js and over HTTP in
    // tests/api/api.test.js — here we only prove the tool reaches it and shapes the reply.
    it('get_card_health returns no flags for a healthy card', async () => {
        const created = await call('create_flashcard', { frontText: 'health probe Q', backText: 'A' });
        assert.equal(created.isError, false, created.text);

        const res = await call('get_card_health', { cardHash: created.data.globalHash });
        assert.equal(res.isError, false, res.text);
        assert.deepEqual(res.data.flags, [], 'a card that has never failed is never accused');

        await call('delete_flashcard', { globalHash: created.data.globalHash });
    });

    it('get_card_health 404s on an unknown card rather than reporting it healthy', async () => {
        const res = await call('get_card_health', { cardHash: 'no-such-card-hash' });
        assert.equal(res.isError, true);
        assert.match(res.text, /404|not found/i);
    });

    it('list_cards can sort by lapses to surface problem cards', async () => {
        const res = await call('list_cards', { sortBy: 'lapses', sortDir: 'desc', limit: 5 });
        assert.equal(res.isError, false, res.text);
        assert.ok(Array.isArray(res.data.cards));
        if (res.data.cards.length) assert.ok('lapses' in res.data.cards[0]);
    });

    // The MCP client tags requests as `mcp`, so the API's diary privacy gate applies:
    // every diary tool is refused with a 403 unless the user enables AI diary access
    // in config.json (Config → AI Assistant). The gate reads the flag fresh from disk.
    it('diary tools are refused until the user enables AI diary access', async () => {
        const cfgPath = path.join(process.cwd(), 'data', 'config.json');
        const original = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, 'utf-8') : null;
        const base = original ? JSON.parse(original) : {};

        // Disabled (default): a clean, non-crashing error mentioning it's disabled.
        fs.writeFileSync(cfgPath, JSON.stringify({ ...base, mcpDiaryAccess: false }, null, 2));
        const denied = await call('diary_list', {});
        assert.equal(denied.isError, true);
        assert.match(denied.text, /disabled/i);

        // Summaries-only: the day list and summaries are readable, but the personal
        // written entry is refused with a 403.
        fs.writeFileSync(cfgPath, JSON.stringify({ ...base, mcpDiaryAccess: 'summaries' }, null, 2));
        const summariesList = await call('diary_list', {});
        assert.equal(summariesList.isError, false, summariesList.text);
        assert.ok(Array.isArray(summariesList.data));

        const blockedEntry = await call('diary_get_entry', { date: '2022-02-02' });
        assert.equal(blockedEntry.isError, true);
        assert.match(blockedEntry.text, /403/);

        // Enabled (full): reads go through, including the written entry.
        fs.writeFileSync(cfgPath, JSON.stringify({ ...base, mcpDiaryAccess: true }, null, 2));
        try {
            const list = await call('diary_list', {});
            assert.equal(list.isError, false, list.text);
            assert.ok(Array.isArray(list.data));

            const entry = await call('diary_get_entry', { date: '2022-02-02' });
            assert.equal(entry.isError, false, entry.text);
            assert.equal(entry.data.content, '');

            const missing = await call('diary_get_summary', { date: '2022-02-02' });
            assert.equal(missing.isError, true); // no summary that day → clean 404 error
            assert.match(missing.text, /404/);
        } finally {
            if (original !== null) fs.writeFileSync(cfgPath, original);
        }
    });
});
