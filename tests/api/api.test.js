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

const API_TOKEN = 'test-api-token-0123456789abcdef';
const rawFetch = globalThis.fetch;


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


import { getWorkspacePath } from '../../src/api/access/primitives/config.js';

describe('Flashback API', () => {

    before(async () => {
        if (!await validate()) throw new Error('Validation failed');
        await db.exec(`
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


    describe('Authentication', () => {
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

        it('resolves the configured token to the Author account', async () => {
            const res = await rawFetch(`${baseUrl}/api/accounts`, {
                headers: { Authorization: `Bearer ${API_TOKEN}` },
            });
            assert.equal(res.status, 200);
            const body = await res.json();
            assert.equal(body.you.role, 'author');
        });
    });


    describe('Roles', () => {
        let readerToken;
        let readerTokenId;

        before(async () => {
            const created = await (await post(`${baseUrl}/api/accounts`, {
                name: 'Rita Reader', email: `rita-${Date.now()}@example.com`, role: 'reader',
            })).json();
            const issued = await (await post(`${baseUrl}/api/accounts/${created.id}/tokens`, {
                label: 'test',
            })).json();
            readerToken = issued.token;
            readerTokenId = issued.id;
            assert.ok(readerToken, 'a token must come back in plaintext exactly once');
        });

        const asReader = (url, opts = {}) =>
            rawFetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${readerToken}` } });

        it('lets a reader read a document listing', async () => {
            const res = await asReader(`${baseUrl}/api/documents/list?path=`);
            assert.equal(res.status, 200);
        });

        it('refuses a reader creating a folder → 403 naming the role needed', async () => {
            const res = await asReader(`${baseUrl}/api/documents/folder`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'ReaderShouldNotCreateThis' }),
            });
            assert.equal(res.status, 403);
            const body = await res.json();
            assert.equal(body.required, 'admin');
            assert.equal(body.role, 'reader');
        });

        it('refuses a reader reaching the access panel at all', async () => {
            const res = await asReader(`${baseUrl}/api/accounts`);
            assert.equal(res.status, 403);
        });

        it("refuses a reader looking at anyone else's progress or graph", async () => {
            const { accounts } = await (await fetch(`${baseUrl}/api/accounts`)).json();
            const author = accounts.find((a) => a.role === 'author');
            for (const leaf of ['progress', 'graph']) {
                const res = await asReader(`${baseUrl}/api/accounts/${author.id}/${leaf}`);
                assert.equal(res.status, 403, leaf);
                assert.equal((await res.json()).required, 'admin');
            }
        });

        it('refuses a reader rolling the vault back', async () => {
            const res = await asReader(`${baseUrl}/api/seal/log`);
            assert.equal(res.status, 403);
        });

        it('stops accepting a revoked token → 401, not 403', async () => {
            const res = await del(`${baseUrl}/api/accounts/tokens/${readerTokenId}`, {});
            assert.equal(res.status, 200);

            const after = await asReader(`${baseUrl}/api/documents/list?path=`);
            assert.equal(after.status, 401);
        });
    });


    describe('CORS', () => {
        const probe = () => `${baseUrl}/api/documents/list?path=`;

        it('lets a request with no Origin through — the MCP/Node path', async () => {
            const res = await rawFetch(probe(), { headers: { Authorization: `Bearer ${API_TOKEN}` } });
            assert.equal(res.status, 200);
            assert.equal(res.headers.get('access-control-allow-origin'), null,
                'nothing to echo when the caller sent no Origin');
        });

        it('echoes an allowed origin and varies on it', async () => {
            const res = await rawFetch(probe(), {
                headers: { Authorization: `Bearer ${API_TOKEN}`, Origin: 'http://localhost:51234' },
            });
            assert.equal(res.status, 200);
            assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:51234');
            assert.match(res.headers.get('vary') ?? '', /Origin/);
        });

        it('treats the packaged renderer\'s opaque file:// origin as allowed', async () => {
            const res = await rawFetch(probe(), {
                headers: { Authorization: `Bearer ${API_TOKEN}`, Origin: 'null' },
            });
            assert.equal(res.status, 200);
            assert.equal(res.headers.get('access-control-allow-origin'), 'null');
        });

        it('refuses a foreign origin outright', async () => {
            const res = await rawFetch(probe(), {
                headers: { Authorization: `Bearer ${API_TOKEN}`, Origin: 'https://evil.example' },
            });
            assert.equal(res.status, 403);
            assert.equal(res.headers.get('access-control-allow-origin'), null);
        });

        it('answers an allowed preflight WITHOUT a token', async () => {
            const res = await rawFetch(probe(), {
                method: 'OPTIONS',
                headers: {
                    Origin: 'http://localhost:51234',
                    'Access-Control-Request-Method': 'GET',
                    'Access-Control-Request-Headers': 'authorization',
                },
            });
            assert.equal(res.status, 204);
            assert.match(res.headers.get('access-control-allow-headers') ?? '', /Authorization/i);
            assert.match(res.headers.get('access-control-allow-headers') ?? '', /X-Flashback-Client/i);
        });

        it('rejects a foreign preflight with 403 rather than a silent failure', async () => {
            const res = await rawFetch(probe(), {
                method: 'OPTIONS',
                headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' },
            });
            assert.equal(res.status, 403);
        });
    });


    describe('Vault', () => {
        it('describes itself with both version ladders — the remote handshake', async () => {
            const res = await fetch(`${baseUrl}/api/vault`);
            assert.equal(res.status, 200);
            const body = await res.json();

            assert.ok(body.vaultId, 'a vault must have a stable id');
            assert.equal(typeof body.vaultName, 'string');
            assert.ok(body.schemaVersion > 0);
            assert.equal(typeof body.canonicalVersion, 'number');
            assert.ok(Array.isArray(body.capabilities));
        });

        it('lists the registered vaults and marks the active one', async () => {
            const res = await fetch(`${baseUrl}/api/vault/list`);
            assert.equal(res.status, 200);
            const body = await res.json();
            assert.ok(Array.isArray(body.vaults));
            assert.ok(body.vaults.length >= 1, 'an un-migrated config still reports one vault');
        });

        it('refuses a switch with no vault name', async () => {
            const res = await post(`${baseUrl}/api/vault/switch`, {});
            assert.equal(res.status, 400);
        });
    });

    describe('Remotes', () => {
        it('lists remotes and never returns a credential', async () => {
            const res = await fetch(`${baseUrl}/api/remotes`);
            assert.equal(res.status, 200);
            const body = await res.json();
            assert.ok(Array.isArray(body.remotes));
            for (const r of body.remotes) {
                assert.equal(typeof r.hasToken, 'boolean');
                assert.ok(!('token' in r) && !('tokenEnc' in r),
                    'a token must never leave the Electron main process');
            }
        });
    });

    describe('Identity', () => {
        it('reports who new work is stamped as, and where that came from', async () => {
            const res = await fetch(`${baseUrl}/api/identity`);
            assert.equal(res.status, 200);

            const body = await res.json();
            assert.equal(typeof body.name, 'string');
            assert.equal(typeof body.email, 'string');
            assert.ok(['vault', 'global', 'default'].includes(body.source),
                `unexpected identity source: ${body.source}`);
            assert.equal(body.author, `${body.name} <${body.email}>`);
        });

        it('offers no way to write an identity over HTTP', async () => {
            for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
                const res = await fetch(`${baseUrl}/api/identity`, {
                    method,
                    headers: { 'Content-Type': 'application/json' },
                    body: method === 'DELETE' ? undefined
                        : JSON.stringify({ name: 'Someone Else', email: 'x@y.test' }),
                });
                assert.equal(res.status, 404, `${method} /api/identity should not be routed`);
            }

            const after = await (await fetch(`${baseUrl}/api/identity`)).json();
            assert.notEqual(after.name, 'Someone Else');
        });
    });


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

        it('document covers: pattern, upload into media/, survives a metadata write, reposition, replace, remove', async () => {
            await createFile('covered.md', ROOT);
            const docPath = `${ROOT}/covered.md`;
            const mediaDir = path.join(getWorkspacePath(), ROOT, 'media');
            const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
            const uploadCover = (bytes, type) => {
                const form = new FormData();
                form.append('path', docPath);
                form.append('file', new Blob([bytes], { type }), 'cover');
                return fetch(`${baseUrl}/api/documents/cover`, { method: 'POST', body: form });
            };
            const sidecar = async () => (await (await fetch(`${baseUrl}/api/documents/read?path=${encodeURIComponent(docPath)}`)).json()).metadata;

            assert.equal((await put(`${baseUrl}/api/documents/cover`, { path: docPath, pattern: 'arcs' })).status, 200);
            assert.deepEqual((await sidecar()).cover, { kind: 'pattern', pattern: 'arcs' });
            assert.equal((await put(`${baseUrl}/api/documents/cover`, { path: docPath, pattern: 'plaid' })).status, 400);
            assert.equal((await put(`${baseUrl}/api/documents/cover`, { path: docPath, y: 0.3 })).status, 404, 'a drawn cover cannot be repositioned');

            assert.equal((await uploadCover('nope', 'text/plain')).status, 400);
            const up = await uploadCover(png, 'image/png');
            assert.equal(up.status, 201);
            const first = (await up.json()).cover;
            assert.ok(fsSync.existsSync(path.join(mediaDir, first.file)), 'the image sits in the folder\'s media/');
            const served = await fetch(`${baseUrl}/api/media/file?docPath=${encodeURIComponent(docPath)}&name=${encodeURIComponent(first.file)}`);
            assert.equal(served.status, 200);

            const meta = await sidecar();
            delete meta.cover;
            assert.equal((await put(`${baseUrl}/api/documents/metadata`, { path: docPath, metadata: { ...meta, tags: ['covered'] } })).status, 200);
            assert.equal((await sidecar()).cover?.file, first.file, 'a whole-object metadata write keeps the cover');
            assert.equal((await updateFile(docPath, '# Covered', { ...meta, cover: null })).status, 200);
            assert.equal((await sidecar()).cover?.file, first.file, 'a body save with its sidecar keeps the cover too');

            assert.equal((await (await put(`${baseUrl}/api/documents/cover`, { path: docPath, y: 0.8 })).json()).cover.y, 0.8);

            const second = (await (await uploadCover(png, 'image/png')).json()).cover;
            assert.ok(!fsSync.existsSync(path.join(mediaDir, first.file)), 'the replaced image is deleted');

            const del = await fetch(`${baseUrl}/api/documents/cover`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: docPath }) });
            assert.equal(del.status, 200);
            assert.equal((await sidecar()).cover, undefined);
            assert.ok(!fsSync.existsSync(path.join(mediaDir, second.file)));

            assert.equal((await put(`${baseUrl}/api/documents/cover`, { path: `${ROOT}/nope.md`, pattern: 'cards' })).status, 404);
        });

        it('PUT /api/documents/file → updates content and flashcards', async () => {
            const res = await updateFile(`${ROOT}/note.md`, '# Hello API', {
                tags: ['api'],
                flashcards: [{ globalHash: FC_HASH, vanillaData: { frontText: 'Q?', backText: 'A!' } }]
            });
            assert.equal(res.status, 200);
        });

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

        it('GET /api/documents/tags/overview → each tag with where it is used and the cards it reaches', async () => {
            const res = await fetch(`${baseUrl}/api/documents/tags/overview`);
            assert.equal(res.status, 200);
            const { tags } = await res.json();
            assert.ok(Array.isArray(tags));
            const api = tags.find(t => t.name === 'api');
            assert.ok(api, 'the tag applied to renamed.md is listed');
            assert.ok(api.documents >= 1, 'it counts the document carrying it');
            assert.ok(api.cards >= 1, 'and the card that inherits it from that document');
            for (const key of ['folders', 'decks', 'cardsDirect']) {
                assert.equal(typeof api[key], 'number', `${key} is a number`);
            }
        });

        it('GET /api/decks/cards?tag= keeps the cards carrying the tag, inherited included', async () => {
            const tagged = await (await fetch(`${baseUrl}/api/decks/cards?tag=api&limit=200`)).json();
            assert.ok(tagged.cards.some(c => c.global_hash === FC_HASH), 'the card inherits "api" from its document');
            const none = await (await fetch(`${baseUrl}/api/decks/cards?tag=no-such-tag&limit=200`)).json();
            assert.equal(none.total, 0);
        });

        it('POST /api/documents/tags/rename → renames a tag everywhere it is written', async () => {
            const res = await post(`${baseUrl}/api/documents/tags/rename`, { from: 'api', to: 'api-renamed' });
            assert.equal(res.status, 200);
            const body = await res.json();
            assert.equal(body.to, 'api-renamed');
            assert.ok(body.sidecars >= 1, 'renamed.md’s sidecar was rewritten');

            const { tags } = await (await fetch(`${baseUrl}/api/documents/tags`)).json();
            assert.ok(tags.includes('api-renamed') && !tags.includes('api'));
            const doc = await (await fetch(`${baseUrl}/api/documents/read?path=${encodeURIComponent(`${ROOT}/renamed.md`)}`)).json();
            assert.deepEqual(doc.metadata.tags, ['api-renamed']);

            const back = await post(`${baseUrl}/api/documents/tags/rename`, { from: 'api-renamed', to: 'api' });
            assert.equal(back.status, 200, 'and renames it back for the tests that follow');
        });

        it('POST /api/documents/tags/rename with to: null → removes the tag', async () => {
            const res = await post(`${baseUrl}/api/documents/tags/rename`, { from: 'viewer-only', to: null });
            assert.equal(res.status, 200);
            const doc = await (await fetch(`${baseUrl}/api/documents/read?path=${encodeURIComponent(`${ROOT}/data.json`)}`)).json();
            assert.ok(!(doc.metadata.tags ?? []).includes('viewer-only'));
        });

        it('POST /api/documents/tags/rename → 400 without a from, or with an empty to', async () => {
            assert.equal((await post(`${baseUrl}/api/documents/tags/rename`, { to: 'x' })).status, 400);
            assert.equal((await post(`${baseUrl}/api/documents/tags/rename`, { from: 'api', to: '  ' })).status, 400);
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
            const res = await createFolder('SubA', ROOT);
            assert.equal(res.status, 409);
        });

        it('POST /api/documents/file → 409 when file already exists', async () => {
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

        it('GET /api/media/list → refuses a path that climbs out of the workspace', async () => {
            for (const p of ['../../..', '../../../../../..', '..\\..\\..']) {
                const res = await fetch(`${baseUrl}/api/media/list?path=${encodeURIComponent(p)}`);
                assert.equal(res.status, 400, `${p} should be refused, not listed`);
                assert.match((await res.json()).error, /traversal/i);
            }
        });

        it('GET /api/media/list → does not report where the vault sits on disk', async () => {
            const res = await fetch(`${baseUrl}/api/media/list?path=${encodeURIComponent(ROOT)}`);
            const items = await res.json();
            assert.ok(items.length > 0, 'precondition: the folder has media');
            for (const item of items) {
                assert.ok(!('absolutePath' in item), 'absolutePath must not cross the HTTP boundary');
                assert.ok(item.relativePath, 'relativePath is what a client addresses an asset by');
            }
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

        it('GET /api/srs/stats → carries the mastery summary the sidebar reads', async () => {
            const res = await fetch(`${baseUrl}/api/srs/stats`);
            const stats = await res.json();

            assert.equal(typeof stats.masteryPercentage, 'number',
                'the field the Flashcards sidebar renders is actually sent');
            assert.equal(typeof stats.mastered, 'number');
            assert.equal(stats.masteryLevel, 5, 'and says which cutoff it counted');
            assert.ok(stats.mastered <= stats.total, 'mastered cards are a subset of all cards');

            const expected = stats.total > 0 ? (stats.mastered / stats.total) * 100 : 0;
            assert.equal(stats.masteryPercentage, expected,
                'the percentage is of the whole vault, not of the cards already studied');
        });

        it('GET /api/srs/stats → counts a card pushed past the cutoff', async () => {
            const before = await (await fetch(`${baseUrl}/api/srs/stats`)).json();

            await post(`${baseUrl}/api/srs/review`, {
                path: `${ROOT}/${DOC}`, flashcardHash: FC_HASH,
                outcome: 1, easeFactor: 2.5, newLevel: before.masteryLevel + 1,
            });

            const after = await (await fetch(`${baseUrl}/api/srs/stats`)).json();
            assert.ok(after.mastered > before.mastered,
                'a card taken above the cutoff joins the mastered count');
            assert.ok(after.masteryPercentage > 0,
                'so the sidebar can no longer be stuck at zero');
        });

        it('GET /api/srs/statistics → carries a vault completeness block', async () => {
            const res = await fetch(`${baseUrl}/api/srs/statistics`);
            assert.equal(res.status, 200);
            const stats = await res.json();

            const c = stats.completeness;
            assert.ok(c, 'statistics carries a completeness block');
            assert.ok(c.percent === null || (c.percent >= 0 && c.percent <= 1),
                'the headline is a fraction or nothing at all');
            assert.equal(c.known.cards, stats.totals.cards,
                'the known half counts every card in the vault');
            assert.equal(c.known.mature, stats.maturity.mature,
                'and reuses the maturity partition rather than recounting');
            assert.equal(
                c.read.documents,
                c.read.finished + c.read.inProgress + c.read.unread,
                'every document is in exactly one reading state',
            );

            assert.ok(stats.acquisition, 'the learning-phase block is untouched');
            assert.ok(!('percent' in stats.acquisition), 'and is a different shape entirely');
        });

        it('GET /api/srs/statistics → counts the cards in each gap band', async () => {
            const stats = await (await fetch(`${baseUrl}/api/srs/statistics`)).json();
            assert.ok(stats.bands && typeof stats.bands === 'object', 'statistics carries bands');
            for (const n of Object.values(stats.bands)) assert.equal(typeof n, 'number');
        });

        it('GET /api/srs/statistics → its read half agrees with /api/progress/rollup', async () => {
            const [statsRes, rollupRes] = await Promise.all([
                fetch(`${baseUrl}/api/srs/statistics`),
                fetch(`${baseUrl}/api/progress/rollup?path=`),
            ]);
            const { completeness } = await statsRes.json();
            const rollup = await rollupRes.json();

            assert.equal(completeness.read.documents, rollup.total);
            assert.equal(completeness.read.finished, rollup.finished);
            assert.equal(
                completeness.read.percent,
                rollup.total > 0 ? rollup.percent : null,
            );
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

        it('POST /api/srs/review → returns the gap before and after the grade', async () => {
            const grade = (body) => post(`${baseUrl}/api/srs/review`, { path: `${ROOT}/${DOC}`, flashcardHash: FC_HASH, ...body });
            await grade({ outcome: 1, easeFactor: 2.5, newLevel: 3 });
            const leitner = await (await grade({ outcome: 1, easeFactor: 2.5, newLevel: 4 })).json();
            assert.deepEqual(leitner.interval, { before: 4, after: 8 });

            const fsrsRes = await (await grade({ algorithm: 'fsrs', rating: 3 })).json();
            assert.ok(fsrsRes.interval, 'an FSRS review reports its interval too');
            assert.equal(typeof fsrsRes.interval.after, 'number');
            assert.ok(fsrsRes.interval.after > 0);
        });

        it('GET /api/srs/due?algorithm=fsrs → previews the gap each grade would give', async () => {
            const res = await fetch(`${baseUrl}/api/srs/due?algorithm=fsrs&retention=0.9`);
            assert.equal(res.status, 200);
            const { queue, preview } = await res.json();
            assert.ok(queue.length > 0, 'need a due card to preview');
            for (const card of queue) {
                const p = preview[card.global_hash];
                assert.ok(p, `a preview for ${card.global_hash}`);
                for (const g of ['again', 'hard', 'good', 'easy']) assert.equal(typeof p[g], 'number');
                assert.ok(p.again <= p.good && p.good <= p.easy, 'a better grade never gives a shorter gap');
            }
            const leitner = await (await fetch(`${baseUrl}/api/srs/due?algorithm=leitner`)).json();
            assert.equal(leitner.preview, null, 'Leitner and SM-2 are previewed in the renderer, from the shared maths');
        });

        it('POST /api/srs/review → accepts a session and records ordering telemetry', async () => {
            const dueRes = await fetch(`${baseUrl}/api/srs/due`);
            const { sessionId, queue } = await dueRes.json();
            assert.ok(sessionId, '/due must issue a sessionId');
            assert.ok(queue.length >= 2, 'need at least two cards to measure a distance');

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

            const rows = await db.prepare(
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

            const again = await (await fetch(`${baseUrl}/api/srs/due?seed=1234`)).json();
            assert.deepEqual(
                again.queue.map(c => c.global_hash),
                body.queue.map(c => c.global_hash),
            );
        });

        it('GET /api/srs/due → folder/tag scoping reaches the sequenced queue, not just due/new', async () => {
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

            for (const order of ['interleaved', 'shuffle', 'priority']) {
                const inScope = await fetchScoped(`folder=${encodeURIComponent(SCOPE_ROOT)}&order=${order}`);
                assert.ok(inScope.includes(SCOPE_HASH),
                    `${order}: folder-scoped queue must contain the folder's own card`);
                assert.ok(!inScope.includes(FC_HASH),
                    `${order}: folder-scoped queue must not leak a card from ${ROOT}`);
            }

            const tagRow = await db.prepare('SELECT id FROM Tags WHERE name = ?').get(SCOPE_TAG);
            const cardNode = await db.prepare('SELECT node_id FROM Flashcards WHERE global_hash = ?').get(SCOPE_HASH);
            assert.ok(tagRow && cardNode?.node_id, 'precondition: tagged document and its card exist');
            const inheritEdge = await db.prepare(`
                SELECT id FROM Connections
                WHERE destiny_id = ?
                  AND type_id = (SELECT id FROM ConnectionTypes WHERE name = 'inheritance')
            `).get(cardNode.node_id);
            assert.ok(inheritEdge, 'precondition: the card inherits from its document');
            await db.prepare('INSERT INTO InheritedTags (connection_id, tag_id) VALUES (?, ?)')
                .run(inheritEdge.id, tagRow.id);

            const tagged = await fetchScoped(`tag=${encodeURIComponent(SCOPE_TAG)}`);
            assert.ok(tagged.includes(SCOPE_HASH), 'tag-scoped queue must contain the tagged card');
            assert.ok(!tagged.includes(FC_HASH), 'tag-scoped queue must not leak an untagged card');
        });

        const tierFixture = () => Array.from({ length: 12 }, (_, i) => ({
            global_hash: `tier-card-${i}`,
            category_priority: i % 3,
            level: 5,
        }));
        const isNonDecreasing = (xs) => xs.every((x, i) => i === 0 || xs[i - 1] <= x);

        for (const order of ['interleaved', 'shuffle']) {
            it(`sequencer.sequence(order=${order}) → keeps pedagogical tiers in priority order`, async () => {
                const { queue } = await sequence({ due: tierFixture(), order, seed: 7 });
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
            assert.deepEqual(
                body.queue.map(c => c.global_hash),
                [...body.due, ...body.new].map(c => c.global_hash),
            );
        });

        it('GET /api/srs/due → returns due and new card lists with card_type', async () => {
            const DUE_DOC = 'due-test.md';
            const DUE_HASH = 'srs-due-cloze-001';
            const NEW_HASH = 'srs-new-type-answer-001';
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
            const res = await fetch(`${baseUrl}/api/srs/due?folder=${encodeURIComponent(ROOT)}`);
            assert.equal(res.status, 200);
            const body = await res.json();
            assert.ok('nextDue' in body, 'Response must include a nextDue field');
            assert.notEqual(body.nextDue, undefined, 'nextDue must not be undefined');
            assert.ok(body.nextDue !== null,
                'nextDue must be non-null when a card has a future due date (23-hour card)');
        });
    });


    describe('Session scoping — exclusions and the read gate', () => {
        const ROOT = 'ScopeExclTest';
        const IMPORT = `${ROOT}/Import`;
        const KEEP = 'excl-keep-001';
        const DUMP_A = 'excl-dump-001';
        const DUMP_B = 'excl-dump-002';
        const EARLY = 'excl-read-early';
        const LATE = 'excl-read-late';
        let soloHash, taggedSoloHash, deckHash;

        const dueSet = async (qs) => {
            const res = await fetch(`${baseUrl}/api/srs/due?maxNew=200${qs ? '&' + qs : ''}`);
            assert.equal(res.status, 200, `?${qs} should succeed`);
            const body = await res.json();
            return new Set(body.queue.map(c => c.global_hash));
        };

        before(async () => {
            await createFolder(ROOT);
            await createFolder('Import', ROOT);

            await createFile('keep.md', ROOT);
            await updateFile(`${ROOT}/keep.md`, '# Keep', {
                flashcards: [{ globalHash: KEEP, vanillaData: { frontText: 'Keep', backText: 'A' } }],
            });

            await createFile('dump.md', IMPORT);
            await updateFile(`${IMPORT}/dump.md`, '# Dump', {
                flashcards: [
                    { globalHash: DUMP_A, vanillaData: { frontText: 'Dump A', backText: 'A' } },
                    { globalHash: DUMP_B, vanillaData: { frontText: 'Dump B', backText: 'A' } },
                ],
            });

            soloHash = (await (await post(`${baseUrl}/api/flashcards`, {
                frontText: 'Solo Q', backText: 'A', cardType: 'basic',
            })).json()).globalHash;
            taggedSoloHash = (await (await post(`${baseUrl}/api/flashcards`, {
                frontText: 'Tagged solo Q', backText: 'A', cardType: 'basic', tags: ['excl-tag'],
            })).json()).globalHash;

            deckHash = (await (await post(`${baseUrl}/api/decks`, { name: 'Excludable Deck' })).json()).globalHash;
            await post(`${baseUrl}/api/decks/${deckHash}/entries`, {
                cardHash: DUMP_A, documentPath: `${IMPORT}/dump.md`,
            });

            await createFile('read.md', ROOT);
            await updateFile(`${ROOT}/read.md`, undefined, {
                highlights: [
                    { id: 'hl-excl-early', type: 'pdf_bbox', page: 5, color: 'amber', text: 'early' },
                    { id: 'hl-excl-late', type: 'pdf_bbox', page: 300, color: 'amber', text: 'late' },
                ],
                flashcards: [
                    { globalHash: EARLY, vanillaData: { frontText: 'Early', backText: 'A', location: { type: 'highlight', id: 'hl-excl-early' } } },
                    { globalHash: LATE, vanillaData: { frontText: 'Late', backText: 'A', location: { type: 'highlight', id: 'hl-excl-late' } } },
                ],
            });
            await put(`${baseUrl}/api/progress`, {
                path: `${ROOT}/read.md`, unit: 'page', position: { page: 50 }, total: 300,
            });
        });

        it('excludeFolder removes a subtree — and keeps standalone cards', async () => {
            const q = await dueSet(`excludeFolder=${encodeURIComponent(IMPORT)}`);
            assert.ok(!q.has(DUMP_A) && !q.has(DUMP_B), 'the excluded subtree is gone');
            assert.ok(q.has(KEEP), 'a sibling folder is untouched');
            assert.ok(q.has(soloHash), 'a card in no folder cannot be in the excluded one');
        });

        it('excludeFolder reaches descendants, not just the named folder', async () => {
            const q = await dueSet(`excludeFolder=${encodeURIComponent(ROOT)}`);
            assert.ok(!q.has(KEEP) && !q.has(DUMP_A), 'the whole tree goes');
            assert.ok(q.has(soloHash));
        });

        it('excludeDocument removes one file and nothing around it', async () => {
            const q = await dueSet(`excludeDocument=${encodeURIComponent(`${IMPORT}/dump.md`)}`);
            assert.ok(!q.has(DUMP_A) && !q.has(DUMP_B));
            assert.ok(q.has(KEEP) && q.has(soloHash));
        });

        it('takes several exclusions at once', async () => {
            const q = await dueSet(
                `excludeDocument=${encodeURIComponent(`${IMPORT}/dump.md`)}` +
                `&excludeDocument=${encodeURIComponent(`${ROOT}/keep.md`)}`,
            );
            assert.ok(!q.has(DUMP_A) && !q.has(DUMP_B) && !q.has(KEEP));
            assert.ok(q.has(soloHash));
        });

        it('excludeDeck removes a deck\'s cards only', async () => {
            const q = await dueSet(`excludeDeck=${encodeURIComponent(deckHash)}`);
            assert.ok(!q.has(DUMP_A), 'the deck member is gone');
            assert.ok(q.has(DUMP_B), 'its neighbour in the same document stays');
        });

        it('excludeTag removes a tagged card only', async () => {
            const q = await dueSet('excludeTag=excl-tag');
            assert.ok(!q.has(taggedSoloHash), 'the tagged card is gone');
            assert.ok(q.has(soloHash) && q.has(KEEP), 'untagged cards stay');
        });

        it('document= scopes to a single file, the counterpart of folder=', async () => {
            const q = await dueSet(`document=${encodeURIComponent(`${ROOT}/keep.md`)}`);
            assert.deepEqual([...q], [KEEP],
                'a positive document scope is strict: a card in no document is not in this one');
        });

        it('read=only offers what is behind the mark and holds back what is ahead', async () => {
            const q = await dueSet('read=only');
            assert.ok(q.has(EARLY), 'page 5, read to page 50');
            assert.ok(!q.has(LATE), 'page 300, read to page 50');
            assert.ok(!q.has(KEEP), 'a document never opened contributes nothing');
            assert.ok(q.has(soloHash), 'a standalone card is drawn from no reading');

            const off = await dueSet('');
            assert.ok(off.has(LATE) && off.has(KEEP), 'and all of it comes back with the gate off');
        });

        it('read=only still fills the new-card allowance', async () => {
            await createFile('reachable.md', ROOT);
            const reachable = ['excl-r-1', 'excl-r-2', 'excl-r-3'];
            await updateFile(`${ROOT}/reachable.md`, undefined, {
                highlights: [
                    { id: 'hl-excl-near', type: 'pdf_bbox', page: 2, color: 'amber', text: 'near' },
                    { id: 'hl-excl-far', type: 'pdf_bbox', page: 90, color: 'amber', text: 'far' },
                ],
                flashcards: [
                    { globalHash: 'excl-far-1', vanillaData: { frontText: 'Far 1', backText: 'A', location: { type: 'highlight', id: 'hl-excl-far' } } },
                    ...reachable.map((h, n) => ({
                        globalHash: h,
                        vanillaData: { frontText: `Reachable ${n}`, backText: 'A', location: { type: 'highlight', id: 'hl-excl-near' } },
                    })),
                ],
            });
            await put(`${baseUrl}/api/progress`, {
                path: `${ROOT}/reachable.md`, unit: 'page', position: { page: 10 }, total: 100,
            });

            const res = await fetch(
                `${baseUrl}/api/srs/due?read=only&maxNew=3&document=${encodeURIComponent(`${ROOT}/reachable.md`)}`);
            const body = await res.json();
            assert.equal(body.counts.new, 3, 'the allowance is filled from eligible cards, not from the first three');
        });

        it('composes with the include filters rather than replacing them', async () => {
            const q = await dueSet(
                `folder=${encodeURIComponent(ROOT)}&excludeFolder=${encodeURIComponent(IMPORT)}`);
            assert.ok(q.has(KEEP), 'inside the scope and not excluded');
            assert.ok(!q.has(DUMP_A), 'inside the scope but excluded');
            assert.ok(!q.has(soloHash), 'the positive folder filter still drops document-less cards');
        });
    });

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

            const preRes = await fetch(`${baseUrl}/api/srs/due?algorithm=leitner&folder=${encodeURIComponent(ROOT)}`);
            const preDue = (await preRes.json()).due.map(c => c.global_hash);
            assert.ok(!preDue.includes(HASH), 'level-5 card recalled 10 d ago must NOT be due under Leitner pre-migration');

            const migrateRes = await post(`${baseUrl}/api/srs/migrate`, { from: 'leitner', to: 'sm2' });
            assert.equal(migrateRes.status, 200);
            const { ok, count } = await migrateRes.json();
            assert.ok(ok);
            assert.ok(count >= 1, 'at least one card should be migrated');

            const postRes = await fetch(`${baseUrl}/api/srs/due?algorithm=sm2&folder=${encodeURIComponent(ROOT)}`);
            const postDue = (await postRes.json()).due.map(c => c.global_hash);
            assert.ok(!postDue.includes(HASH),
                'after Leitner→SM-2 migration, level-5 card recalled 10 d ago should NOT be due (sm2_reps=3, 15-day interval)');
        });

        it('POST /api/srs/migrate → SM-2 reps 3 translates to Leitner level 5 (nearest 16-day interval)', async () => {
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

            const preRes = await fetch(`${baseUrl}/api/srs/due?algorithm=leitner&folder=${encodeURIComponent(ROOT)}`);
            const preDue = (await preRes.json()).due.map(c => c.global_hash);
            assert.ok(preDue.includes(HASH), 'level-0 card with lastRecall must be due under Leitner before migration');

            const migrateRes = await post(`${baseUrl}/api/srs/migrate`, { from: 'sm2', to: 'leitner' });
            assert.equal(migrateRes.status, 200);
            const { ok, count } = await migrateRes.json();
            assert.ok(ok);
            assert.ok(count >= 1);

            const postRes = await fetch(`${baseUrl}/api/srs/due?algorithm=leitner&folder=${encodeURIComponent(ROOT)}`);
            const postDue = (await postRes.json()).due.map(c => c.global_hash);
            assert.ok(!postDue.includes(HASH),
                'after SM-2→Leitner migration, sm2_reps-3 card recalled 10 d ago should NOT be due (level=5, 16-day interval)');
        });
    });


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


    describe('Annotated highlights & card provenance', () => {
        const ROOT = 'AnnotatedHlTest';
        const FILE = `${ROOT}/cells.md`;
        const BODY = 'The mitochondria is the powerhouse of the cell. Ribosomes synthesize proteins from amino acids.';
        const HAND_HASH = 'annotated-hand-fc-001';
        let hlCarded, hlUncarded, aiCardHash;

        before(async () => {
            await createFolder(ROOT);
            await createFile('cells.md', ROOT);
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

            const subRes = await fetch(`${baseUrl}/api/subscriptions/${MAGAZINE_ID}`);
            const sub = await subRes.json();
            assert.equal(sub.issue_id, 'issue-2', 'Subscription record must update to new issue ID');
            assert.equal(sub.version, 'v2.0.0', 'Subscription record must update to new version');

            const items = await listFolder(TARGET);
            const articleCount = items.filter(i => i.name === 'Article.md').length;
            assert.equal(articleCount, 1, 'Re-import must not create a duplicate Article.md');
        });
    });


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

        it('POST /api/decks → a new deck gets a palette colour, stored in its file', async () => {
            const hash = (await (await post(`${baseUrl}/api/decks`, { name: 'Coloured Deck' })).json()).globalHash;
            const deck = await (await fetch(`${baseUrl}/api/decks/${hash}`)).json();
            assert.ok(['slate', 'sage', 'ochre', 'brick', 'plum', 'ink'].includes(deck.color));
            const file = JSON.parse(fsSync.readFileSync(path.join(getWorkspacePath(), '_decks', `${hash}.json`), 'utf-8'));
            assert.equal(file.color, deck.color);
            await fetch(`${baseUrl}/api/decks/${hash}`, { method: 'DELETE' });
        });

        it('PUT /api/decks/:hash { color } → recolours the box; null clears it; an unknown one is 400', async () => {
            assert.ok(deckHash, 'Precondition: deck created');
            assert.equal((await put(`${baseUrl}/api/decks/${deckHash}`, { color: 'plum' })).status, 200);
            let deck = await (await fetch(`${baseUrl}/api/decks/${deckHash}`)).json();
            assert.equal(deck.color, 'plum');
            assert.equal(deck.name, 'Renamed Deck', 'a colour change leaves the name alone');
            const listed = (await (await fetch(`${baseUrl}/api/decks`)).json()).find((d) => d.global_hash === deckHash);
            assert.equal(listed.color, 'plum');
            assert.ok(listed.standing && typeof listed.standing.due === 'number');

            assert.equal((await put(`${baseUrl}/api/decks/${deckHash}`, { color: 'chartreuse' })).status, 400);
            assert.equal((await put(`${baseUrl}/api/decks/${deckHash}`, { color: null })).status, 200);
            deck = await (await fetch(`${baseUrl}/api/decks/${deckHash}`)).json();
            assert.equal(deck.color, null);
        });

        it('deck covers: a drawn pattern, an uploaded image, repositioning, replacing and removing', async () => {
            const hash = (await (await post(`${baseUrl}/api/decks`, { name: 'Covered Deck' })).json()).globalHash;
            const coversDir = path.join(getWorkspacePath(), '_decks', 'covers');
            const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
            const uploadCover = (bytes, type) => {
                const form = new FormData();
                form.append('file', new Blob([bytes], { type }), 'cover');
                return fetch(`${baseUrl}/api/decks/${hash}/cover`, { method: 'POST', body: form });
            };

            assert.equal((await put(`${baseUrl}/api/decks/${hash}/cover`, { pattern: 'cards' })).status, 200);
            let deck = await (await fetch(`${baseUrl}/api/decks/${hash}`)).json();
            assert.deepEqual(deck.cover, { kind: 'pattern', pattern: 'cards' });
            assert.equal((await fetch(`${baseUrl}/api/decks/${hash}/cover`)).status, 404, 'a drawn cover has no image to serve');
            assert.equal((await put(`${baseUrl}/api/decks/${hash}/cover`, { pattern: 'polka' })).status, 400);

            assert.equal((await uploadCover('not an image', 'text/plain')).status, 400);
            const up = await uploadCover(png, 'image/png');
            assert.equal(up.status, 201);
            const first = (await up.json()).cover;
            assert.equal(first.kind, 'image');
            assert.equal(first.y, 0.5);
            assert.ok(fsSync.existsSync(path.join(coversDir, first.file)));
            const served = await fetch(`${baseUrl}/api/decks/${hash}/cover`);
            assert.equal(served.status, 200);
            assert.match(served.headers.get('content-type'), /image\/png/);
            assert.deepEqual(Buffer.from(await served.arrayBuffer()), png);

            const moved = await (await put(`${baseUrl}/api/decks/${hash}/cover`, { y: 0.2 })).json();
            assert.equal(moved.cover.y, 0.2);
            assert.equal(moved.cover.file, first.file, 'repositioning keeps the image');

            const second = (await (await uploadCover(png, 'image/png')).json()).cover;
            assert.notEqual(second.file, first.file);
            assert.ok(!fsSync.existsSync(path.join(coversDir, first.file)), 'the replaced image is deleted');

            assert.equal((await fetch(`${baseUrl}/api/decks/${hash}/cover`, { method: 'DELETE' })).status, 200);
            deck = await (await fetch(`${baseUrl}/api/decks/${hash}`)).json();
            assert.equal(deck.cover, null);
            assert.ok(!fsSync.existsSync(path.join(coversDir, second.file)));

            const third = (await (await uploadCover(png, 'image/png')).json()).cover;
            await fetch(`${baseUrl}/api/decks/${hash}`, { method: 'DELETE' });
            assert.ok(!fsSync.existsSync(path.join(coversDir, third.file)), 'deleting the deck deletes its cover');
        });

        it('PUT /api/decks/:hash { color } → 403 on the default deck, which is always kraft', async () => {
            const system = (await (await fetch(`${baseUrl}/api/decks`)).json()).find((d) => d.is_system);
            assert.ok(system, 'the system deck exists');
            assert.equal((await put(`${baseUrl}/api/decks/${system.global_hash}`, { color: 'sage' })).status, 403);
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

        it('GET /api/decks/cards?search= and /api/search?q= find a card by the name of its deck', async () => {
            const browser = await (await fetch(`${baseUrl}/api/decks/cards?search=renamed+deck&limit=200`)).json();
            assert.ok(browser.cards.some(c => c.global_hash === FC_HASH_1), 'the card browser must match the deck name');
            const global = await (await fetch(`${baseUrl}/api/search?q=renamed+deck`)).json();
            assert.ok(global.flashcards.some(c => c.global_hash === FC_HASH_1), 'global search must match the deck name');
        });

        it('GET /api/decks/cards/summary → cards per document and per gap band, and health counts', async () => {
            const res = await fetch(`${baseUrl}/api/decks/cards/summary?algorithm=leitner`);
            assert.equal(res.status, 200);
            const s = await res.json();
            const inBands = Object.values(s.bands).reduce((a, b) => a + b, 0);
            assert.equal(inBands, s.total, 'every card sits in exactly one band');
            const inSources = s.documents.reduce((a, d) => a + d.cards, 0) + s.standalone.cards;
            assert.equal(inSources, s.total, 'every card has one source');
            assert.deepEqual(Object.keys(s.bands), ['new', 'd1', 'wk', 'w3', 'm2', 'long']);
            for (const d of s.documents) assert.ok(!d.path.includes('\\'), 'paths use forward slashes');
            for (const k of ['any', 'mouthful', 'probe']) assert.equal(typeof s.flags[k], 'number');
        });

        it('GET /api/decks/cards?band= keeps only cards in that gap band, with their gap', async () => {
            const all = await (await fetch(`${baseUrl}/api/decks/cards?limit=200&algorithm=leitner`)).json();
            const fresh = await (await fetch(`${baseUrl}/api/decks/cards?limit=200&algorithm=leitner&band=new`)).json();
            assert.ok(fresh.cards.every((c) => c.gap === null), 'a new card has no gap yet');
            assert.equal(fresh.total, all.cards.filter((c) => c.gap === null).length);
        });

        it('GET /api/decks/cards?sortBy=gap orders by the gap between reviews', async () => {
            const body = await (await fetch(`${baseUrl}/api/decks/cards?limit=200&algorithm=leitner&sortBy=gap&sortDir=asc`)).json();
            const gaps = body.cards.map((c) => c.gap ?? -1);
            assert.deepEqual(gaps, [...gaps].sort((a, b) => a - b));
        });

        it('GET /api/decks/cards?groupBy=gap keeps the bands in order and counts each across all pages', async () => {
            const body = await (await fetch(`${baseUrl}/api/decks/cards?limit=1&algorithm=leitner&groupBy=gap&sortBy=front&sortDir=asc`)).json();
            assert.ok(Array.isArray(body.groups) && body.groups.length > 0);
            assert.equal(body.groups.reduce((n, g) => n + g.count, 0), body.total);
            const order = ['new', 'd1', 'wk', 'w3', 'm2', 'long'];
            const idx = body.groups.map((g) => order.indexOf(g.key));
            assert.deepEqual(idx, [...idx].sort((a, b) => a - b));
            assert.equal(body.cards.length, 1, 'the page is still one card');
        });

        it('GET /api/decks/cards?groupBy=source groups by document, standalone cards last', async () => {
            const body = await (await fetch(`${baseUrl}/api/decks/cards?limit=500&groupBy=source`)).json();
            const keys = body.cards.map((c) => (c.document_path ? c.document_path.replace(/\\/g, '/') : null));
            const seen = new Set();
            let prev;
            for (const k of keys) {
                if (k !== prev) { assert.ok(!seen.has(k), `group ${k} appears twice`); seen.add(k); }
                prev = k;
            }
            if (keys.includes(null)) assert.equal(body.groups.at(-1).key, null);
        });

        it('GET /api/decks/cards?sortBy=due puts never-reviewed cards last', async () => {
            const body = await (await fetch(`${baseUrl}/api/decks/cards?limit=500&algorithm=leitner&sortBy=due&sortDir=asc`)).json();
            const firstNew = body.cards.findIndex((c) => c.gap === null);
            if (firstNew >= 0) assert.ok(body.cards.slice(firstNew).every((c) => c.gap === null));
        });

        it('GET /api/decks/cards?source= narrows to a document, a folder, or the default deck', async () => {
            const summary = await (await fetch(`${baseUrl}/api/decks/cards/summary`)).json();
            const doc = summary.documents[0];
            assert.ok(doc, 'need a document with cards');
            const byDoc = await (await fetch(`${baseUrl}/api/decks/cards?limit=200&source=document&sourcePath=${encodeURIComponent(doc.path)}`)).json();
            assert.equal(byDoc.total, doc.cards);
            assert.ok(byDoc.cards.every((c) => c.document_path.replace(/\\/g, '/') === doc.path));
            const folder = doc.path.split('/').slice(0, -1).join('/');
            if (folder) {
                const byFolder = await (await fetch(`${baseUrl}/api/decks/cards?limit=200&source=folder&sourcePath=${encodeURIComponent(folder)}`)).json();
                assert.ok(byFolder.total >= doc.cards);
                assert.ok(byFolder.cards.every((c) => c.document_path.replace(/\\/g, '/').startsWith(`${folder}/`)));
            }
            const alone = await (await fetch(`${baseUrl}/api/decks/cards?limit=200&source=standalone`)).json();
            assert.equal(alone.total, summary.standalone.cards);
            assert.ok(alone.cards.every((c) => !c.document_path));
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

        describe('POST /api/decks/:hash/purge', () => {
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
                assert.equal(summary.shared, 1, 'only the card in the other real deck is shared');
                assert.ok(summary.otherDecks.some(n => n.includes('other')));
            });

            it('purges standalone + document cards, sparing shared ones by default', async () => {
                const f = await buildPurgeFixture('spare');
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

                const sidecar = await (await fetch(
                    `${baseUrl}/api/documents/sidecar?path=${encodeURIComponent(f.docPath)}`)).json();
                assert.ok(!(sidecar.flashcards ?? []).some(c => c.globalHash === f.docCard),
                    'card removed from the document sidecar, not only from the DB');

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

        it('POST/PUT /api/flashcards → a standalone card keeps its own tags', async () => {
            const created = await post(`${baseUrl}/api/flashcards`, {
                frontText: 'Tagged Q', backText: 'A', cardType: 'basic', tags: ['http-tag', 'solo'],
            });
            assert.equal(created.status, 201);
            const { globalHash } = await created.json();

            const read = await (await fetch(`${baseUrl}/api/flashcards/${globalHash}`)).json();
            assert.deepEqual(read.tags.slice().sort(), ['http-tag', 'solo']);

            const put = await fetch(`${baseUrl}/api/flashcards/${globalHash}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tags: ['solo'] }),
            });
            assert.equal(put.status, 200);
            const after = await (await fetch(`${baseUrl}/api/flashcards/${globalHash}`)).json();
            assert.deepEqual(after.tags, ['solo']);

            const found = await (await fetch(
                `${baseUrl}/api/search?tag=${encodeURIComponent('solo')}`)).json();
            assert.ok(JSON.stringify(found).includes(globalHash),
                'a standalone card should be findable by its own tag');
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


    describe('Categories', () => {
        const ROOT = 'CategoryApiTest';
        const DOC = `${ROOT}/sorted.md`;
        const CARD = 'fc-category-001';
        const NAME = 'CatApiTest';
        let catId = null;
        let otherId = null;
        let soloHash = null;

        const docCard = async () => {
            const res = await fetch(`${baseUrl}/api/documents/read?path=${encodeURIComponent(DOC)}`);
            return ((await res.json()).metadata?.flashcards ?? []).find(f => f.globalHash === CARD);
        };
        const soloCard = async () => (await fetch(`${baseUrl}/api/flashcards/${soloHash}`)).json();
        const row = async (id) => (await (await fetch(`${baseUrl}/api/categories`)).json()).find(c => c.id === id);

        before(async () => {
            catId = (await (await post(`${baseUrl}/api/categories`, { name: NAME, priority: 3 })).json()).id;
            otherId = (await (await post(`${baseUrl}/api/categories`, { name: 'CatApiOther', priority: 3 })).json()).id;
            await createFolder(ROOT);
            await createFile('sorted.md', ROOT);
            await updateFile(DOC, '# Sorted', {
                flashcards: [{ globalHash: CARD, category: NAME, vanillaData: { frontText: 'Q', backText: 'A' } }],
            });
            const solo = await post(`${baseUrl}/api/flashcards`, {
                frontText: 'Solo category front', backText: 'B', cardType: 'basic', category: NAME,
            });
            soloHash = (await solo.json()).globalHash;
        });

        it('GET /api/categories → each row counts the cards using it', async () => {
            assert.equal((await row(catId)).cards, 2);
            assert.equal((await row(otherId)).cards, 0);
        });

        it('GET /api/decks/cards?category= keeps the cards in that category', async () => {
            const body = await (await fetch(`${baseUrl}/api/decks/cards?category=${catId}&limit=200`)).json();
            assert.equal(body.total, 2);
            assert.deepEqual(body.cards.map(c => c.global_hash).sort(), [CARD, soloHash].sort());
        });

        it('PUT /api/categories/:id → a rename rewrites the cards naming it', async () => {
            const res = await put(`${baseUrl}/api/categories/${catId}`, { name: 'CatApiRenamed' });
            assert.equal(res.status, 200);
            assert.equal((await docCard()).category, 'CatApiRenamed', 'the sidecar names the new category');
            assert.equal((await soloCard()).category, 'CatApiRenamed', 'and so does the default deck');
            assert.equal((await row(catId)).cards, 2, 'both cards still resolve to the row');
        });

        it('PUT /api/categories/:id → 409 onto another category’s name, 404 unknown id', async () => {
            assert.equal((await put(`${baseUrl}/api/categories/${catId}`, { name: 'CatApiOther' })).status, 409);
            assert.equal((await put(`${baseUrl}/api/categories/999999`, { name: 'x' })).status, 404);
        });

        it('DELETE /api/categories/:id → refuses while in use, and clears its cards with ?clear=1', async () => {
            assert.equal((await del(`${baseUrl}/api/categories/${catId}`)).status, 409);
            const res = await del(`${baseUrl}/api/categories/${catId}?clear=1`);
            assert.equal(res.status, 200);
            assert.equal(await row(catId), undefined);
            assert.equal((await docCard()).category, undefined, 'the card stays, without a category');
            assert.ok(!(await soloCard()).category, 'the standalone card loses it too');
        });

        it('DELETE /api/categories/:id → an unused category goes without clear', async () => {
            assert.equal((await del(`${baseUrl}/api/categories/${otherId}`)).status, 200);
        });

        after(async () => {
            await del(`${baseUrl}/api/flashcards/${soloHash}`);
        });
    });


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

            assert.equal(body.curve.model, 'approximated');
            assert.equal(body.curve.points[0].t, 0);
            assert.equal(body.curve.points[0].r, 1, 'recall is certain at the moment of review');
            for (let i = 1; i < body.curve.points.length; i++) {
                assert.ok(body.curve.points[i].r <= body.curve.points[i - 1].r,
                    'retention may only decay as time passes');
            }
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
            const page = async (dir) => {
                const res = await fetch(`${baseUrl}/api/decks/cards?sortBy=difficulty&sortDir=${dir}&limit=200`);
                assert.equal(res.status, 200);
                return (await res.json()).cards;
            };

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
            if (first.length < 2) return;

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
            const logRes = await fetch(`${baseUrl}/api/seal/log?limit=10`);
            const log = await logRes.json();
            if (log.length < 2) return;

            const targetRef = log[1].oid;
            const res = await post(`${baseUrl}/api/seal/rollback`, { ref: targetRef });
            assert.equal(res.status, 200);
        });

        it('POST /api/seal/rollback → 400 when ref is missing', async () => {
            const res = await post(`${baseUrl}/api/seal/rollback`, {});
            assert.equal(res.status, 400);
        });
    });


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
            assert.equal(typeof day.reviews, 'number', 'each day carries its review count');
            assert.ok(day.firstLine === null || typeof day.firstLine === 'string');
        });

        it('POST /api/diary/rebuild → 200 with a count', async () => {
            const res = await post(`${baseUrl}/api/diary/rebuild`, {});
            assert.equal(res.status, 200);
            const body = await res.json();
            assert.equal(body.ok, true);
            assert.equal(typeof body.count, 'number');
        });

        describe('AI-assistant access gate', () => {
            const cfgPath = path.join(process.cwd(), 'data', 'config.json');
            const mcp = (p) => fetch(`${baseUrl}${p}`, { headers: { 'X-Flashback-Client': 'mcp' } });
            const setAccess = (allowed) => {
                const cfg = fsSync.existsSync(cfgPath) ? JSON.parse(fsSync.readFileSync(cfgPath, 'utf-8')) : {};
                fsSync.writeFileSync(cfgPath, JSON.stringify({ ...cfg, mcpDiaryAccess: allowed }, null, 2));
            };

            after(() => setAccess(false));

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
                assert.notEqual((await mcp(`/api/diary/summary/${DATE}`)).status, 403);
                assert.equal((await mcp(`/api/diary/entry/${DATE}`)).status, 403);
            });

            it('hides written entries under a mixed-case path too', async () => {
                setAccess('summaries');
                assert.equal((await mcp(`/api/diary/Entry/${DATE}`)).status, 403);
                assert.equal((await mcp(`/api/diary/ENTRY/${DATE}`)).status, 403);
            });

            it('never gates the renderer (no MCP header), regardless of the flag', async () => {
                setAccess(false);
                assert.equal((await fetch(`${baseUrl}/api/diary`)).status, 200);
            });
        });
    });


    describe('Card health', () => {
        const LONG_ANSWER = Array.from({ length: 60 }, (_, i) => `term${i}`).join(' ');
        const DAY = 86400000;

        let hash;

        const seedOscillatingHistory = async (cardHash) => {
            const insert = db.prepare(`
                INSERT INTO ReviewLogs (card_hash, timestamp, outcome, ease_factor, level, algorithm)
                VALUES (?, ?, ?, 2.5, ?, 'leitner')
            `);
            const ago = (days) => new Date(Date.now() - days * DAY).toISOString();
            for (let c = 0; c < 4; c++) {
                const base = 44 - c * 11;
                await insert.run(cardHash, ago(base), 0, 1);
                await insert.run(cardHash, ago(base - 1), 1, 2);
                await insert.run(cardHash, ago(base - 3), 1, 3);
                await insert.run(cardHash, ago(base - 7), 1, 3);
            }
            await db.prepare(`
                INSERT INTO CardProgress (card_hash, account_id, level, last_recall)
                VALUES (?, 'owner', 3, ?)
                ON CONFLICT(account_id, card_hash)
                DO UPDATE SET level = excluded.level, last_recall = excluded.last_recall
            `)
                .run(cardHash, ago(4));
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
        const healthRow = async () => await db.prepare(`
            SELECT ch.* FROM CardHealth ch WHERE ch.card_hash = ?
        `).get(hash);

        const freshCard = async () => {
            const res = await post(`${baseUrl}/api/flashcards`, {
                frontText: 'What are the sixty terms?', backText: LONG_ANSWER, cardType: 'basic',
            });
            hash = (await res.json()).globalHash;
            await seedOscillatingHistory(hash);
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
            assert.equal(flag.evidence.memoryModel, 'approximated');
            assert.equal(flag.confidence, 'moderate');
            assert.ok(flag.title && flag.action, 'a flag always names what to do about it');
        });

        it('serves the same flag from the card detail payload', async () => {
            const flags = await flagsOf();
            assert.deepEqual(flags.map(f => f.kind), ['mouthful']);
        });

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
            await pass(2);
            assert.deepEqual((await flagsOf()).map(f => f.kind), ['mouthful']);
        });

        it('a passing review that reaches the recovery level clears it and restarts the window', async () => {
            await pass(3);
            assert.deepEqual(await flagsOf(), []);
            assert.equal((await healthRow()).epoch_reason, 'recovered');
            assert.ok((await healthRow()).epoch_at, 'the analysis window is stamped, not just cleared');
        });

        it('does not re-raise from history that predates the recovery', async () => {
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
            assert.equal((await healthRow()).epoch_reason, 'edit');
        });

        it('undoing a review re-classifies against what is left of the ledger', async () => {
            await freshCard();
            await fail();
            const raisedBy = (await db.prepare(`
                SELECT cf.review_log_id FROM CardFlags cf WHERE cf.card_hash = ?
            `).get(hash)).review_log_id;

            await post(`${baseUrl}/api/srs/undo`, { flashcardHash: hash, algorithm: 'leitner' });

            const [flag] = await flagsOf();
            assert.equal(flag.kind, 'mouthful');
            const now = (await db.prepare(`
                SELECT cf.review_log_id FROM CardFlags cf WHERE cf.card_hash = ?
            `).get(hash)).review_log_id;
            assert.notEqual(now, raisedBy, 're-evaluated rather than left stale');
            assert.ok(await db.prepare('SELECT 1 FROM ReviewLogs WHERE id = ?').get(now),
                'the flag cites a review that still exists');
        });

        it('undo withdraws a flag that rested only on the undone review', async () => {
            const res = await post(`${baseUrl}/api/flashcards`, {
                frontText: 'Twice in a row', backText: LONG_ANSWER, cardType: 'basic',
            });
            hash = (await res.json()).globalHash;

            await fail();
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

            const again = await (await fail()).json();
            assert.deepEqual(again.flags, []);
            const row = await db.prepare(`
                SELECT cf.dismissed_at FROM CardFlags cf
                WHERE cf.card_hash = ? AND cf.kind = 'mouthful'
            `).get(hash);
            assert.ok(row?.dismissed_at, 'the row is suppressed, not deleted');
        });

        it('editing a dismissed card un-suppresses it — a rewrite gets judged fresh', async () => {
            await put(`${baseUrl}/api/flashcards/${hash}`, { backText: `${LONG_ANSWER} extra` });
            const row = await db.prepare(`
                SELECT COUNT(*) AS c FROM CardFlags cf WHERE cf.card_hash = ?
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
            await seedOscillatingHistory(healthy);
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

    describe('Account progress', () => {
        let authorId;

        before(async () => {
            const { accounts } = await (await fetch(`${baseUrl}/api/accounts`)).json();
            authorId = accounts.find(a => a.role === 'author')?.id;
            assert.ok(authorId, 'the suite authenticates as the Author');
        });

        it("reports the Author's progress under the owner sentinel, not their account id", async () => {
            const res = await fetch(`${baseUrl}/api/accounts/${authorId}/progress`);
            assert.equal(res.status, 200);

            const body = await res.json();
            assert.equal(body.scope, 'owner');
            assert.equal(body.account.id, authorId);
            assert.equal(body.account.role, 'author');
            assert.ok(body.statistics?.totals, 'it carries a real statistics payload');
        });

        it('carries the same completeness block the caller gets for themselves', async () => {
            const mine = await (await fetch(`${baseUrl}/api/srs/statistics`)).json();
            const theirs = await (await fetch(`${baseUrl}/api/accounts/${authorId}/progress`)).json();
            assert.ok(theirs.statistics.completeness, 'completeness is composed for the target');
            assert.deepEqual(theirs.statistics.completeness, mine.completeness,
                'the Author viewed by id is the Author viewed as the caller');
        });

        it("serves the graph under someone else's schedule, and 404s for nobody", async () => {
            const own = await (await fetch(`${baseUrl}/api/documents/graph`)).json();
            const res = await fetch(`${baseUrl}/api/accounts/${authorId}/graph`);
            assert.equal(res.status, 200);
            const body = await res.json();
            assert.equal(body.scope, 'owner');
            assert.equal(body.account.id, authorId);
            assert.deepEqual(body.nodes.map((n) => [n.id, n.learned]), own.nodes.map((n) => [n.id, n.learned]),
                "the Author's halos by id are the Author's halos as the caller");
            assert.equal(body.edges.length, own.edges.length);

            const missing = await fetch(`${baseUrl}/api/accounts/not-a-real-id/graph`);
            assert.equal(missing.status, 404);
        });

        it("paints a fresh reader's graph unlearned while the Author's shows what they studied", async () => {
            const created = await (await post(`${baseUrl}/api/accounts`, {
                name: 'Graph Probe', email: `graph+${Date.now()}@example.invalid`, role: 'reader',
            })).json();
            const theirs = await (await fetch(`${baseUrl}/api/accounts/${created.id}/graph`)).json();
            const own = await (await fetch(`${baseUrl}/api/documents/graph`)).json();

            assert.equal(theirs.nodes.length, own.nodes.length, 'same vault, same nodes');
            assert.ok(theirs.nodes.every((n) => (n.learned ?? 0) === 0), 'a reader who has never reviewed knows nothing');
            assert.ok(own.nodes.some((n) => n.learned > 0), 'the suite has reviewed as the Author by now');
        });

        it('reports everyone else under their own account id', async () => {
            const created = await (await post(`${baseUrl}/api/accounts`, {
                name: 'Progress Probe', email: `probe+${Date.now()}@example.invalid`, role: 'reader',
            })).json();

            const body = await (await fetch(`${baseUrl}/api/accounts/${created.id}/progress`)).json();
            assert.equal(body.scope, created.id, 'a non-owner is keyed by their id');
            assert.equal(body.statistics.totals.reviews, 0, 'a fresh reader has studied nothing');
        });

        it('404s for an account that does not exist', async () => {
            const res = await fetch(`${baseUrl}/api/accounts/not-a-real-id/progress`);
            assert.equal(res.status, 404);
        });
    });

    describe('Account logs', () => {
        const day = '2020-02-02';
        let authorId;

        before(async () => {
            const { accounts } = await (await fetch(`${baseUrl}/api/accounts`)).json();
            authorId = accounts.find(a => a.role === 'author')?.id;
            const res = await fetch(`${baseUrl}/api/diary/entry/${day}`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: 'Read by id.' }),
            });
            assert.equal(res.status, 200);
        });

        it("reads the Author's own logs by id, the same days and entry /api/diary serves", async () => {
            const own = await (await fetch(`${baseUrl}/api/diary`)).json();
            const byId = await (await fetch(`${baseUrl}/api/accounts/${authorId}/logs`)).json();
            assert.deepEqual(byId, own);
            assert.ok(byId.some((d) => d.date === day && d.hasEntry));

            const entry = await (await fetch(`${baseUrl}/api/accounts/${authorId}/logs/entry/${day}`)).json();
            assert.equal(entry.content, 'Read by id.');
        });

        it("reads another person's logs from their own folder, not the caller's", async () => {
            const created = await (await post(`${baseUrl}/api/accounts`, {
                name: 'Logs Probe', email: `logs+${Date.now()}@example.invalid`, role: 'reader',
            })).json();
            const days = await (await fetch(`${baseUrl}/api/accounts/${created.id}/logs`)).json();
            assert.deepEqual(days, [], 'a fresh reader has written nothing');
            const entry = await (await fetch(`${baseUrl}/api/accounts/${created.id}/logs/entry/${day}`)).json();
            assert.equal(entry.content, '');
            const summary = await fetch(`${baseUrl}/api/accounts/${created.id}/logs/summary/${day}`);
            assert.equal(summary.status, 404);
        });

        it('refuses an assistant, a malformed date and an unknown account', async () => {
            const mcp = await fetch(`${baseUrl}/api/accounts/${authorId}/logs`, { headers: { 'X-Flashback-Client': 'mcp' } });
            assert.equal(mcp.status, 403);
            assert.equal((await fetch(`${baseUrl}/api/accounts/${authorId}/logs/entry/yesterday`)).status, 400);
            assert.equal((await fetch(`${baseUrl}/api/accounts/not-a-real-id/logs`)).status, 404);
        });

        it('offers no way to write someone else’s logs', async () => {
            const res = await fetch(`${baseUrl}/api/accounts/${authorId}/logs/entry/${day}`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'x' }),
            });
            assert.equal(res.status, 404);
        });
    });

    describe('Account creation refusals', () => {
        it('400s a role that is not a role, rather than 403', async () => {
            const res = await post(`${baseUrl}/api/accounts`, {
                name: 'Bad Role', email: 'bad@example.invalid', role: 'superuser',
            });
            assert.equal(res.status, 400);
            assert.match((await res.json()).error, /Unknown role/);
        });

        it('400s a missing role for the same reason', async () => {
            const res = await post(`${baseUrl}/api/accounts`, { name: 'No Role', email: 'n@example.invalid' });
            assert.equal(res.status, 400);
        });

        it('still 403s a grant the caller may not make', async () => {
            const res = await post(`${baseUrl}/api/accounts`, {
                name: 'Second Author', email: 'second@example.invalid', role: 'author',
            });
            assert.equal(res.status, 403);
            assert.match((await res.json()).error, /exactly one Author/);
        });
    });

});
