import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs/promises';
import fsSync from 'fs';
import AdmZip from 'adm-zip';
import validate from '../../src/api/config/validate.js';
import { sealTools } from '../../src/api/seal/seal.js';
import db from '../../src/api/access/database.js';
import Api from '../../src/api/api.js';

process.env.USER_DATA_PATH = path.join(process.cwd(), 'data');

let baseUrl;
let api;

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

describe('Flashback API', () => {

    before(async () => {
        if (!validate()) throw new Error('Validation failed');
        await sealTools.init();
        api = new Api({ port: 0, logFormat: 'tiny' });
        const server = await api.start();
        baseUrl = `http://localhost:${server.address().port}`;
    });

    after(async () => {
        await api.stop();
        db.close();
        const dataPath = path.join(process.cwd(), 'data');
        if (fsSync.existsSync(dataPath)) {
            await fs.rm(dataPath, { recursive: true, force: true });
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
            assert.equal(metadata.flashcards[0].vanillaData.media.frontSound, './media/narration.mp3');
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

});
