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
import db from '../src/api/access/database.js';
import Documents from '../src/api/access/documents.js';
import Api from '../src/api/api.js';
import { getWorkspacePath } from '../src/api/access/config.js';
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

const cardRow = (hash) => db.prepare(`
    SELECT f.global_hash, f.name, f.card_type, f.document_id, c.frontText, c.backText, c.custom_html
    FROM Flashcards f JOIN FlashcardContent c ON f.content_id = c.id
    WHERE f.global_hash = ?
`).get(hash);

const rmWorkspace = () => {
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
        if (!validate()) throw new Error('Validation failed');
        rmWorkspace();
        await sealTools.init();
        api = new Api({ port: 0, logFormat: 'tiny', apiToken: API_TOKEN });
        const server = await api.start();
        process.env.FLASHBACK_API_URL = `http://localhost:${server.address().port}`;
        process.env.FLASHBACK_API_TOKEN = API_TOKEN;
        await new Documents().createFolder(ROOT);
    });

    after(async () => {
        rmWorkspace();
        await api.stop();
    });

    it('registers the full tool set', () => {
        const expected = [
            // read
            'search_flashback', 'list_folder', 'read_document', 'get_due_cards',
            'list_decks', 'list_tags', 'list_categories', 'get_graph',
            'get_statistics', 'list_cards', 'search_content', 'get_links', 'get_recent_changes',
            // write
            'create_flashcard', 'update_flashcard', 'delete_flashcard',
            'create_document', 'update_document', 'create_folder', 'update_tags',
            'create_deck', 'update_deck', 'delete_deck', 'add_to_deck', 'remove_from_deck',
            'create_highlight', 'update_highlight', 'delete_highlight', 'attach_media',
        ];
        for (const name of expected) assert.ok(tools.has(name), `missing tool: ${name}`);
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
        const row = cardRow(anchoredHash);
        assert.ok(row?.document_id, 'card linked to a document in the DB');
    });

    it('update_flashcard without documentPath auto-resolves the card\'s document', async () => {
        const res = await call('update_flashcard', { globalHash: anchoredHash, name: 'auto-resolved edit' });
        assert.equal(res.isError, false, res.text);
        assert.equal(res.data.documentPath.replace(/\\/g, '/'), docRel, 'resolved to the right document');
        assert.equal(cardRow(anchoredHash).name, 'auto-resolved edit');
        assert.equal(cardRow(anchoredHash).frontText, 'What organelle powers the cell?', 'omitted fields untouched');
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

        const row = cardRow(anchoredHash);
        assert.equal(row.frontText, 'Which organelle is the powerhouse of the cell?', 'derived layer synced');
    });

    it('update_flashcard rejects an unknown category on the sidecar path', async () => {
        const res = await call('update_flashcard', {
            globalHash: anchoredHash, documentPath: docRel, category: 'NotARealCategory',
        });
        assert.equal(res.isError, true);
        assert.match(res.text, /Unknown category/);
    });

    it('update_flashcard errors clearly when the card is not in the given document', async () => {
        const res = await call('update_flashcard', {
            globalHash: 'no-such-card-hash', documentPath: docRel, frontText: 'x',
        });
        assert.equal(res.isError, true);
        assert.match(res.text, /read_document/);
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
        const row = cardRow(hash);
        assert.equal(row.frontText, 'Standalone Q (edited)');
        assert.equal(row.backText, 'Standalone A', 'omitted backText preserved');
        assert.equal(row.name, 'Standalone card', 'omitted name preserved');

        const del = await call('delete_flashcard', { globalHash: hash });
        assert.equal(del.isError, false, del.text);
        assert.equal(cardRow(hash), undefined);
    });

    it('standalone custom card: customHtml is editable', async () => {
        const created = await call('create_flashcard', { cardType: 'custom', customHtml: '<b>front v1</b>', name: 'Custom card' });
        assert.equal(created.isError, false, created.text);
        const hash = created.data.globalHash;
        assert.equal(cardRow(hash).custom_html, '<b>front v1</b>');

        const res = await call('update_flashcard', { globalHash: hash, customHtml: '<b>front v2</b>' });
        assert.equal(res.isError, false, res.text);
        const row = cardRow(hash);
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
        assert.equal(cardRow(anchoredHash), undefined, 'gone from DB');
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
        assert.equal(cardRow(card.data.globalHash)?.global_hash, card.data.globalHash, 'member card survives deck deletion');
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

    it('list_cards can sort by lapses to surface problem cards', async () => {
        const res = await call('list_cards', { sortBy: 'lapses', sortDir: 'desc', limit: 5 });
        assert.equal(res.isError, false, res.text);
        assert.ok(Array.isArray(res.data.cards));
        if (res.data.cards.length) assert.ok('lapses' in res.data.cards[0]);
    });
});
