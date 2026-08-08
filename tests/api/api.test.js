import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs/promises';
import fsSync from 'fs';
import AdmZip from 'adm-zip';
import validate from '../../src/api/config/validate.js';
import { sealTools } from '../../src/api/seal/seal.js';
import db from '../../src/api/access/primitives/database.js';
import cardHealth from '../../src/api/access/orchestration/cardHealth.js';
import { sequence } from '../../src/api/access/orchestration/sequencer.js';
import Api from '../../src/api/api.js';

process.env.USER_DATA_PATH = path.join(process.cwd(), 'data');

let baseUrl;
let api;

// The suite runs against a token-guarded API. `rawFetch` is the unwrapped fetch
// (captured before the before() hook wraps the global to auto-attach the token) —
// the Authentication tests use it to exercise the missing/invalid-token paths.
const API_TOKEN = 'test-api-token-0123456789abcdef';
const rawFetch = globalThis.fetch;

// ─── Helpers ────────────────────────────────────────────────────────────────

const post = (url, body) =>
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const put = (url, body) =>
    fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const del = (url, body) =>
    fetch(url, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const createFolder = (name, parentPath = '') =>
    post(`${baseUrl}/api/documents/folder`, { name, parentPath });

const createFile = (name, parentPath = '') =>
    post(`${baseUrl}/api/documents/file`, { name, parentPath });

const updateFile = (relPath, content, metadata) =>
    put(`${baseUrl}/api/documents/file`, { path: relPath, content, metadata });

const listFolder = async (relPath) => {
    const res = await fetch(`${baseUrl}/api/documents/list?path=${encodeURIComponent(relPath)}`);
    return res.json();
};

// ─── Tests ──────────────────────────────────────────────────────────────────

import { getWorkspacePath } from '../../src/api/access/primitives/config.js';

describe('Flashback API', () => {

    before(async () => {
        if (!validate()) throw new Error('Validation failed');
        db.exec(`
            PRAGMA foreign_keys = OFF;
            DELETE FROM FlashcardReference;
            DELETE FROM FlashcardContent;
            DELETE FROM Flashcards;
            DELETE FROM DocumentLinks;
            DELETE FROM Documents;
            DELETE FROM Folders;
            DELETE FROM Connections;
            DELETE FROM InheritedTags;
            DELETE FROM Tags;
            DELETE FROM ReviewLogs;
            DELETE FROM CardFlags;
            DELETE FROM CardHealth;
            DELETE FROM Media;
            -- The system deck is a singleton the schema assumes exists (migration 003
            -- seeds exactly one): it is the home every standalone card is filed into,
            -- so wiping it here made POST /api/flashcards fail with "System deck not
            -- initialised" for the whole suite. Clear the user's decks, keep that one.
            DELETE FROM Decks WHERE COALESCE(is_system, 0) = 0;
            DELETE FROM DeckEntries;
            DELETE FROM Subscriptions;
            PRAGMA foreign_keys = ON;
        `);
        const gitDir = path.join(getWorkspacePath(), '.git');
        if (fsSync.existsSync(gitDir)) {
            fsSync.rmSync(gitDir, { recursive: true, force: true });
        }
        await sealTools.init();
        api = new Api({ port: 0, logFormat: 'tiny', apiToken: API_TOKEN });
        const server = await api.start();
        baseUrl = `http://localhost:${server.address().port}`;

        // Wrap fetch once so every existing call in the suite carries the bearer
        // token; the Authentication describe below uses rawFetch for the raw paths.
        globalThis.fetch = (url, opts = {}) =>
            rawFetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${API_TOKEN}` } });
    });

    after(async () => {
        globalThis.fetch = rawFetch;
        await api.stop();
        db.close();
        await new Promise(resolve => setTimeout(resolve, 50));
        const dataPath = path.join(process.cwd(), 'data');
        if (fsSync.existsSync(dataPath)) {
            try {
                await fs.rm(dataPath, { recursive: true, force: true });
            } catch (e) {
                console.warn('Teardown warning (safe to ignore): Failed to delete data directory:', e.message);
            }
        }
    });

    // ── Root ──────────────────────────────────────────────────────────────

    it('GET / → welcome message', async () => {
        const res = await fetch(`${baseUrl}/`);
        assert.equal(res.status, 200);
    });

    it('GET /api/unknown → 404 JSON', async () => {
        const res = await fetch(`${baseUrl}/api/unknown`);
        assert.equal(res.status, 404);
        const body = await res.json();
        assert.ok(body.code === 404 || body.error);
    });

    // ── Authentication ────────────────────────────────────────────────────
    // Uses rawFetch (no auto-attached token) to probe the guard directly.

    describe('Authentication', () => {
        // Lazy — baseUrl isn't assigned until the before() hook runs, long after
        // this describe body is evaluated during collection.
        const probe = () => `${baseUrl}/api/documents/list?path=`;

        it('leaves the GET / ping open (no token required)', async () => {
            const res = await rawFetch(`${baseUrl}/`);
            assert.equal(res.status, 200);
        });

        it('rejects an /api request with no token → 401', async () => {
            const res = await rawFetch(probe());
            assert.equal(res.status, 401);
        });

        it('rejects an /api request with a wrong token → 401', async () => {
            const res = await rawFetch(probe(), { headers: { Authorization: 'Bearer not-the-token' } });
            assert.equal(res.status, 401);
        });

        it('accepts a valid Bearer token → 200', async () => {
            const res = await rawFetch(probe(), { headers: { Authorization: `Bearer ${API_TOKEN}` } });
            assert.equal(res.status, 200);
        });

        it('accepts a valid ?token= query param → 200', async () => {
            const res = await rawFetch(`${baseUrl}/api/documents/list?path=&token=${API_TOKEN}`);
            assert.equal(res.status, 200);
        });
    });

    // ── Documents ─────────────────────────────────────────────────────────

    describe('Documents', () => {
        const ROOT = 'DocsApiTest';
        const FC_HASH = 'docs-api-fc-001';

        before(async () => {
            await createFolder(ROOT);
        });

        it('POST /api/documents/folder → 201', async () => {
            const res = await createFolder('SubA', ROOT);
            assert.equal(res.status, 201);
            const body = await res.json();
            assert.equal(body.ok, true);
        });

        it('POST /api/documents/file → 201', async () => {
            const res = await createFile('note.md', ROOT);
            assert.equal(res.status, 201);
        });

        it('PUT /api/documents/file → updates content and flashcards', async () => {
            const res = await updateFile(`${ROOT}/note.md`, '# Hello API', {
                tags: ['api'],
                flashcards: [{ globalHash: FC_HASH, vanillaData: { frontText: 'Q?', backText: 'A!' } }]
            });
            assert.equal(res.status, 200);
        });

        // Only the formats with an editable renderer accept a body write; everything
        // else is a viewer in the app, so such a write can only come from outside it
        // — and bodies are not versioned by Seal, making an overwrite unrecoverable.
        it('PUT /api/documents/file → 400 for a body write to a non-editable format', async () => {
            await createFile('data.json', ROOT);
            const res = await updateFile(`${ROOT}/data.json`, '{"clobbered":true}');
            assert.equal(res.status, 400);
            const body = await res.json();
            assert.match(body.error, /editable bodies/i);
        });

        it('PUT /api/documents/file → still accepts a metadata-only write on any format', async () => {
            const res = await put(`${baseUrl}/api/documents/file`, {
                path: `${ROOT}/data.json`, metadata: { tags: ['viewer-only'] },
            });
            assert.equal(res.status, 200);
        });

        it('POST /api/documents/youtube/transcript → 400 without a path', async () => {
            const res = await post(`${baseUrl}/api/documents/youtube/transcript`, {});
            assert.equal(res.status, 400);
        });

        it('POST /api/documents/youtube/transcript → 404 for a missing document', async () => {
            const res = await post(`${baseUrl}/api/documents/youtube/transcript`, { path: `${ROOT}/nope.youtube` });
            assert.equal(res.status, 404);
        });

        it('GET /api/documents/read → returns content and metadata', async () => {
            const res = await fetch(`${baseUrl}/api/documents/read?path=${encodeURIComponent(`${ROOT}/note.md`)}`);
            assert.equal(res.status, 200);
            const body = await res.json();
            assert.equal(body.content, '# Hello API');
            assert.ok(Array.isArray(body.metadata.flashcards));
            assert.equal(body.metadata.flashcards[0].globalHash, FC_HASH);
        });

        it('GET /api/documents/list → lists folder without sidecars', async () => {
            const items = await listFolder(ROOT);
            assert.ok(Array.isArray(items));
            assert.ok(items.some(i => i.name === 'note.md' && i.type === 'file'));
            assert.ok(items.some(i => i.name === 'SubA' && i.type === 'folder'));
            assert.ok(items.every(i => !i.name.endsWith('.flashback')), 'No sidecar files should appear');
        });

        it('PUT /api/documents/metadata → updates folder metadata', async () => {
            const res = await put(`${baseUrl}/api/documents/metadata`, {
                path: `${ROOT}/SubA`,
                metadata: { tags: ['sub'] },
                isFolder: true
            });
            assert.equal(res.status, 200);
        });

        it('POST /api/documents/rename → renames file, old name gone', async () => {
            const res = await post(`${baseUrl}/api/documents/rename`, {
                path: `${ROOT}/note.md`,
                newName: 'renamed.md'
            });
            assert.equal(res.status, 200);

            const items = await listFolder(ROOT);
            assert.ok(items.some(i => i.name === 'renamed.md'), 'New name should appear');
            assert.ok(!items.some(i => i.name === 'note.md'), 'Old name should be gone');
        });

        it('POST /api/documents/copy → copy has new globalHash', async () => {
            const res = await post(`${baseUrl}/api/documents/copy`, {
                srcPath: `${ROOT}/renamed.md`,
                destPath: `${ROOT}/copy.md`
            });
            assert.equal(res.status, 200);

            const readRes = await fetch(`${baseUrl}/api/documents/read?path=${encodeURIComponent(`${ROOT}/copy.md`)}`);
            const { metadata } = await readRes.json();
            assert.notEqual(metadata.flashcards?.[0]?.globalHash, FC_HASH, 'Copied flashcard should get a new hash');
        });

        it('POST /api/documents/move → file appears at new path', async () => {
            const res = await post(`${baseUrl}/api/documents/move`, {
                srcPath: `${ROOT}/copy.md`,
                destPath: `${ROOT}/SubA/copy.md`
            });
            assert.equal(res.status, 200);

            const itemsRoot = await listFolder(ROOT);
            const itemsSub = await listFolder(`${ROOT}/SubA`);
            assert.ok(!itemsRoot.some(i => i.name === 'copy.md'), 'File should be gone from source');
            assert.ok(itemsSub.some(i => i.name === 'copy.md'), 'File should appear at destination');
        });

        it('DELETE /api/documents → removes file', async () => {
            const res = await del(`${baseUrl}/api/documents`, { path: `${ROOT}/SubA/copy.md` });
            assert.equal(res.status, 200);

            const items = await listFolder(`${ROOT}/SubA`);
            assert.ok(!items.some(i => i.name === 'copy.md'));
        });

        it('GET /api/documents/search → finds results', async () => {
            const res = await fetch(`${baseUrl}/api/documents/search?q=api`);
            assert.equal(res.status, 200);
            const results = await res.json();
            assert.ok(Array.isArray(results));
            assert.ok(results.length > 0, 'Should find something matching "api"');
        });

        it('GET /api/documents/graph → returns nodes and edges arrays', async () => {
            const res = await fetch(`${baseUrl}/api/documents/graph`);
            assert.equal(res.status, 200);
            const { nodes, edges } = await res.json();
            assert.ok(Array.isArray(nodes) && nodes.length > 0);
            assert.ok(Array.isArray(edges));
        });

        it('POST /api/documents/import → imports a plain text file', async () => {
            const form = new FormData();
            form.append('file', new Blob(['# Imported Doc\nContent here.'], { type: 'text/markdown' }), 'imported.md');
            form.append('name', 'imported.md');
            form.append('parentPath', ROOT);

            const res = await fetch(`${baseUrl}/api/documents/import`, { method: 'POST', body: form });
            assert.equal(res.status, 201);

            const items = await listFolder(ROOT);
            assert.ok(items.some(i => i.name === 'imported.md'));
        });

        it('GET /api/documents/export → streams a zip file', async () => {
            const res = await fetch(`${baseUrl}/api/documents/export?path=${encodeURIComponent(ROOT)}`);
            assert.equal(res.status, 200);
            const disposition = res.headers.get('content-disposition') ?? '';
            assert.ok(disposition.includes('.zip'), 'Response should be a zip attachment');
        });

        it('POST /api/documents/folder → 400 when name is missing', async () => {
            const res = await post(`${baseUrl}/api/documents/folder`, {});
            assert.equal(res.status, 400);
        });

        it('GET /api/documents/search → 400 when q is missing', async () => {
            const res = await fetch(`${baseUrl}/api/documents/search`);
            assert.equal(res.status, 400);
        });

        it('GET /api/documents/read → blocks path traversal attempt', async () => {
            const res = await fetch(`${baseUrl}/api/documents/read?path=${encodeURIComponent('../../etc/passwd')}`);
            assert.notEqual(res.status, 200, 'Path traversal must not return 200');
        });

        it('GET /api/documents/read → 4xx for non-existent file', async () => {
            const res = await fetch(`${baseUrl}/api/documents/read?path=${encodeURIComponent(`${ROOT}/ghost.md`)}`);
            assert.ok(res.status >= 400 && res.status < 600, 'Reading a missing file should return an error status');
        });

        it('GET /api/documents/tags → returns array that includes previously applied tags', async () => {
            const res = await fetch(`${baseUrl}/api/documents/tags`);
            assert.equal(res.status, 200);
            const body = await res.json();
            assert.ok(Array.isArray(body.tags), 'tags field should be an array');
            assert.ok(body.tags.includes('api'), 'Tag "api" was applied earlier and must appear');
        });

        it('GET /api/documents/list → each entry carries a numeric flashcardCount', async () => {
            const items = await listFolder(ROOT);
            assert.ok(items.length > 0, 'Folder must not be empty');
            for (const item of items) {
                assert.ok(typeof item.flashcardCount === 'number',
                    `${item.name} (${item.type}) must have a numeric flashcardCount`);
            }
            const renamedFile = items.find(i => i.name === 'renamed.md');
            assert.ok(renamedFile?.flashcardCount >= 1,
                'renamed.md has one flashcard and must report flashcardCount ≥ 1');
        });

        it('POST /api/documents/folder → 409 when folder already exists', async () => {
            // SubA was created in the before() hook
            const res = await createFolder('SubA', ROOT);
            assert.equal(res.status, 409);
        });

        it('POST /api/documents/file → 409 when file already exists', async () => {
            // renamed.md exists from the rename test
            const res = await createFile('renamed.md', ROOT);
            assert.equal(res.status, 409);
        });

        it('POST /api/documents/rename → renames a folder and cascades inner paths', async () => {
            await createFolder('ToRename', ROOT);
            await createFile('inner.md', `${ROOT}/ToRename`);

            const res = await post(`${baseUrl}/api/documents/rename`, {
                path: `${ROOT}/ToRename`,
                newName: 'RenamedFolder',
                isFolder: true
            });
            assert.equal(res.status, 200);

            const items = await listFolder(ROOT);
            assert.ok(items.some(i => i.name === 'RenamedFolder' && i.type === 'folder'),
                'Renamed folder should appear under the new name');
            assert.ok(!items.some(i => i.name === 'ToRename'),
                'Old folder name should be gone');

            const innerItems = await listFolder(`${ROOT}/RenamedFolder`);
            assert.ok(innerItems.some(i => i.name === 'inner.md'),
                'Inner file should be accessible at the new path');
        });

        it('DELETE /api/documents → removes a folder and all its contents', async () => {
            await createFolder('ToDelete', ROOT);
            await createFile('child.md', `${ROOT}/ToDelete`);

            const res = await del(`${baseUrl}/api/documents`, { path: `${ROOT}/ToDelete`, isFolder: true });
            assert.equal(res.status, 200);

            const items = await listFolder(ROOT);
            assert.ok(!items.some(i => i.name === 'ToDelete'),
                'Deleted folder must not appear in listing');
        });

        it('POST /api/documents/copy → copies a folder tree, inner file accessible at destination', async () => {
            await createFolder('ToCopy', ROOT);
            await createFile('orig.md', `${ROOT}/ToCopy`);

            const res = await post(`${baseUrl}/api/documents/copy`, {
                srcPath: `${ROOT}/ToCopy`,
                destPath: `${ROOT}/CopiedFolder`,
                isFolder: true
            });
            assert.equal(res.status, 200);

            const items = await listFolder(ROOT);
            assert.ok(items.some(i => i.name === 'CopiedFolder'),
                'Copied folder should appear at the destination');

            const innerItems = await listFolder(`${ROOT}/CopiedFolder`);
            assert.ok(innerItems.some(i => i.name === 'orig.md'),
                'Copied folder should contain the inner file');
        });

        it('DELETE /api/documents → 400 when path is missing', async () => {
            const res = await del(`${baseUrl}/api/documents`, {});
            assert.equal(res.status, 400);
        });

        it('POST /api/documents/move → 400 when destPath is missing', async () => {
            const res = await post(`${baseUrl}/api/documents/move`, { srcPath: `${ROOT}/renamed.md` });
            assert.equal(res.status, 400);
        });

        it('POST /api/documents/rename → 400 when newName is missing', async () => {
            const res = await post(`${baseUrl}/api/documents/rename`, { path: `${ROOT}/renamed.md` });
            assert.equal(res.status, 400);
        });

        it('POST /api/documents/import/zip → 201, folder tree lands in workspace', async () => {
            const zip = new AdmZip();
            const folder = 'ZipImportFolder';
            zip.addFile(`${folder}/.flashback`, Buffer.from(JSON.stringify({ globalHash: 'zip-root-hash' })));
            zip.addFile(`${folder}/note.md`, Buffer.from('# Zip note'));
            zip.addFile(`${folder}/note.md.flashback`, Buffer.from(JSON.stringify({
                globalHash: 'zip-note-hash',
                flashcards: [{ globalHash: 'zip-card-001', vanillaData: { frontText: 'Zip Q', backText: 'Zip A' } }]
            })));
            const form = new FormData();
            form.append('file', new Blob([zip.toBuffer()], { type: 'application/zip' }), 'pkg.zip');
            form.append('targetPath', ROOT);

            const res = await fetch(`${baseUrl}/api/documents/import/zip`, { method: 'POST', body: form });
            assert.equal(res.status, 201);

            const innerItems = await listFolder(`${ROOT}/${folder}`);
            assert.ok(innerItems.some(i => i.name === 'note.md'),
                'Zip-imported note should appear inside the extracted folder');
        });

        it('POST /api/documents/import/zip → 400 when no file is attached', async () => {
            const form = new FormData();
            const res = await fetch(`${baseUrl}/api/documents/import/zip`, { method: 'POST', body: form });
            assert.equal(res.status, 400);
        });

        it('POST /api/documents/import/zip (Obsidian) → auto-detects and imports Obsidian vault', async () => {
            const zip = new AdmZip();
            zip.addFile('ObsidianNote.md', Buffer.from('# Obsidian Note\nHello world.\nQuestion :: Answer'));
            const form = new FormData();
            form.append('file', new Blob([zip.toBuffer()], { type: 'application/zip' }), 'obsidian.zip');
            form.append('targetPath', ROOT);

            const res = await fetch(`${baseUrl}/api/documents/import/zip`, { method: 'POST', body: form });
            assert.equal(res.status, 201);

            const data = await res.json();
            assert.ok(data.path.includes('Obsidian_Import_'));
            
            const innerItems = await listFolder(data.path);
            assert.ok(innerItems.some(i => i.name === 'ObsidianNote.md'), 'Obsidian imported note should exist');
        });
    });

    // ── Media ──────────────────────────────────────────────────────────────

    describe('Media', () => {
        const ROOT = 'MediaApiTest';
        const DOC = 'media-doc.md';
        const DOC_PATH = `${ROOT}/${DOC}`;
        const FC_HASH = 'media-api-fc-001';
        let customMediaHash = null;

        before(async () => {
            await createFolder(ROOT);
            await createFile(DOC, ROOT);
            await updateFile(DOC_PATH, '# Media', {
                flashcards: [{ globalHash: FC_HASH, vanillaData: { frontText: 'Q', backText: 'A' } }]
            });
        });

        it('POST /api/media/vanilla → 201, sidecar reference set', async () => {
            const form = new FormData();
            form.append('file', new Blob([Buffer.from('fake-audio')], { type: 'audio/mpeg' }), 'narration.mp3');
            form.append('docPath', DOC_PATH);
            form.append('flashcardHash', FC_HASH);
            form.append('name', 'narration.mp3');
            form.append('type', 'sound');
            form.append('position', 'front');

            const res = await fetch(`${baseUrl}/api/media/vanilla`, { method: 'POST', body: form });
            assert.equal(res.status, 201);

            const readRes = await fetch(`${baseUrl}/api/documents/read?path=${encodeURIComponent(DOC_PATH)}`);
            const { metadata } = await readRes.json();
            assert.equal(metadata.flashcards[0].vanillaData.media.front_sound, './media/narration.mp3');
        });

        it('POST /api/media/custom → 201, customData reference set', async () => {
            const form = new FormData();
            form.append('file', new Blob([Buffer.from('fake-png')], { type: 'image/png' }), 'diagram.png');
            form.append('docPath', DOC_PATH);
            form.append('flashcardHash', FC_HASH);
            form.append('name', 'diagram.png');

            const res = await fetch(`${baseUrl}/api/media/custom`, { method: 'POST', body: form });
            assert.equal(res.status, 201);

            const readRes = await fetch(`${baseUrl}/api/documents/read?path=${encodeURIComponent(DOC_PATH)}`);
            const { metadata } = await readRes.json();
            assert.ok(metadata.flashcards[0].customData?.media?.diagram);
        });

        it('GET /api/media/list → includes both media files with hash info', async () => {
            const res = await fetch(`${baseUrl}/api/media/list?path=${encodeURIComponent(ROOT)}`);
            assert.equal(res.status, 200);
            const items = await res.json();

            assert.ok(items.some(i => i.name === 'narration.mp3'), 'Should list vanilla audio');
            assert.ok(items.some(i => i.name === 'diagram.png'), 'Should list custom image');

            const diagram = items.find(i => i.name === 'diagram.png');
            assert.ok(diagram.hash !== null, 'DB-registered file should have a non-null hash');
            customMediaHash = diagram.hash;
        });

        it('GET /api/media?hash= → streams the file', async () => {
            assert.ok(customMediaHash, 'Precondition: hash captured from list test');
            const res = await fetch(`${baseUrl}/api/media?hash=${customMediaHash}`);
            assert.equal(res.status, 200);
            const buf = await res.arrayBuffer();
            assert.ok(buf.byteLength > 0, 'Response body should contain file data');
        });

        it('GET /api/media?hash= → 404 for unknown hash', async () => {
            const res = await fetch(`${baseUrl}/api/media?hash=${'0'.repeat(64)}`);
            assert.equal(res.status, 404);
        });

        it('GET /api/media → 400 when hash is missing', async () => {
            const res = await fetch(`${baseUrl}/api/media`);
            assert.equal(res.status, 400);
        });

        it('DELETE /api/media → 200, file gone from list', async () => {
            const res = await del(`${baseUrl}/api/media`, { docPath: DOC_PATH, mediaName: 'diagram.png' });
            assert.equal(res.status, 200);

            const listRes = await fetch(`${baseUrl}/api/media/list?path=${encodeURIComponent(ROOT)}`);
            const items = await listRes.json();
            assert.ok(!items.some(i => i.name === 'diagram.png'), 'diagram.png should be removed');
        });

        it('POST /api/media/reconcile → returns removed count', async () => {
            const res = await post(`${baseUrl}/api/media/reconcile`, { folderPath: ROOT });
            assert.equal(res.status, 200);
            const body = await res.json();
            assert.ok(typeof body.removed === 'number');
            assert.ok(Array.isArray(body.orphans));
        });
    });

    // ── SRS ───────────────────────────────────────────────────────────────

    describe('SRS', () => {
        const ROOT = 'SrsApiTest';
        const DOC = 'srs-doc.md';
        const FC_HASH = 'srs-api-fc-001';

        before(async () => {
            await createFolder(ROOT);
            await createFile(DOC, ROOT);
            await updateFile(`${ROOT}/${DOC}`, '# SRS', {
                flashcards: [{ globalHash: FC_HASH, vanillaData: { frontText: 'Front', backText: 'Back' } }]
            });
        });

        it('GET /api/srs/stats → returns boxes array and total', async () => {
            const res = await fetch(`${baseUrl}/api/srs/stats`);
            assert.equal(res.status, 200);
            const { boxes, total } = await res.json();
            assert.ok(Array.isArray(boxes));
            assert.ok(typeof total === 'number');
        });

        it('POST /api/srs/review → 200, level reflected in stats', async () => {
            const res = await post(`${baseUrl}/api/srs/review`, {
                path: `${ROOT}/${DOC}`,
                flashcardHash: FC_HASH,
                outcome: 1,
                easeFactor: 2.5,
                newLevel: 3
            });
            assert.equal(res.status, 200);

            // The card is now at level 3; stats should show it in that box
            const statsRes = await fetch(`${baseUrl}/api/srs/stats`);
            const { boxes } = await statsRes.json();
            const box3 = boxes.find(b => b.level === 3);
            assert.ok(box3 && box3.count >= 1, 'Level-3 box should contain the reviewed card');
        });

        it('POST /api/srs/review → 400 when fields are missing', async () => {
            const res = await post(`${baseUrl}/api/srs/review`, { path: `${ROOT}/${DOC}` });
            assert.equal(res.status, 400);
        });

        it('POST /api/srs/review → session ordering context is optional', async () => {
            // Every non-trainer caller (MCP, scripts, the Flashcards view) omits it, and a
            // review must still be graded and logged without any ordering context at all.
            const res = await post(`${baseUrl}/api/srs/review`, {
                path: `${ROOT}/${DOC}`,
                flashcardHash: FC_HASH,
                outcome: 1,
                easeFactor: 2.5,
                newLevel: 2,
            });
            assert.equal(res.status, 200);
            const body = await res.json();
            assert.equal(body.ok, true);
        });

        it('POST /api/srs/review → accepts a session and records ordering telemetry', async () => {
            const dueRes = await fetch(`${baseUrl}/api/srs/due`);
            const { sessionId, queue } = await dueRes.json();
            assert.ok(sessionId, '/due must issue a sessionId');
            assert.ok(queue.length >= 2, 'need at least two cards to measure a distance');

            // Grade two cards in sequence, reporting what was actually shown before each.
            const first = queue[0];
            const second = queue[1];

            const r1 = await post(`${baseUrl}/api/srs/review`, {
                path: first.document_path ? `${first.document_path}` : undefined,
                flashcardHash: first.global_hash,
                outcome: 1, easeFactor: 2.5, newLevel: 2,
                sessionId, sessionPosition: 0, prevCardHash: null,
            });
            assert.equal(r1.status, 200);

            const r2 = await post(`${baseUrl}/api/srs/review`, {
                path: second.document_path ? `${second.document_path}` : undefined,
                flashcardHash: second.global_hash,
                outcome: 1, easeFactor: 2.5, newLevel: 2,
                sessionId, sessionPosition: 1, prevCardHash: first.global_hash,
            });
            assert.equal(r2.status, 200);

            // The columns must actually be written — the whole point of the migration is
            // being able to tell an interleaving dip apart from a regression later.
            const rows = db.prepare(
                'SELECT session_position, prev_distance FROM ReviewLogs WHERE session_id = ? ORDER BY session_position ASC',
            ).all(sessionId);

            assert.equal(rows.length, 2, 'both reviews should carry the session id');
            assert.equal(rows[0].session_position, 0);
            assert.equal(rows[0].prev_distance, null, 'first card of a session has nothing before it');
            assert.equal(rows[1].session_position, 1);
            assert.ok(
                typeof rows[1].prev_distance === 'number' && rows[1].prev_distance >= 1,
                'second card must record a distance to the card actually shown before it',
            );
        });

        it('GET /api/srs/due → returns an ordered queue and a reproducible seed', async () => {
            const res = await fetch(`${baseUrl}/api/srs/due?seed=1234`);
            assert.equal(res.status, 200);
            const body = await res.json();

            assert.ok(Array.isArray(body.queue), 'queue should be an array');
            assert.equal(body.queue.length, body.due.length + body.new.length,
                'queue must hold every due and new card exactly once');
            assert.ok(['none', 'no-folder-edge', 'short-lag', 'shuffle'].includes(body.relaxation),
                `unexpected relaxation: ${body.relaxation}`);

            // Same seed, same order — this is what makes a reported session reproducible.
            const again = await (await fetch(`${baseUrl}/api/srs/due?seed=1234`)).json();
            assert.deepEqual(
                again.queue.map(c => c.global_hash),
                body.queue.map(c => c.global_hash),
            );
        });

        it('GET /api/srs/due → folder/tag scoping reaches the sequenced queue, not just due/new', async () => {
            // The Trainer studies `queue` now, not `due` + `new`. Selection runs entirely
            // upstream of the sequencer, which may only permute what it is handed — but
            // "may only" is an invariant, not a guarantee, so pin it: a filter that reached
            // due/new while the queue carried something else would quietly put out-of-scope
            // cards in front of the user, and every existing scoping test would still pass.
            const SCOPE_ROOT = 'SrsScopeTest';
            const SCOPE_TAG = 'srs-scope-tag';
            const SCOPE_HASH = 'srs-scope-fc-001';
            const pastRecall = new Date(Date.now() - 10 * 24 * 3_600_000).toISOString();

            await createFolder(SCOPE_ROOT);
            await createFile('scoped.md', SCOPE_ROOT);
            await updateFile(`${SCOPE_ROOT}/scoped.md`, '# Scoped', {
                flashcards: [
                    { globalHash: SCOPE_HASH, level: 1, lastRecall: pastRecall,
                      vanillaData: { frontText: 'Scoped', backText: 'Card' } },
                ],
            });
            // Tag in a second write, once the card exists. Inheritance is materialized into
            // InheritedTags when the tag is applied, so tagging a document in the same write
            // that introduces its cards leaves them with an empty inherited set.
            await put(`${baseUrl}/api/documents/file`, {
                path: `${SCOPE_ROOT}/scoped.md`, metadata: { tags: [SCOPE_TAG] },
            });

            const fetchScoped = async (qs) => {
                const res = await fetch(`${baseUrl}/api/srs/due?${qs}`);
                assert.equal(res.status, 200, `?${qs} should succeed`);
                const body = await res.json();
                const selected = [...body.due, ...body.new].map(c => c.global_hash).sort();
                const queued = body.queue.map(c => c.global_hash).sort();
                assert.deepEqual(queued, selected,
                    `queue must hold exactly the selected set for ?${qs}`);
                return queued;
            };

            // Every order mode, because each takes a different path through sequence().
            for (const order of ['interleaved', 'shuffle', 'priority']) {
                const inScope = await fetchScoped(`folder=${encodeURIComponent(SCOPE_ROOT)}&order=${order}`);
                assert.ok(inScope.includes(SCOPE_HASH),
                    `${order}: folder-scoped queue must contain the folder's own card`);
                assert.ok(!inScope.includes(FC_HASH),
                    `${order}: folder-scoped queue must not leak a card from ${ROOT}`);
            }

            // Tagging the document above created the Tags row and the document→card
            // inheritance edge; materializing InheritedTags across that edge belongs to the
            // tag subsystem (tests/tags.test.js). What this test pins is the *filter*: a card
            // whose tag is inherited rather than applied directly must still be selectable by
            // that tag. That is not an edge case — in a real vault it is the normal shape,
            // because tags get applied to folders, documents and decks, not to single cards.
            // So the inherited row is written here directly, at the derived layer the filter
            // actually reads.
            const tagRow = db.prepare('SELECT id FROM Tags WHERE name = ?').get(SCOPE_TAG);
            const cardNode = db.prepare('SELECT node_id FROM Flashcards WHERE global_hash = ?').get(SCOPE_HASH);
            assert.ok(tagRow && cardNode?.node_id, 'precondition: tagged document and its card exist');
            const inheritEdge = db.prepare(`
                SELECT id FROM Connections
                WHERE destiny_id = ?
                  AND type_id = (SELECT id FROM ConnectionTypes WHERE name = 'inheritance')
            `).get(cardNode.node_id);
            assert.ok(inheritEdge, 'precondition: the card inherits from its document');
            db.prepare('INSERT INTO InheritedTags (connection_id, tag_id) VALUES (?, ?)')
                .run(inheritEdge.id, tagRow.id);

            const tagged = await fetchScoped(`tag=${encodeURIComponent(SCOPE_TAG)}`);
            assert.ok(tagged.includes(SCOPE_HASH), 'tag-scoped queue must contain the tagged card');
            assert.ok(!tagged.includes(FC_HASH), 'tag-scoped queue must not leak an untagged card');
        });

        // Regression: getDue() hands the sequencer raw DB rows, which name the column
        // `category_priority`; the ordering engine reads `categoryPriority`. When that seam
        // isn't normalized every card reads as priority 0, the whole session collapses into
        // one tier, and an Exercise can be presented before the Definition it builds on —
        // silently, because the queue still contains every card exactly once.
        const tierFixture = () => Array.from({ length: 12 }, (_, i) => ({
            global_hash: `tier-card-${i}`,
            category_priority: i % 3,   // 0,1,2,0,1,2,… — deliberately not pre-sorted
            level: 5,
        }));
        const isNonDecreasing = (xs) => xs.every((x, i) => i === 0 || xs[i - 1] <= x);

        for (const order of ['interleaved', 'shuffle']) {
            it(`sequencer.sequence(order=${order}) → keeps pedagogical tiers in priority order`, () => {
                const { queue } = sequence({ due: tierFixture(), order, seed: 7 });
                const priorities = queue.map(c => c.category_priority);
                assert.equal(queue.length, 12, 'every card must survive sequencing');
                assert.ok(
                    isNonDecreasing(priorities),
                    `tiers must stay ordered (foundational first), got ${priorities.join(',')}`,
                );
            });
        }

        it('GET /api/srs/due?order=priority → opts back out of sequencing', async () => {
            const body = await (await fetch(`${baseUrl}/api/srs/due?order=priority`)).json();
            assert.equal(body.order, 'priority');
            // Priority order is due-then-new, unsequenced.
            assert.deepEqual(
                body.queue.map(c => c.global_hash),
                [...body.due, ...body.new].map(c => c.global_hash),
            );
        });

        it('GET /api/srs/due → returns due and new card lists with card_type', async () => {
            const DUE_DOC = 'due-test.md';
            const DUE_HASH = 'srs-due-cloze-001';
            const NEW_HASH = 'srs-new-type-answer-001';
            // 10 days ago — well past level-1 Leitner interval (1 day)
            const pastRecall = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();

            await createFile(DUE_DOC, ROOT);
            await updateFile(`${ROOT}/${DUE_DOC}`, '# Due Test', {
                flashcards: [
                    { globalHash: DUE_HASH, cardType: 'cloze', level: 1, lastRecall: pastRecall,
                      vanillaData: { frontText: 'The {{sun}} is a star.', backText: 'The {{sun}} is a star.' } },
                    { globalHash: NEW_HASH, cardType: 'type_answer',
                      vanillaData: { frontText: 'Capital of France?', backText: 'Paris' } },
                ]
            });

            const res = await fetch(`${baseUrl}/api/srs/due`);
            assert.equal(res.status, 200);
            const body = await res.json();

            assert.ok(Array.isArray(body.due), 'due should be an array');
            assert.ok(Array.isArray(body.new), 'new should be an array');

            const dueCard = body.due.find(c => c.global_hash === DUE_HASH);
            assert.ok(dueCard, 'cloze card with recall 10 days ago at level 1 should appear in due');
            assert.equal(dueCard.card_type, 'cloze', 'due card should carry card_type');
            assert.ok(dueCard.frontText, 'due card should include frontText');

            const newCard = body.new.find(c => c.global_hash === NEW_HASH);
            assert.ok(newCard, 'card without lastRecall should appear in newCards');
            assert.equal(newCard.card_type, 'type_answer', 'new card should carry card_type');
        });

        it('GET /api/srs/due → Leitner boundary: level-1 card 23 h old not due, 25 h old is due', async () => {
            const CARD_TOO_SOON = 'srs-leitner-boundary-23h';
            const CARD_OVERDUE  = 'srs-leitner-boundary-25h';
            // Level-1 Leitner interval = 2^(1-1) = 1 day
            const twentyThreeHoursAgo = new Date(Date.now() - 23 * 3_600_000).toISOString();
            const twentyFiveHoursAgo  = new Date(Date.now() - 25 * 3_600_000).toISOString();

            await createFile('leitner-boundary.md', ROOT);
            await updateFile(`${ROOT}/leitner-boundary.md`, '# Leitner Boundary', {
                flashcards: [
                    { globalHash: CARD_TOO_SOON, level: 1, lastRecall: twentyThreeHoursAgo,
                      vanillaData: { frontText: 'Too soon', backText: 'A' } },
                    { globalHash: CARD_OVERDUE,  level: 1, lastRecall: twentyFiveHoursAgo,
                      vanillaData: { frontText: 'Overdue',  backText: 'B' } },
                ]
            });

            const res = await fetch(`${baseUrl}/api/srs/due?folder=${encodeURIComponent(ROOT)}`);
            assert.equal(res.status, 200);
            const body = await res.json();

            const dueHashes = body.due.map(c => c.global_hash);
            assert.ok(!dueHashes.includes(CARD_TOO_SOON),
                'Level-1 card recalled 23 h ago must NOT be due (1-day Leitner interval)');
            assert.ok(dueHashes.includes(CARD_OVERDUE),
                'Level-1 card recalled 25 h ago must be due (past 1-day Leitner interval)');
        });

        it('GET /api/srs/due → SM-2 level-2 interval is 6 days, Leitner level-2 is 2 days', async () => {
            const SM2_HASH = 'srs-sm2-level2-boundary';
            // 5 days ago: past Leitner interval (2 d) but before SM-2 interval (6 d)
            const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000).toISOString();

            await createFile('sm2-level2.md', ROOT);
            await updateFile(`${ROOT}/sm2-level2.md`, '# SM-2 Level 2', {
                flashcards: [{
                    globalHash: SM2_HASH,
                    level: 2,
                    sm2Reps: 2,
                    lastRecall: fiveDaysAgo,
                    vanillaData: { frontText: 'SM-2 Q', backText: 'SM-2 A' }
                }]
            });

            const leitnerRes = await fetch(`${baseUrl}/api/srs/due?folder=${encodeURIComponent(ROOT)}`);
            const leitnerBody = await leitnerRes.json();
            assert.ok(leitnerBody.due.some(c => c.global_hash === SM2_HASH),
                'Under Leitner, level-2 card recalled 5 days ago (2-day interval) must be due');

            const sm2Res = await fetch(`${baseUrl}/api/srs/due?algorithm=sm2&folder=${encodeURIComponent(ROOT)}`);
            const sm2Body = await sm2Res.json();
            assert.ok(!sm2Body.due.some(c => c.global_hash === SM2_HASH),
                'Under SM-2, level-2 card recalled 5 days ago (6-day interval) must NOT be due');
        });

        it('GET /api/srs/due → nextDue reflects the nearest future schedule', async () => {
            // After inserting a card recalled 23 h ago (not yet due), nextDue must be non-null
            // for the folder-scoped query — the 23-hour card is the next upcoming card.
            const res = await fetch(`${baseUrl}/api/srs/due?folder=${encodeURIComponent(ROOT)}`);
            assert.equal(res.status, 200);
            const body = await res.json();
            assert.ok('nextDue' in body, 'Response must include a nextDue field');
            assert.notEqual(body.nextDue, undefined, 'nextDue must not be undefined');
            assert.ok(body.nextDue !== null,
                'nextDue must be non-null when a card has a future due date (23-hour card)');
        });
    });

    // ── SRS Algorithm Migration ───────────────────────────────────────────

    describe('SRS Algorithm Migration', () => {
        const ROOT = 'MigrateApiTest';

        before(async () => { await createFolder(ROOT); });

        it('POST /api/srs/migrate → 400 when from equals to', async () => {
            const res = await post(`${baseUrl}/api/srs/migrate`, { from: 'leitner', to: 'leitner' });
            assert.equal(res.status, 400);
        });

        it('POST /api/srs/migrate → 400 when from/to are missing', async () => {
            const res = await post(`${baseUrl}/api/srs/migrate`, { from: 'leitner' });
            assert.equal(res.status, 400);
        });

        it('POST /api/srs/migrate → Leitner level 5 translates to SM-2 reps 3 (nearest 15-day interval)', async () => {
            // level 5 = Leitner interval 16 d.  Nearest SM-2 value: reps=3 → 15 d.
            // Recalled 10 days ago → NOT due under either schedule (10 < 15 and 10 < 16).
            const HASH = 'migrate-l5-to-sm2';
            const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();

            await createFile('l-to-sm2.md', ROOT);
            await updateFile(`${ROOT}/l-to-sm2.md`, '# L→SM2', {
                flashcards: [{
                    globalHash: HASH,
                    level: 5,
                    lastRecall: tenDaysAgo,
                    vanillaData: { frontText: 'Q', backText: 'A' }
                }]
            });

            // Sanity-check: NOT due under Leitner before migration (10 d < 16 d interval).
            const preRes = await fetch(`${baseUrl}/api/srs/due?algorithm=leitner&folder=${encodeURIComponent(ROOT)}`);
            const preDue = (await preRes.json()).due.map(c => c.global_hash);
            assert.ok(!preDue.includes(HASH), 'level-5 card recalled 10 d ago must NOT be due under Leitner pre-migration');

            const migrateRes = await post(`${baseUrl}/api/srs/migrate`, { from: 'leitner', to: 'sm2' });
            assert.equal(migrateRes.status, 200);
            const { ok, count } = await migrateRes.json();
            assert.ok(ok);
            assert.ok(count >= 1, 'at least one card should be migrated');

            // After migration: sm2_reps should be 3 (15-day interval).
            // Card recalled 10 d ago → NOT due under SM-2 (10 < 15).
            const postRes = await fetch(`${baseUrl}/api/srs/due?algorithm=sm2&folder=${encodeURIComponent(ROOT)}`);
            const postDue = (await postRes.json()).due.map(c => c.global_hash);
            assert.ok(!postDue.includes(HASH),
                'after Leitner→SM-2 migration, level-5 card recalled 10 d ago should NOT be due (sm2_reps=3, 15-day interval)');
        });

        it('POST /api/srs/migrate → SM-2 reps 3 translates to Leitner level 5 (nearest 16-day interval)', async () => {
            // sm2_reps=3 → SM-2 interval 15 d.  Nearest Leitner value: level=5 → 16 d.
            // Before migration: level defaults to 0 (0-day interval) → always due under Leitner.
            // After migration: level=5 → 16 d interval, card recalled 10 d ago → NOT due.
            const HASH = 'migrate-sm2r3-to-l5';
            const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();

            await createFile('sm2-to-l.md', ROOT);
            await updateFile(`${ROOT}/sm2-to-l.md`, '# SM2→L', {
                flashcards: [{
                    globalHash: HASH,
                    sm2Reps: 3,
                    lastRecall: tenDaysAgo,
                    vanillaData: { frontText: 'Q2', backText: 'A2' }
                }]
            });

            // Sanity-check: level defaults to 0 → 0-day interval → due immediately under Leitner.
            const preRes = await fetch(`${baseUrl}/api/srs/due?algorithm=leitner&folder=${encodeURIComponent(ROOT)}`);
            const preDue = (await preRes.json()).due.map(c => c.global_hash);
            assert.ok(preDue.includes(HASH), 'level-0 card with lastRecall must be due under Leitner before migration');

            const migrateRes = await post(`${baseUrl}/api/srs/migrate`, { from: 'sm2', to: 'leitner' });
            assert.equal(migrateRes.status, 200);
            const { ok, count } = await migrateRes.json();
            assert.ok(ok);
            assert.ok(count >= 1);

            // After migration: level=5 (nearest to 15-day SM-2 interval).
            // Card recalled 10 d ago → NOT due under Leitner (10 < 16).
            const postRes = await fetch(`${baseUrl}/api/srs/due?algorithm=leitner&folder=${encodeURIComponent(ROOT)}`);
            const postDue = (await postRes.json()).due.map(c => c.global_hash);
            assert.ok(!postDue.includes(HASH),
                'after SM-2→Leitner migration, sm2_reps-3 card recalled 10 d ago should NOT be due (level=5, 16-day interval)');
        });
    });

    // ── Highlights ────────────────────────────────────────────────────────

    describe('Highlights', () => {
        const ROOT = 'HighlightApiTest';
        const FILE = `${ROOT}/hl-doc.md`;
        let hlHash;

        before(async () => {
            await createFolder(ROOT);
            await createFile('hl-doc.md', ROOT);
        });

        it('GET /api/highlights → empty array before any highlights', async () => {
            const res = await fetch(`${baseUrl}/api/highlights?path=${encodeURIComponent(FILE)}`);
            assert.equal(res.status, 200);
            const { highlights } = await res.json();
            assert.ok(Array.isArray(highlights));
            assert.equal(highlights.length, 0);
        });

        it('POST /api/highlights → 400 when path missing', async () => {
            const res = await post(`${baseUrl}/api/highlights`, { type: 'text_offset', start: 0, end: 10, color: 'amber' });
            assert.equal(res.status, 400);
        });

        it('POST /api/highlights → 201 with created highlight', async () => {
            const res = await post(`${baseUrl}/api/highlights`, {
                path: FILE,
                type: 'text_offset',
                start: 5,
                end: 20,
                color: 'amber',
                note: 'important',
            });
            assert.equal(res.status, 201);
            const { ok, highlight } = await res.json();
            assert.ok(ok);
            assert.ok(highlight.id, 'highlight must have an id');
            assert.equal(highlight.type, 'text_offset');
            assert.equal(highlight.start, 5);
            assert.equal(highlight.end, 20);
            assert.equal(highlight.color, 'amber');
            assert.equal(highlight.note, 'important');
            hlHash = highlight.id;
        });

        it('GET /api/highlights → returns the created highlight', async () => {
            const res = await fetch(`${baseUrl}/api/highlights?path=${encodeURIComponent(FILE)}`);
            const { highlights } = await res.json();
            assert.equal(highlights.length, 1);
            assert.equal(highlights[0].id, hlHash);
        });

        it('PUT /api/highlights/:hash → updates color and note', async () => {
            const res = await fetch(`${baseUrl}/api/highlights/${hlHash}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: FILE, color: 'blue', note: 'revised' }),
            });
            assert.equal(res.status, 200);
            const { ok, highlight } = await res.json();
            assert.ok(ok);
            assert.equal(highlight.color, 'blue');
            assert.equal(highlight.note, 'revised');
        });

        it('GET /api/highlights → reflects updated fields', async () => {
            const res = await fetch(`${baseUrl}/api/highlights?path=${encodeURIComponent(FILE)}`);
            const { highlights } = await res.json();
            assert.equal(highlights[0].color, 'blue');
            assert.equal(highlights[0].note, 'revised');
        });

        it('DELETE /api/highlights/:hash → removes the highlight', async () => {
            const res = await fetch(`${baseUrl}/api/highlights/${hlHash}?path=${encodeURIComponent(FILE)}`, {
                method: 'DELETE',
            });
            assert.equal(res.status, 200);
            const { ok } = await res.json();
            assert.ok(ok);
        });

        it('GET /api/highlights → empty after deletion', async () => {
            const res = await fetch(`${baseUrl}/api/highlights?path=${encodeURIComponent(FILE)}`);
            const { highlights } = await res.json();
            assert.equal(highlights.length, 0);
        });
    });

    // ── Annotated highlights & card provenance ────────────────────────────
    // The highlight→card workflow surface: /api/highlights/annotated (text +
    // context + card linkage) and the flashcard `origin` provenance marker
    // ('ai' = AI-created, NULL = handmade) with its /api/decks/cards filter.

    describe('Annotated highlights & card provenance', () => {
        const ROOT = 'AnnotatedHlTest';
        const FILE = `${ROOT}/cells.md`;
        const BODY = 'The mitochondria is the powerhouse of the cell. Ribosomes synthesize proteins from amino acids.';
        const HAND_HASH = 'annotated-hand-fc-001';
        let hlCarded, hlUncarded, aiCardHash;

        before(async () => {
            await createFolder(ROOT);
            await createFile('cells.md', ROOT);
            // Body + one handmade card (no origin field) in a single sidecar write.
            await updateFile(FILE, BODY, {
                flashcards: [{ globalHash: HAND_HASH, vanillaData: { frontText: 'Handmade Q', backText: 'Handmade A' } }],
            });
        });

        it('POST /api/highlights persists the text snapshot', async () => {
            const s1 = BODY.indexOf('mitochondria');
            const e1 = BODY.indexOf('cell.') + 'cell.'.length;
            const res1 = await post(`${baseUrl}/api/highlights`, {
                path: FILE, type: 'text_offset', start: s1, end: e1, color: 'amber', text: BODY.slice(s1, e1),
            });
            assert.equal(res1.status, 201);
            const { highlight: h1 } = await res1.json();
            assert.equal(h1.text, BODY.slice(s1, e1));
            hlCarded = h1.id;

            const s2 = BODY.indexOf('Ribosomes');
            const res2 = await post(`${baseUrl}/api/highlights`, {
                path: FILE, type: 'text_offset', start: s2, end: BODY.length, color: 'green', text: BODY.slice(s2),
            });
            assert.equal(res2.status, 201);
            hlUncarded = (await res2.json()).highlight.id;
        });

        it('create-mode vanilla card carries origin "ai" into sidecar and DB row', async () => {
            const form = new FormData();
            form.append('docPath', FILE);
            form.append('card', JSON.stringify({
                cardType: 'basic',
                origin: 'ai',
                vanillaData: {
                    frontText: 'What powers the cell?', backText: 'The mitochondria', media: {},
                    location: { type: 'highlight', id: hlCarded },
                },
            }));
            const res = await fetch(`${baseUrl}/api/media/vanilla`, { method: 'POST', body: form });
            assert.equal(res.status, 201);
            const { card } = await res.json();
            aiCardHash = card.globalHash;
            assert.equal(card.origin, 'ai', 'sidecar card keeps the provenance marker');

            const readRes = await fetch(`${baseUrl}/api/documents/read?path=${encodeURIComponent(FILE)}`);
            const { metadata } = await readRes.json();
            assert.equal(metadata.flashcards.find(f => f.globalHash === aiCardHash)?.origin, 'ai');
        });

        it('GET /api/highlights/annotated → text, context, and card linkage per highlight', async () => {
            const res = await fetch(`${baseUrl}/api/highlights/annotated?path=${encodeURIComponent(FILE)}`);
            assert.equal(res.status, 200);
            const { highlights, total } = await res.json();
            assert.equal(total, 2);

            const carded = highlights.find(h => h.id === hlCarded);
            const uncarded = highlights.find(h => h.id === hlUncarded);
            assert.ok(carded && uncarded, 'both highlights listed');

            assert.ok(carded.text.startsWith('mitochondria'));
            assert.ok(carded.context.includes('powerhouse'), 'context covers the highlighted region');
            assert.ok(carded.context.includes('Ribosomes'), 'context includes surrounding body text');
            assert.equal(path.normalize(carded.documentPath), path.normalize(FILE));

            assert.equal(carded.hasCards, true);
            assert.deepEqual(carded.cardHashes, [aiCardHash]);
            assert.equal(uncarded.hasCards, false);
            assert.deepEqual(uncarded.cardHashes, []);
        });

        it('GET /api/highlights/annotated?uncarded=true → only highlights without cards', async () => {
            const res = await fetch(`${baseUrl}/api/highlights/annotated?path=${encodeURIComponent(FILE)}&uncarded=true`);
            const { highlights } = await res.json();
            assert.deepEqual(highlights.map(h => h.id), [hlUncarded]);
        });

        it('GET /api/highlights/annotated (no path) → vault-wide listing', async () => {
            const res = await fetch(`${baseUrl}/api/highlights/annotated`);
            assert.equal(res.status, 200);
            const { highlights } = await res.json();
            assert.ok(highlights.some(h => h.id === hlCarded), 'vault-wide listing includes this document\'s highlights');
        });

        it('GET /api/decks/cards?origin= separates AI-created from handmade cards', async () => {
            const aiRes = await fetch(`${baseUrl}/api/decks/cards?origin=ai&limit=200`);
            const aiBody = await aiRes.json();
            assert.ok(aiBody.cards.some(c => c.global_hash === aiCardHash), 'origin=ai includes the AI card');
            assert.ok(aiBody.cards.every(c => c.origin === 'ai'), 'origin=ai returns only AI cards');

            const humanRes = await fetch(`${baseUrl}/api/decks/cards?origin=human&limit=200`);
            const humanBody = await humanRes.json();
            assert.ok(humanBody.cards.some(c => c.global_hash === HAND_HASH), 'origin=human includes the handmade card');
            assert.ok(!humanBody.cards.some(c => c.global_hash === aiCardHash), 'origin=human excludes the AI card');
        });

        it('unrecognized origin values are dropped, not stored', async () => {
            const form = new FormData();
            form.append('docPath', FILE);
            form.append('card', JSON.stringify({
                cardType: 'basic',
                origin: 'totally-bogus',
                vanillaData: { frontText: 'Q', backText: 'A', media: {} },
            }));
            const res = await fetch(`${baseUrl}/api/media/vanilla`, { method: 'POST', body: form });
            assert.equal(res.status, 201);
            const { card } = await res.json();
            assert.equal(card.origin, undefined, 'bogus origin never reaches the sidecar');
        });
    });

    // ── Subscriptions ─────────────────────────────────────────────────────

    describe('Subscriptions', () => {
        const MAGAZINE_ID = 'api-test-magazine';
        const TARGET = 'SubsApiTest';

        const makeIssueZip = (issueId, version) => {
            const zip = new AdmZip();
            const folder = `${MAGAZINE_ID}-${version}`;
            zip.addFile(`${folder}/.flashback`, Buffer.from(JSON.stringify({
                globalHash: 'subs-root-hash',
                subscription: { magazineId: MAGAZINE_ID, issueId, version }
            })));
            zip.addFile(`${folder}/Article.md`, Buffer.from('# Article'));
            zip.addFile(`${folder}/Article.md.flashback`, Buffer.from(JSON.stringify({
                globalHash: 'subs-doc-hash',
                tags: ['News'],
                flashcards: []
            })));
            return zip.toBuffer();
        };

        before(async () => {
            await createFolder(TARGET);
        });

        it('POST /api/subscriptions/import → 201, content appears in workspace', async () => {
            const form = new FormData();
            form.append('file', new Blob([makeIssueZip('issue-1', 'v1.0.0')], { type: 'application/zip' }), 'issue.zip');
            form.append('magazineId', MAGAZINE_ID);
            form.append('targetPath', TARGET);

            const res = await fetch(`${baseUrl}/api/subscriptions/import`, { method: 'POST', body: form });
            assert.equal(res.status, 201);

            const items = await listFolder(TARGET);
            assert.ok(items.some(i => i.name === 'Article.md'), 'Imported article should appear in workspace');
        });

        it('GET /api/subscriptions/:magazineId → returns subscription record', async () => {
            const res = await fetch(`${baseUrl}/api/subscriptions/${MAGAZINE_ID}`);
            assert.equal(res.status, 200);
            const sub = await res.json();
            assert.equal(sub.magazine_id, MAGAZINE_ID);
            assert.equal(sub.issue_id, 'issue-1');
            assert.equal(sub.version, 'v1.0.0');
        });

        it('GET /api/subscriptions/:magazineId → 404 for unknown magazine', async () => {
            const res = await fetch(`${baseUrl}/api/subscriptions/does-not-exist`);
            assert.equal(res.status, 404);
        });

        it('POST /api/subscriptions/import → 400 when magazineId is missing', async () => {
            const form = new FormData();
            form.append('file', new Blob(['not-a-zip']), 'bad.zip');

            const res = await fetch(`${baseUrl}/api/subscriptions/import`, { method: 'POST', body: form });
            assert.equal(res.status, 400);
        });

        it('POST /api/subscriptions/import → re-import updates record without duplicating content', async () => {
            const form = new FormData();
            form.append('file', new Blob([makeIssueZip('issue-2', 'v2.0.0')], { type: 'application/zip' }), 'issue2.zip');
            form.append('magazineId', MAGAZINE_ID);
            form.append('targetPath', TARGET);

            const res = await fetch(`${baseUrl}/api/subscriptions/import`, { method: 'POST', body: form });
            assert.equal(res.status, 201);

            // Subscription record must reflect the new version
            const subRes = await fetch(`${baseUrl}/api/subscriptions/${MAGAZINE_ID}`);
            const sub = await subRes.json();
            assert.equal(sub.issue_id, 'issue-2', 'Subscription record must update to new issue ID');
            assert.equal(sub.version, 'v2.0.0', 'Subscription record must update to new version');

            // Article must appear exactly once — no duplicates after re-import
            const items = await listFolder(TARGET);
            const articleCount = items.filter(i => i.name === 'Article.md').length;
            assert.equal(articleCount, 1, 'Re-import must not create a duplicate Article.md');
        });
    });

    // ── Decks ─────────────────────────────────────────────────────────────

    describe('Decks', () => {
        const ROOT = 'DecksApiTest';
        const DOC = 'deck-doc.md';
        const FC_HASH_1 = 'decks-api-fc-001';
        const FC_HASH_2 = 'decks-api-fc-002';
        let deckHash = null;

        before(async () => {
            await createFolder(ROOT);
            await createFile(DOC, ROOT);
            await updateFile(`${ROOT}/${DOC}`, '# Deck Doc', {
                flashcards: [
                    { globalHash: FC_HASH_1, vanillaData: { frontText: 'Deck Q1', backText: 'A1' } },
                    { globalHash: FC_HASH_2, vanillaData: { frontText: 'Deck Q2', backText: 'A2' } },
                ]
            });
        });

        it('GET /api/decks → returns an array', async () => {
            const res = await fetch(`${baseUrl}/api/decks`);
            assert.equal(res.status, 200);
            assert.ok(Array.isArray(await res.json()));
        });

        it('POST /api/decks → 400 when name is missing', async () => {
            const res = await post(`${baseUrl}/api/decks`, {});
            assert.equal(res.status, 400);
        });

        it('POST /api/decks → 201, returns globalHash', async () => {
            const res = await post(`${baseUrl}/api/decks`, { name: 'Test Deck', description: 'A test deck' });
            assert.equal(res.status, 201);
            const body = await res.json();
            assert.ok(body.globalHash, 'Response must include a globalHash');
            deckHash = body.globalHash;
        });

        it('GET /api/decks/:hash → returns deck with name and description', async () => {
            assert.ok(deckHash, 'Precondition: deck created');
            const res = await fetch(`${baseUrl}/api/decks/${deckHash}`);
            assert.equal(res.status, 200);
            const deck = await res.json();
            assert.equal(deck.name, 'Test Deck');
            assert.equal(deck.description, 'A test deck');
        });

        it('GET /api/decks/:hash → 404 for unknown hash', async () => {
            const res = await fetch(`${baseUrl}/api/decks/no-such-deck`);
            assert.equal(res.status, 404);
        });

        it('PUT /api/decks/:hash → 200, updates name and description', async () => {
            assert.ok(deckHash, 'Precondition: deck created');
            const res = await put(`${baseUrl}/api/decks/${deckHash}`, { name: 'Renamed Deck', description: 'Updated desc' });
            assert.equal(res.status, 200);

            const deck = await (await fetch(`${baseUrl}/api/decks/${deckHash}`)).json();
            assert.equal(deck.name, 'Renamed Deck', 'Name must be updated');
            assert.equal(deck.description, 'Updated desc', 'Description must be updated');
        });

        it('POST /api/decks/:hash/entries → 400 when cardHash is missing', async () => {
            assert.ok(deckHash, 'Precondition: deck created');
            const res = await post(`${baseUrl}/api/decks/${deckHash}/entries`, {});
            assert.equal(res.status, 400);
        });

        it('POST /api/decks/:hash/entries → 201, adds card to deck', async () => {
            assert.ok(deckHash, 'Precondition: deck created');
            const res = await post(`${baseUrl}/api/decks/${deckHash}/entries`, {
                cardHash: FC_HASH_1,
                documentPath: `${ROOT}/${DOC}`
            });
            assert.equal(res.status, 201);
        });

        it('POST /api/decks/:hash/entries → 409 when same card added twice', async () => {
            assert.ok(deckHash, 'Precondition: card already added');
            const res = await post(`${baseUrl}/api/decks/${deckHash}/entries`, {
                cardHash: FC_HASH_1,
                documentPath: `${ROOT}/${DOC}`
            });
            assert.equal(res.status, 409);
        });

        it('GET /api/decks/:hash → entry_count reflects added entries', async () => {
            const deck = await (await fetch(`${baseUrl}/api/decks/${deckHash}`)).json();
            assert.ok(deck.entry_count >= 1, 'entry_count must be at least 1 after adding a card');
        });

        it('GET /api/decks → newly created deck appears in list', async () => {
            const decks = await (await fetch(`${baseUrl}/api/decks`)).json();
            assert.ok(decks.some(d => d.global_hash === deckHash),
                'Created deck must appear in the full list');
        });

        it('PUT /api/decks/:hash/tags → 200, sets deck tags returned by GET', async () => {
            assert.ok(deckHash, 'Precondition: deck created');
            const res = await put(`${baseUrl}/api/decks/${deckHash}/tags`, { tags: ['apitag', 'apitag', ' '] });
            assert.equal(res.status, 200);
            const body = await res.json();
            assert.deepEqual(body.tags, ['apitag'], 'response should return the cleaned tag set');

            const deck = await (await fetch(`${baseUrl}/api/decks/${deckHash}`)).json();
            assert.deepEqual(deck.tags, ['apitag'], 'GET deck must reflect the saved tags');
        });

        it('PUT /api/decks/:hash/tags → clears tags when given an empty array', async () => {
            const res = await put(`${baseUrl}/api/decks/${deckHash}/tags`, { tags: [] });
            assert.equal(res.status, 200);
            const deck = await (await fetch(`${baseUrl}/api/decks/${deckHash}`)).json();
            assert.deepEqual(deck.tags, [], 'tags must be cleared');
        });

        it('GET /api/decks/cards → returns paginated card browser results', async () => {
            const res = await fetch(`${baseUrl}/api/decks/cards?search=Deck+Q`);
            assert.equal(res.status, 200);
            const body = await res.json();
            assert.ok(Array.isArray(body.cards), 'cards field must be an array');
            assert.ok(typeof body.total === 'number', 'total must be a number');
            assert.ok(typeof body.limit === 'number', 'limit must be present');
            assert.ok(typeof body.offset === 'number', 'offset must be present');
            assert.ok(
                body.cards.some(c => c.global_hash === FC_HASH_1 || c.global_hash === FC_HASH_2),
                'Card browser must find cards matching the search term'
            );
        });

        it('GET /api/decks/cards → returns all cards when no search term given', async () => {
            const res = await fetch(`${baseUrl}/api/decks/cards`);
            assert.equal(res.status, 200);
            const body = await res.json();
            assert.ok(body.total >= 2, 'Should return at least the two cards created in before()');
        });

        it('GET /api/srs/due?deck= → scopes due queue to deck contents', async () => {
            assert.ok(deckHash, 'Precondition: deck with one entry (FC_HASH_1)');
            const res = await fetch(`${baseUrl}/api/srs/due?deck=${encodeURIComponent(deckHash)}`);
            assert.equal(res.status, 200);
            const body = await res.json();
            assert.ok(Array.isArray(body.new), 'new field must be an array');
            assert.ok(body.new.some(c => c.global_hash === FC_HASH_1),
                'FC_HASH_1 is in the deck — must appear in the deck-scoped session');
            assert.ok(!body.new.some(c => c.global_hash === FC_HASH_2),
                'FC_HASH_2 is NOT in the deck — must not appear in the deck-scoped session');

            // The Trainer studies `queue`; deck scoping has to survive sequencing too.
            const queued = body.queue.map(c => c.global_hash);
            assert.ok(queued.includes(FC_HASH_1), 'deck-scoped queue must contain the deck entry');
            assert.ok(!queued.includes(FC_HASH_2), 'deck-scoped queue must not leak a non-entry');
        });

        it('DELETE /api/decks/:hash/entries/:cardHash → 200, card gone from deck-scoped session', async () => {
            assert.ok(deckHash, 'Precondition: deck with FC_HASH_1 entry');
            const res = await del(`${baseUrl}/api/decks/${deckHash}/entries/${FC_HASH_1}`);
            assert.equal(res.status, 200);

            const body = await (await fetch(`${baseUrl}/api/srs/due?deck=${encodeURIComponent(deckHash)}`)).json();
            const allCards = [...body.due, ...body.new];
            assert.ok(!allCards.some(c => c.global_hash === FC_HASH_1),
                'Removed card must not appear in the deck-scoped study session');
        });

        it('DELETE /api/decks/:hash → 200, deck gone from listing', async () => {
            assert.ok(deckHash, 'Precondition: deck created');
            const res = await del(`${baseUrl}/api/decks/${deckHash}`);
            assert.equal(res.status, 200);

            const decks = await (await fetch(`${baseUrl}/api/decks`)).json();
            assert.ok(!decks.some(d => d.global_hash === deckHash),
                'Deleted deck must not appear in the listing');
        });

        // ── Purge: delete the deck AND its cards ──────────────────────────────
        //
        // Deliberately separate from DELETE /:hash, which keeps the cards. These
        // pin the distinction and the two judgement calls the purge makes: cards
        // another *non-system* deck holds survive unless asked for, and
        // document-anchored cards really leave their sidecar.
        describe('POST /api/decks/:hash/purge', () => {
            // Each case gets its own document and cards. Sharing them across cases made
            // an earlier version of this suite lie: a card left in a *previous* case's
            // surviving deck is legitimately "shared", so the purge correctly spared it
            // and the failure looked like a bug in the purge rather than in the fixture.
            async function buildPurgeFixture(prefix) {
                const doc = `purge-${prefix}.md`;
                const docCard = `decks-purge-fc-${prefix}`;
                await createFile(doc, ROOT);
                await updateFile(`${ROOT}/${doc}`, '# Purge Doc', {
                    flashcards: [
                        { globalHash: docCard, vanillaData: { frontText: 'Purge Q', backText: 'Purge A' } },
                    ]
                });

                const deck = await (await post(`${baseUrl}/api/decks`, { name: `${prefix} target` })).json();
                const other = await (await post(`${baseUrl}/api/decks`, { name: `${prefix} other` })).json();

                const solo = await (await post(`${baseUrl}/api/flashcards`,
                    { frontText: 'solo Q', backText: 'solo A', name: 'solo' })).json();
                const shared = await (await post(`${baseUrl}/api/flashcards`,
                    { frontText: 'shared Q', backText: 'shared A', name: 'shared' })).json();

                await post(`${baseUrl}/api/decks/${deck.globalHash}/entries`, { cardHash: solo.globalHash });
                await post(`${baseUrl}/api/decks/${deck.globalHash}/entries`, { cardHash: shared.globalHash });
                await post(`${baseUrl}/api/decks/${other.globalHash}/entries`, { cardHash: shared.globalHash });
                await post(`${baseUrl}/api/decks/${deck.globalHash}/entries`,
                    { cardHash: docCard, documentPath: `${ROOT}/${doc}` });

                return {
                    deck: deck.globalHash, other: other.globalHash,
                    solo: solo.globalHash, shared: shared.globalHash,
                    docCard, docPath: `${ROOT}/${doc}`,
                };
            }

            it('GET /:hash/contents → splits standalone, document and shared counts', async () => {
                const f = await buildPurgeFixture('contents');
                const summary = await (await fetch(`${baseUrl}/api/decks/${f.deck}/contents`)).json();

                assert.equal(summary.total, 3);
                assert.equal(summary.standalone, 2);
                assert.equal(summary.documentAnchored, 1);
                assert.ok(summary.documents.some(d => d.includes('purge-contents.md')),
                    'names the document the anchored card comes from');
                // The system deck holds every standalone card and must not count as
                // a second owner, or nothing would ever be erasable.
                assert.equal(summary.shared, 1, 'only the card in the other real deck is shared');
                assert.ok(summary.otherDecks.some(n => n.includes('other')));
            });

            it('purges standalone + document cards, sparing shared ones by default', async () => {
                const f = await buildPurgeFixture('spare');
                // Precondition: the fixture really did produce a shared card. Without
                // this an assertion further down fails for a fixture reason and reads
                // like a bug in the purge.
                const pre = await (await fetch(`${baseUrl}/api/decks/${f.deck}/contents`)).json();
                assert.deepEqual(
                    { total: pre.total, standalone: pre.standalone, doc: pre.documentAnchored, shared: pre.shared },
                    { total: 3, standalone: 2, doc: 1, shared: 1 },
                );

                const res = await post(`${baseUrl}/api/decks/${f.deck}/purge`, {});
                const body = await res.json();
                assert.equal(res.status, 200, `purge failed: ${JSON.stringify(body)}`);
                assert.equal(body.deleted, 2, 'solo + document-anchored');
                assert.equal(body.kept, 1, 'the shared card is spared');

                const decks = await (await fetch(`${baseUrl}/api/decks`)).json();
                assert.ok(!decks.some(d => d.global_hash === f.deck), 'deck itself is gone');

                assert.equal((await fetch(`${baseUrl}/api/flashcards/${f.solo}`)).status, 404,
                    'unshared standalone card destroyed');
                assert.equal((await fetch(`${baseUrl}/api/flashcards/${f.shared}`)).status, 200,
                    'shared card survives');
                assert.equal((await fetch(`${baseUrl}/api/flashcards/${f.docCard}`)).status, 404,
                    'document-anchored card destroyed');

                // ...and it really left the sidecar, not just the index.
                const sidecar = await (await fetch(
                    `${baseUrl}/api/documents/sidecar?path=${encodeURIComponent(f.docPath)}`)).json();
                assert.ok(!(sidecar.flashcards ?? []).some(c => c.globalHash === f.docCard),
                    'card removed from the document sidecar, not only from the DB');

                // The spared card must still be usable in the deck that kept it.
                const other = await (await fetch(`${baseUrl}/api/decks/${f.other}`)).json();
                assert.ok(other.entries.some(e => e.card_hash === f.shared));
            });

            it('purges shared cards too when includeShared is set', async () => {
                const f = await buildPurgeFixture('include');
                const body = await (await post(`${baseUrl}/api/decks/${f.deck}/purge`,
                    { includeShared: true })).json();
                assert.equal(body.kept, 0);

                assert.equal((await fetch(`${baseUrl}/api/flashcards/${f.shared}`)).status, 404,
                    'shared card destroyed everywhere when opted in');
                const other = await (await fetch(`${baseUrl}/api/decks/${f.other}`)).json();
                assert.ok(!other.entries.some(e => e.card_hash === f.shared),
                    'and is unlinked from the deck that held it');
            });

            it('leaves no orphan entries in the system deck', async () => {
                const f = await buildPurgeFixture('orphan');
                await post(`${baseUrl}/api/decks/${f.deck}/purge`, { includeShared: true });

                const decks = await (await fetch(`${baseUrl}/api/decks`)).json();
                const system = decks.find(d => d.is_system);
                const detail = await (await fetch(`${baseUrl}/api/decks/${system.global_hash}`)).json();
                for (const hash of [f.solo, f.shared]) {
                    assert.ok(!detail.entries.some(e => e.card_hash === hash),
                        `destroyed card ${hash} must not linger in the system deck`);
                }
            });

            it('reports the shared split so a spared-card breakdown adds up', async () => {
                // The dialog subtracts spared cards from the standalone/document counts.
                // Without this split it showed "0 cards will be deleted" above a list
                // reading "1 standalone" — the totals and the headline disagreeing.
                const f = await buildPurgeFixture('split');
                const s = await (await fetch(`${baseUrl}/api/decks/${f.deck}/contents`)).json();

                assert.equal(s.sharedStandalone, 1, 'the shared card is the standalone one');
                assert.equal(s.sharedDocumentAnchored, 0);
                assert.equal(s.standalone - s.sharedStandalone + (s.documentAnchored - s.sharedDocumentAnchored),
                    s.total - s.shared,
                    'breakdown minus spared must equal the doomed total');
            });

            it('404s for an unknown deck', async () => {
                const res = await post(`${baseUrl}/api/decks/no-such-deck/purge`, {});
                assert.equal(res.status, 404);
            });
        });
    });

    // ── Flashcards ─────────────────────────────────────────────────────────
    // DELETE /api/flashcards/:hash used to be standalone-only ("Card is linked to a
    // document — delete from the document instead"), which left the Flashcards view —
    // the one place cards can be filtered by name — unable to delete most of them.
    // It now resolves the card's home itself and cleans up its deck links.

    describe('Flashcards', () => {
        const ROOT = 'FlashcardsApiTest';
        const DOC = 'cards-doc.md';
        const ANCHORED = 'fc-api-anchored-001';
        const KEPT = 'fc-api-anchored-002';
        let deckHash = null;
        let standaloneHash = null;

        before(async () => {
            await createFolder(ROOT);
            await createFile(DOC, ROOT);
            await updateFile(`${ROOT}/${DOC}`, '# Cards Doc', {
                flashcards: [
                    { globalHash: ANCHORED, vanillaData: { frontText: 'Anchored Q', backText: 'A' } },
                    { globalHash: KEPT, vanillaData: { frontText: 'Kept Q', backText: 'A' } },
                ],
            });

            const deck = await post(`${baseUrl}/api/decks`, { name: 'Card Delete Deck' });
            deckHash = (await deck.json()).globalHash;
            await post(`${baseUrl}/api/decks/${deckHash}/entries`, {
                cardHash: ANCHORED, documentPath: `${ROOT}/${DOC}`,
            });

            const standalone = await post(`${baseUrl}/api/flashcards`, {
                frontText: 'Standalone Q', backText: 'A', cardType: 'basic',
            });
            standaloneHash = (await standalone.json()).globalHash;
        });

        it('GET /api/flashcards/:hash → resolves a card to its source document', async () => {
            const res = await fetch(`${baseUrl}/api/flashcards/${ANCHORED}`);
            assert.equal(res.status, 200);
            const card = await res.json();
            assert.equal(card.documentPath.replace(/\\/g, '/'), `${ROOT}/${DOC}`);

            const solo = await (await fetch(`${baseUrl}/api/flashcards/${standaloneHash}`)).json();
            assert.equal(solo.documentPath, null, 'a standalone card reports no document');
        });

        it('DELETE /api/flashcards/:hash → 404 for an unknown hash', async () => {
            const res = await del(`${baseUrl}/api/flashcards/no-such-card-hash`);
            assert.equal(res.status, 404);
        });

        it('DELETE /api/flashcards/:hash → removes a document-anchored card from its sidecar', async () => {
            const res = await del(`${baseUrl}/api/flashcards/${ANCHORED}`);
            assert.equal(res.status, 200);
            const body = await res.json();
            assert.equal(body.documentPath.replace(/\\/g, '/'), `${ROOT}/${DOC}`,
                'response reports which document the card was resolved to');

            const read = await (await fetch(
                `${baseUrl}/api/documents/read?path=${encodeURIComponent(`${ROOT}/${DOC}`)}`)).json();
            const hashes = (read.metadata?.flashcards ?? []).map(f => f.globalHash);
            assert.ok(!hashes.includes(ANCHORED), 'card gone from the sidecar');
            assert.ok(hashes.includes(KEPT), 'its sibling card is untouched');

            const gone = await fetch(`${baseUrl}/api/flashcards/${ANCHORED}`);
            assert.equal(gone.status, 404, 'card gone from the derived layer too');
        });

        it('deleting a card unlinks it from every deck holding it', async () => {
            // DeckEntries key on card_hash, not a Flashcards FK — nothing cascades, so
            // without explicit cleanup the deck goes on listing a card that is gone.
            assert.ok(deckHash, 'Precondition: deck held the now-deleted card');
            const deck = await (await fetch(`${baseUrl}/api/decks/${deckHash}`)).json();
            assert.equal(deck.entry_count, 0, 'deck entry removed with the card');

            const body = await (await fetch(
                `${baseUrl}/api/srs/due?deck=${encodeURIComponent(deckHash)}`)).json();
            assert.ok(![...body.due, ...body.new].some(c => c.global_hash === ANCHORED),
                'deleted card must not surface in a deck-scoped session');
        });

        it('DELETE /api/flashcards/:hash → still deletes a standalone card', async () => {
            const res = await del(`${baseUrl}/api/flashcards/${standaloneHash}`);
            assert.equal(res.status, 200);
            assert.equal((await res.json()).documentPath, null);
            assert.equal((await fetch(`${baseUrl}/api/flashcards/${standaloneHash}`)).status, 404);
        });
    });

    // ── Card editing + detail ─────────────────────────────────────────────
    //
    // Editing an anchored card used to be refused outright ("edit from the document
    // instead"); the detail endpoint is what the Flashcards view's card modal reads.

    describe('Flashcard edit + detail', () => {
        const ROOT = 'CardDetailApiTest';
        const DOC = 'detail-doc.md';
        const EDITABLE = 'fc-detail-anchored-001';
        const SIBLING = 'fc-detail-anchored-002';
        const REVIEWED = 'fc-detail-anchored-003';
        const docPath = () => `${ROOT}/${DOC}`;
        let soloHash = null;

        const readSidecar = async () => {
            const res = await fetch(
                `${baseUrl}/api/documents/read?path=${encodeURIComponent(docPath())}`);
            return (await res.json()).metadata ?? {};
        };
        const cardIn = (meta, hash) => (meta.flashcards ?? []).find(f => f.globalHash === hash);
        const detail = async (hash, qs = '') =>
            fetch(`${baseUrl}/api/flashcards/${hash}/detail${qs}`);

        before(async () => {
            await createFolder(ROOT);
            await createFile(DOC, ROOT);
            await updateFile(docPath(), '# Detail Doc', {
                flashcards: [
                    {
                        globalHash: EDITABLE, level: 4, lastRecall: '2026-07-01T10:00:00.000Z',
                        vanillaData: {
                            frontText: 'Original front', backText: 'Original back',
                            media: { front_img: 'keep-me.png', back_img: null, front_sound: null, back_sound: null },
                            location: { type: 'highlight', highlightHash: 'hl-detail-001' },
                        },
                    },
                    { globalHash: SIBLING, vanillaData: { frontText: 'Sibling front', backText: 'B' } },
                    { globalHash: REVIEWED, vanillaData: { frontText: 'Reviewed front', backText: 'B' } },
                ],
            });

            const solo = await post(`${baseUrl}/api/flashcards`, {
                frontText: 'Solo front', backText: 'Solo back', cardType: 'basic',
            });
            soloHash = (await solo.json()).globalHash;
        });

        it('PUT /api/flashcards/:hash → edits a document-anchored card in its sidecar', async () => {
            const res = await put(`${baseUrl}/api/flashcards/${EDITABLE}`, {
                frontText: 'Edited front', name: 'Edited front',
            });
            assert.equal(res.status, 200);
            const body = await res.json();
            assert.equal(body.documentPath.replace(/\\/g, '/'), docPath(),
                'response reports which document the card was resolved to');

            const meta = await readSidecar();
            const card = cardIn(meta, EDITABLE);
            assert.equal(card.vanillaData.frontText, 'Edited front');
            assert.equal(card.vanillaData.backText, 'Original back', 'omitted fields keep their value');
            assert.equal(cardIn(meta, SIBLING).vanillaData.frontText, 'Sibling front',
                'sibling cards are untouched');
        });

        it('editing an anchored card preserves its SRS progress, media and anchor', async () => {
            const card = cardIn(await readSidecar(), EDITABLE);
            assert.equal(card.level, 4, 'level survives an edit');
            assert.equal(card.lastRecall, '2026-07-01T10:00:00.000Z');
            assert.equal(card.vanillaData.media.front_img, 'keep-me.png');
            assert.equal(card.vanillaData.location?.highlightHash, 'hl-detail-001',
                'the highlight anchor back into the document survives');
        });

        it('GET /api/flashcards/:hash → carries the card\'s stored media references', async () => {
            // The detail view previews the real card, media included, so the references
            // have to survive the derived layer. They are stored refs, not URLs — the
            // client resolves them against the document via /api/media/file.
            const card = await (await fetch(`${baseUrl}/api/flashcards/${EDITABLE}`)).json();
            assert.equal(card.media.front_img, 'keep-me.png');
            assert.equal(card.media.back_img, null, 'empty slots are null, not absent');
            const body = await (await detail(EDITABLE)).json();
            assert.equal(body.card.media.front_img, 'keep-me.png');
        });

        it('PUT /api/flashcards/:hash → still edits a standalone card', async () => {
            const res = await put(`${baseUrl}/api/flashcards/${soloHash}`, { backText: 'Solo edited' });
            assert.equal(res.status, 200);
            assert.equal((await res.json()).documentPath, null);

            const card = await (await fetch(`${baseUrl}/api/flashcards/${soloHash}`)).json();
            assert.equal(card.backText, 'Solo edited');
            assert.equal(card.frontText, 'Solo front', 'omitted fields keep their value');
        });

        // A type_answer card's compared answer lives in answerText so its backText is free
        // to hold notes shown after checking. Both have to survive the round trip
        // independently, or a mnemonic edit would silently change what gets graded.
        it('POST/PUT /api/flashcards → round-trips a type_answer card\'s answer and notes', async () => {
            const created = await post(`${baseUrl}/api/flashcards`, {
                frontText: 'か', answerText: 'ka', backText: 'Looks like a kayak.',
                cardType: 'type_answer', name: 'か',
            });
            assert.equal(created.status, 201);
            const hash = (await created.json()).globalHash;

            let card = await (await fetch(`${baseUrl}/api/flashcards/${hash}`)).json();
            assert.equal(card.answerText, 'ka');
            assert.equal(card.backText, 'Looks like a kayak.');

            // Editing only the notes must leave the graded answer exactly as it was.
            assert.equal((await put(`${baseUrl}/api/flashcards/${hash}`,
                { backText: 'A kayak, seen side on.' })).status, 200);
            card = await (await fetch(`${baseUrl}/api/flashcards/${hash}`)).json();
            assert.equal(card.answerText, 'ka', 'the compared answer is untouched');
            assert.equal(card.backText, 'A kayak, seen side on.');

            await del(`${baseUrl}/api/flashcards/${hash}`);
        });

        it('PUT /api/flashcards/:hash → 404 unknown hash, 400 unknown category (both homes)', async () => {
            assert.equal((await put(`${baseUrl}/api/flashcards/no-such-card`, { frontText: 'x' })).status, 404);
            assert.equal((await put(`${baseUrl}/api/flashcards/${EDITABLE}`, { category: 'Nope' })).status, 400);
            assert.equal((await put(`${baseUrl}/api/flashcards/${soloHash}`, { category: 'Nope' })).status, 400);
        });

        it('GET /api/flashcards/:hash/detail → a never-reviewed card has no curve', async () => {
            const res = await detail(SIBLING);
            assert.equal(res.status, 200);
            const body = await res.json();
            assert.equal(body.card.globalHash, SIBLING);
            assert.equal(body.srs.state, 'new');
            assert.equal(body.curve, null, 'nothing to model until the card has been reviewed');
            assert.deepEqual(body.history, []);
            assert.deepEqual(body.flags, [], 'reserved for card-health warnings');
        });

        it('GET /api/flashcards/:hash/detail → a reviewed card gets an approximated curve', async () => {
            const review = await post(`${baseUrl}/api/srs/review`, {
                path: docPath(), flashcardHash: REVIEWED, algorithm: 'leitner',
                outcome: 1, easeFactor: 2.5, newLevel: 3,
            });
            assert.equal(review.status, 200);

            const body = await (await detail(REVIEWED, '?algorithm=leitner')).json();
            assert.equal(body.algorithm, 'leitner', 'echoes back the algorithm actually used');
            assert.equal(body.srs.state, 'review');
            assert.equal(body.history.length, 1);
            assert.equal(body.history[0].algorithm, 'leitner');
            assert.equal(body.srs.reviews, 1);
            assert.equal(body.srs.retention, 1);

            // Leitner has no memory model — the curve is drawn from its interval and
            // must say so rather than passing for a fitted one.
            assert.equal(body.curve.model, 'approximated');
            assert.equal(body.curve.points[0].t, 0);
            assert.equal(body.curve.points[0].r, 1, 'recall is certain at the moment of review');
            for (let i = 1; i < body.curve.points.length; i++) {
                assert.ok(body.curve.points[i].r <= body.curve.points[i - 1].r,
                    'retention may only decay as time passes');
            }
            // The premise the approximation rests on: the interval is where recall
            // has fallen to the request retention.
            const atDue = body.curve.points.reduce((best, p) =>
                Math.abs(p.t - body.curve.intervalDays) < Math.abs(best.t - body.curve.intervalDays) ? p : best);
            assert.ok(Math.abs(atDue.r - body.curve.requestRetention) < 0.03,
                `retention at the due date should be ~${body.curve.requestRetention}, got ${atDue.r}`);

            const dueDelta = Date.parse(body.srs.dueAt) - Date.parse(body.srs.lastRecall);
            assert.ok(Math.abs(dueDelta - body.srs.intervalDays * 86400000) < 1000,
                'due date is the last review plus the scheduled interval');
        });

        it('GET /api/flashcards/:hash/detail?algorithm=fsrs → models from the card\'s real stability', async () => {
            const review = await post(`${baseUrl}/api/srs/review`, {
                path: docPath(), flashcardHash: EDITABLE, algorithm: 'fsrs', rating: 3,
            });
            assert.equal(review.status, 200);

            const body = await (await detail(EDITABLE, '?algorithm=fsrs')).json();
            assert.equal(body.algorithm, 'fsrs');
            assert.equal(body.curve.model, 'fsrs');
            assert.ok(body.srs.fsrs.stability > 0);
            assert.equal(body.curve.stabilityDays, body.srs.fsrs.stability,
                'the curve is drawn from the card\'s own stability, not a re-derived one');
            assert.equal(body.history.at(-1).rating, 3);
        });

        it('GET /api/flashcards/:hash/detail → 404 for an unknown hash', async () => {
            assert.equal((await detail('no-such-card')).status, 404);
        });

        it('GET /api/decks/cards?sortBy=difficulty → rated cards rank, unrated always sink', async () => {
            // Difficulty only exists once a card has been rated under FSRS (EDITABLE was,
            // in the test above). Cards without one carry no information about how hard
            // they are, so they must sit at the bottom in BOTH directions — otherwise the
            // "easiest first" page is entirely cards nobody has ever rated.
            const page = async (dir) => {
                const res = await fetch(`${baseUrl}/api/decks/cards?sortBy=difficulty&sortDir=${dir}&limit=200`);
                assert.equal(res.status, 200);
                return (await res.json()).cards;
            };

            // The rated cards form an unbroken run at the head of the page.
            const ratedRunOf = (cards) => {
                const n = cards.filter(c => c.difficulty != null).length;
                assert.ok(cards.slice(0, n).every(c => c.difficulty != null),
                    'every unrated card comes after every rated one');
                return cards.slice(0, n);
            };

            const desc = ratedRunOf(await page('desc'));
            assert.ok(desc.some(c => c.global_hash === EDITABLE),
                'the FSRS-rated card reports a difficulty');
            for (let i = 1; i < desc.length; i++) {
                assert.ok(desc[i].difficulty <= desc[i - 1].difficulty, 'hardest first');
            }

            const asc = ratedRunOf(await page('asc'));
            for (let i = 1; i < asc.length; i++) {
                assert.ok(asc[i].difficulty >= asc[i - 1].difficulty, 'easiest first');
            }
        });
    });

    // ── Seal ──────────────────────────────────────────────────────────────

    describe('Seal', () => {
        it('GET /api/seal/log → returns array of commits', async () => {
            const res = await fetch(`${baseUrl}/api/seal/log?limit=5`);
            assert.equal(res.status, 200);
            const log = await res.json();
            assert.ok(Array.isArray(log));
            assert.ok(log.length > 0, 'Should have commits from the preceding test suites');
            assert.ok(log[0].oid, 'Each entry should have an oid');
            assert.ok(log[0].commit?.message, 'Each entry should have a commit message');
            assert.equal(typeof log[0].stats?.content, 'number', 'Each entry should carry a content-path count');
        });

        it('GET /api/seal/log?cursor= → resumes after the cursor commit', async () => {
            const firstRes = await fetch(`${baseUrl}/api/seal/log?limit=2`);
            const first = await firstRes.json();
            if (first.length < 2) return; // not enough history in this run

            const res = await fetch(`${baseUrl}/api/seal/log?limit=2&cursor=${first[1].oid}`);
            assert.equal(res.status, 200);
            const page = await res.json();
            assert.ok(Array.isArray(page));
            const seen = new Set(first.map(c => c.oid));
            for (const c of page) {
                assert.ok(!seen.has(c.oid), 'A cursor page must not repeat commits already returned');
            }
        });

        it('GET /api/seal/inspect → returns workspace diff object', async () => {
            const res = await fetch(`${baseUrl}/api/seal/inspect`);
            assert.equal(res.status, 200);
            const diff = await res.json();
            assert.ok(typeof diff === 'object' && diff !== null);
        });

        it('POST /api/seal/rollback → 200, rolls canonical layer back', async () => {
            // Grab the second-to-last commit as the rollback target
            const logRes = await fetch(`${baseUrl}/api/seal/log?limit=10`);
            const log = await logRes.json();
            if (log.length < 2) return; // not enough history in this run — skip gracefully

            const targetRef = log[1].oid;
            const res = await post(`${baseUrl}/api/seal/rollback`, { ref: targetRef, keepSrsProgress: true });
            assert.equal(res.status, 200);
        });

        it('POST /api/seal/rollback → 400 when ref is missing', async () => {
            const res = await post(`${baseUrl}/api/seal/rollback`, {});
            assert.equal(res.status, 400);
        });
    });

    // ── Diary ──────────────────────────────────────────────────────────────
    // Verifies the HTTP contract the Diary view + Trainer trigger depend on.
    // Summary *derivation* from ReviewLogs is unit-tested in tests/diary.test.js;
    // here we exercise routing, status codes, and the entry roundtrip. Diary files
    // land in data/<vault>/diary and are removed by the suite's data/ teardown.

    describe('Diary', () => {
        const DATE = '2021-03-14';

        it('POST /api/diary/summary → 200 with null summary when the day has no reviews', async () => {
            const res = await post(`${baseUrl}/api/diary/summary`, { date: DATE });
            assert.equal(res.status, 200);
            const body = await res.json();
            assert.equal(body.ok, true);
            assert.equal(body.summary, null);
        });

        it('POST /api/diary/summary → 400 on a malformed date', async () => {
            const res = await post(`${baseUrl}/api/diary/summary`, { date: '03/14/2021' });
            assert.equal(res.status, 400);
        });

        it('GET /api/diary/summary/:date → 404 when no summary exists', async () => {
            const res = await fetch(`${baseUrl}/api/diary/summary/${DATE}`);
            assert.equal(res.status, 404);
        });

        it('GET /api/diary/entry/:date → empty content when no entry exists', async () => {
            const res = await fetch(`${baseUrl}/api/diary/entry/${DATE}`);
            assert.equal(res.status, 200);
            const body = await res.json();
            assert.equal(body.content, '');
        });

        it('PUT then GET /api/diary/entry/:date → roundtrips the markdown', async () => {
            const putRes = await put(`${baseUrl}/api/diary/entry/${DATE}`, { content: '# Reflection\nGood session.' });
            assert.equal(putRes.status, 200);
            const putBody = await putRes.json();
            assert.equal(putBody.ok, true);
            assert.equal(putBody.created, true);

            const getRes = await fetch(`${baseUrl}/api/diary/entry/${DATE}`);
            const getBody = await getRes.json();
            assert.equal(getBody.content, '# Reflection\nGood session.');
        });

        it('PUT empty content for a fresh date is a no-op (lazy create)', async () => {
            const res = await put(`${baseUrl}/api/diary/entry/2021-03-15`, { content: '   ' });
            assert.equal(res.status, 200);
            const body = await res.json();
            assert.equal(body.created, false);
        });

        it('GET /api/diary lists dates with per-kind flags', async () => {
            const res = await fetch(`${baseUrl}/api/diary`);
            assert.equal(res.status, 200);
            const list = await res.json();
            assert.ok(Array.isArray(list));
            const day = list.find(d => d.date === DATE);
            assert.ok(day && day.hasEntry === true);
        });

        it('POST /api/diary/rebuild → 200 with a count', async () => {
            const res = await post(`${baseUrl}/api/diary/rebuild`, {});
            assert.equal(res.status, 200);
            const body = await res.json();
            assert.equal(body.ok, true);
            assert.equal(typeof body.count, 'number');
        });

        // Privacy gate: requests tagged as coming from the MCP server (the AI
        // assistant) are refused unless config.json enables mcpDiaryAccess. The
        // renderer sends no such header, so the in-app Diary view is never gated.
        describe('AI-assistant access gate', () => {
            const cfgPath = path.join(process.cwd(), 'data', 'config.json');
            const mcp = (p) => fetch(`${baseUrl}${p}`, { headers: { 'X-Flashback-Client': 'mcp' } });
            const setAccess = (allowed) => {
                const cfg = fsSync.existsSync(cfgPath) ? JSON.parse(fsSync.readFileSync(cfgPath, 'utf-8')) : {};
                fsSync.writeFileSync(cfgPath, JSON.stringify({ ...cfg, mcpDiaryAccess: allowed }, null, 2));
            };

            after(() => setAccess(false)); // leave the vault closed

            it('403s MCP-tagged diary reads when access is disabled', async () => {
                setAccess(false);
                assert.equal((await mcp('/api/diary')).status, 403);
                assert.equal((await mcp(`/api/diary/summary/${DATE}`)).status, 403);
                assert.equal((await mcp(`/api/diary/entry/${DATE}`)).status, 403);
            });

            it('allows MCP-tagged diary reads once access is enabled', async () => {
                setAccess(true);
                assert.equal((await mcp('/api/diary')).status, 200);
                assert.equal((await mcp(`/api/diary/entry/${DATE}`)).status, 200);
            });

            it('summaries-only access exposes summaries/list but hides written entries', async () => {
                setAccess('summaries');
                assert.equal((await mcp('/api/diary')).status, 200);
                // summary/:date is 404 when absent, NOT 403 — the point is it's reachable.
                assert.notEqual((await mcp(`/api/diary/summary/${DATE}`)).status, 403);
                // the personal written entry stays private.
                assert.equal((await mcp(`/api/diary/entry/${DATE}`)).status, 403);
            });

            it('never gates the renderer (no MCP header), regardless of the flag', async () => {
                setAccess(false);
                assert.equal((await fetch(`${baseUrl}/api/diary`)).status, 200);
            });
        });
    });

    // ── Card health ───────────────────────────────────────────────────────
    //
    // The classifier's verdict logic is pinned by pure unit tests in
    // tests/cardHealth.test.js. What is exercised here is the part that only exists at
    // the HTTP layer: WHEN classification runs, and what addressing a card does to it.
    //
    // A card cannot accumulate a trajectory in a test run, so the ledger is seeded with
    // SQL — you cannot post forty days of review history through an endpoint that
    // timestamps everything `now`. Every transition after that goes through the real API.

    describe('Card health', () => {
        // A "long" answer in absolute terms (≥40 tokens), so the structural prior reads
        // as overloaded regardless of what the rest of the suite left in the vault.
        const LONG_ANSWER = Array.from({ length: 60 }, (_, i) => `term${i}`).join(' ');
        const DAY = 86400000;

        let hash;

        // Four lapse cycles across 44 days, each climbing back to a 4-day interval and
        // falling over again — the mouthful shape: an oscillating floor that never
        // leaves the learning band. Reviews land ON schedule so `overdue_drift` (which
        // would rightly suppress the verdict) has nothing to fire on.
        const seedOscillatingHistory = (cardHash) => {
            const id = db.prepare('SELECT id FROM Flashcards WHERE global_hash = ?').get(cardHash).id;
            const insert = db.prepare(`
                INSERT INTO ReviewLogs (flashcard_id, timestamp, outcome, ease_factor, level, algorithm)
                VALUES (?, ?, ?, 2.5, ?, 'leitner')
            `);
            const ago = (days) => new Date(Date.now() - days * DAY).toISOString();
            for (let c = 0; c < 4; c++) {
                const base = 44 - c * 11;
                insert.run(id, ago(base), 0, 1);        // lapse → box 1
                insert.run(id, ago(base - 1), 1, 2);    // +1d  (interval 1)
                insert.run(id, ago(base - 3), 1, 3);    // +2d  (interval 2)
                insert.run(id, ago(base - 7), 1, 3);    // +4d  (interval 4) — the peak
            }
            db.prepare('UPDATE Flashcards SET level = 3, last_recall = ? WHERE id = ?')
                .run(ago(4), id);
            // Baselines and session segmentation are cached for a minute; the rows above
            // appeared behind the cache's back.
            cardHealth.resetCaches();
        };

        const fail = () => post(`${baseUrl}/api/srs/review`, {
            flashcardHash: hash, outcome: 0, easeFactor: 2.5, newLevel: 1, algorithm: 'leitner',
        });
        const pass = (newLevel) => post(`${baseUrl}/api/srs/review`, {
            flashcardHash: hash, outcome: 1, easeFactor: 2.5, newLevel, algorithm: 'leitner',
        });
        const flagsOf = async () =>
            (await (await fetch(`${baseUrl}/api/flashcards/${hash}/detail`)).json()).flags;
        const healthRow = () => db.prepare(`
            SELECT ch.* FROM CardHealth ch
            JOIN Flashcards f ON f.id = ch.flashcard_id WHERE f.global_hash = ?
        `).get(hash);

        // Each test starts from a card with the same seeded history and no flags.
        const freshCard = async () => {
            const res = await post(`${baseUrl}/api/flashcards`, {
                frontText: 'What are the sixty terms?', backText: LONG_ANSWER, cardType: 'basic',
            });
            hash = (await res.json()).globalHash;
            seedOscillatingHistory(hash);
        };

        it('raises a flag on a failing review and reports it in the same response', async () => {
            await freshCard();
            const body = await (await fail()).json();
            assert.equal(body.ok, true);
            assert.ok(Array.isArray(body.flags), 'the review response carries flags');
            assert.deepEqual(body.flags.map(f => f.kind), ['mouthful']);

            const flag = body.flags[0];
            assert.equal(flag.evidence.trajectory, 'oscillating');
            assert.equal(flag.evidence.prior, 'overloaded');
            // Leitner has no difficulty signal, so the verdict is capped and says so.
            assert.equal(flag.evidence.memoryModel, 'approximated');
            assert.equal(flag.confidence, 'moderate');
            assert.ok(flag.title && flag.action, 'a flag always names what to do about it');
        });

        it('serves the same flag from the card detail payload', async () => {
            const flags = await flagsOf();
            assert.deepEqual(flags.map(f => f.kind), ['mouthful']);
        });

        // The lightweight read the MCP server uses: same flags, none of the ledger and
        // retention curve that `/detail` wraps around them.
        it('serves the same flag from /flags, without the rest of the detail payload', async () => {
            const res = await fetch(`${baseUrl}/api/flashcards/${hash}/flags`);
            assert.equal(res.status, 200);
            const body = await res.json();
            assert.deepEqual(Object.keys(body), ['flags'], 'nothing but the flags');
            assert.deepEqual(body.flags, await flagsOf(), 'byte-identical to what /detail reports');
            assert.ok(body.flags[0].evidence.peaks.length, 'the evidence travels with it');
        });

        it('GET /flags 404s on an unknown card instead of calling it healthy', async () => {
            const res = await fetch(`${baseUrl}/api/flashcards/no-such-card/flags`);
            assert.equal(res.status, 404);
        });

        it('a passing review below the recovery level does NOT clear it', async () => {
            // The whole point: a mouthful passes constantly at a short interval. Treating
            // any pass as success would make the flag unreachable.
            await pass(2);
            assert.deepEqual((await flagsOf()).map(f => f.kind), ['mouthful']);
        });

        it('a passing review that reaches the recovery level clears it and restarts the window', async () => {
            await pass(3);
            assert.deepEqual(await flagsOf(), []);
            assert.equal(healthRow().epoch_reason, 'recovered');
            assert.ok(healthRow().epoch_at, 'the analysis window is stamped, not just cleared');
        });

        it('does not re-raise from history that predates the recovery', async () => {
            // Everything before the epoch stops being evidence, so one new failure is
            // nowhere near the gates.
            const body = await (await fail()).json();
            assert.deepEqual(body.flags, []);
        });

        it('editing a card clears its flags and restarts the window', async () => {
            await freshCard();
            await fail();
            assert.equal((await flagsOf()).length, 1);

            const res = await put(`${baseUrl}/api/flashcards/${hash}`, { backText: 'short' });
            assert.equal(res.status, 200);
            assert.deepEqual(await flagsOf(), []);
            assert.equal(healthRow().epoch_reason, 'edit');
        });

        it('undoing a review re-classifies against what is left of the ledger', async () => {
            await freshCard();
            await fail();
            const raisedBy = db.prepare(`
                SELECT cf.review_log_id FROM CardFlags cf
                JOIN Flashcards f ON f.id = cf.flashcard_id WHERE f.global_hash = ?
            `).get(hash).review_log_id;

            await post(`${baseUrl}/api/srs/undo`, { flashcardHash: hash, algorithm: 'leitner' });

            // The flag SURVIVES, and that is the honest answer: forty-four days of
            // oscillating history say what they say whether or not today's failure is
            // retracted. What must not survive is the flag pointing at a review that no
            // longer exists.
            const [flag] = await flagsOf();
            assert.equal(flag.kind, 'mouthful');
            const now = db.prepare(`
                SELECT cf.review_log_id FROM CardFlags cf
                JOIN Flashcards f ON f.id = cf.flashcard_id WHERE f.global_hash = ?
            `).get(hash).review_log_id;
            assert.notEqual(now, raisedBy, 're-evaluated rather than left stale');
            assert.ok(db.prepare('SELECT 1 FROM ReviewLogs WHERE id = ?').get(now),
                'the flag cites a review that still exists');
        });

        it('undo withdraws a flag that rested only on the undone review', async () => {
            // No seeded history: this card's flag exists solely because it failed twice
            // inside one session with an overloaded answer. Take one failure away and it
            // drops below the gates.
            const res = await post(`${baseUrl}/api/flashcards`, {
                frontText: 'Twice in a row', backText: LONG_ANSWER, cardType: 'basic',
            });
            hash = (await res.json()).globalHash;

            await fail();
            // Sessions are derived from review timestamps and cached for a minute; the
            // first failure landed behind that cache.
            cardHealth.resetCaches();
            assert.deepEqual((await (await fail()).json()).flags.map(f => f.kind), ['mouthful']);

            cardHealth.resetCaches();
            await post(`${baseUrl}/api/srs/undo`, { flashcardHash: hash, algorithm: 'leitner' });
            assert.deepEqual(await flagsOf(), [], 'one failure is not a diagnosis');
        });

        it('dismissing a flag suppresses it without silencing the classifier', async () => {
            await freshCard();
            await fail();

            const res = await post(`${baseUrl}/api/flashcards/${hash}/flags/mouthful/dismiss`, {});
            assert.equal(res.status, 200);
            assert.deepEqual((await res.json()).flags, []);

            // Still suppressed after the card fails again — that is what "sticky" means.
            const again = await (await fail()).json();
            assert.deepEqual(again.flags, []);
            const row = db.prepare(`
                SELECT cf.dismissed_at FROM CardFlags cf
                JOIN Flashcards f ON f.id = cf.flashcard_id
                WHERE f.global_hash = ? AND cf.kind = 'mouthful'
            `).get(hash);
            assert.ok(row?.dismissed_at, 'the row is suppressed, not deleted');
        });

        it('editing a dismissed card un-suppresses it — a rewrite gets judged fresh', async () => {
            await put(`${baseUrl}/api/flashcards/${hash}`, { backText: `${LONG_ANSWER} extra` });
            const row = db.prepare(`
                SELECT COUNT(*) AS c FROM CardFlags cf
                JOIN Flashcards f ON f.id = cf.flashcard_id WHERE f.global_hash = ?
            `).get(hash);
            assert.equal(row.c, 0, 'the dismissed row is gone, not merely hidden');
        });

        it('400s an unknown flag kind, 404s a flag the card does not carry', async () => {
            await freshCard();
            assert.equal((await post(`${baseUrl}/api/flashcards/${hash}/flags/nonsense/dismiss`, {})).status, 400);
            assert.equal((await post(`${baseUrl}/api/flashcards/${hash}/flags/probe/dismiss`, {})).status, 404);
        });

        it('never flags a card that is passing — classification runs on failure only', async () => {
            const res = await post(`${baseUrl}/api/flashcards`, {
                frontText: 'Healthy card', backText: LONG_ANSWER, cardType: 'basic',
            });
            const healthy = (await res.json()).globalHash;
            seedOscillatingHistory(healthy);   // an identically ugly history…
            // …but the card passes, so nothing is computed and nothing is said.
            const body = await (await post(`${baseUrl}/api/srs/review`, {
                flashcardHash: healthy, outcome: 1, easeFactor: 2.5, newLevel: 2, algorithm: 'leitner',
            })).json();
            assert.deepEqual(body.flags, []);
            const detail = await (await fetch(`${baseUrl}/api/flashcards/${healthy}/detail`)).json();
            assert.deepEqual(detail.flags, []);
        });

        it('GET /api/decks/cards?flagged=1 lists flagged cards, with a matching total', async () => {
            await freshCard();
            await fail();

            const all = await (await fetch(`${baseUrl}/api/decks/cards?limit=200`)).json();
            const res = await (await fetch(`${baseUrl}/api/decks/cards?flagged=1&limit=200`)).json();

            assert.ok(res.cards.length >= 1);
            assert.ok(res.cards.length < all.total, 'the filter actually excludes something');
            assert.equal(res.total, res.cards.length, 'total agrees with the rows');
            assert.ok(res.cards.every(c => c.flags), 'every row carries its flag kinds');
            assert.ok(res.cards.some(c => c.global_hash === hash));
        });

        it('filters by flag kind, and a kind nothing carries returns nothing', async () => {
            const mouthfuls = await (await fetch(`${baseUrl}/api/decks/cards?flagKind=mouthful&limit=200`)).json();
            assert.ok(mouthfuls.cards.some(c => c.global_hash === hash));

            const probes = await (await fetch(`${baseUrl}/api/decks/cards?flagKind=probe&limit=200`)).json();
            assert.equal(probes.total, 0);
        });
    });

});
