import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import AdmZip from 'adm-zip';
import { testDataDir } from '../support/testData.js';

process.env.USER_DATA_PATH = testDataDir('privatePaths');
fs.rmSync(process.env.USER_DATA_PATH, { recursive: true, force: true });
process.env.FLASHBACK_PORT = '0';
process.env.FLASHBACK_HOST = '127.0.0.1';
process.env.FLASHBACK_VAULT_NAME = 'private';

const { applyServerConfig } = await import('../../src/server/serverConfig.js');
const applied = applyServerConfig();
const { default: validate } = await import('../../src/api/config/validate.js');
if (!await validate()) {
    console.error('Validation failed.');
    process.exit(1);
}

const { default: Api } = await import('../../src/api/api.js');
const { openVault, releaseVault } = await import('../../src/api/vaultSession.js');
const accounts = await import('../../src/api/access/primitives/accounts.js');
const { getWorkspacePath } = await import('../../src/api/access/primitives/config.js');
const { sealEmitter } = await import('../../src/api/seal/seal.js');

const SECRET = 'SECRET-DIARY-LINE';
const ENTRY = 'owner/2026-06-03.md';
const SPELLINGS = ['_diary', '_DIARY', '_Diary', '_diary.', '_diary ', '_diary::$INDEX_ALLOCATION', './_diary', 'x/../_Diary'];
const GIT_SPELLINGS = ['.git', '.GIT', 'GIT~1', '.git::$INDEX_ALLOCATION', 'x/../.git'];

/** The text of a response, plus whatever a zip or a git object inside it unpacks to. */
function everythingIn(bytes) {
    const found = [bytes.toString()];
    const inflate = (b) => { try { found.push(zlib.inflateSync(b).toString()); } catch {} };
    inflate(bytes);
    try {
        for (const entry of new AdmZip(bytes).getEntries()) {
            found.push(entry.entryName, entry.getData().toString());
            inflate(entry.getData());
        }
    } catch {}
    return found.join('\n');
}

describe('the private corners of the workspace', () => {
    const tokens = {};
    let api, base;

    const call = (role, method, url, body) => fetch(base + url, {
        method,
        headers: { Authorization: `Bearer ${tokens[role]}`, ...(body && { 'Content-Type': 'application/json' }) },
        body: body && JSON.stringify(body),
    });
    const secretFile = () => path.join(getWorkspacePath(), '_diary', ...ENTRY.split('/'));

    before(async () => {
        await openVault({ onFatal: (m) => { throw new Error(m); } });
        await accounts.ensureLocalAuthor(null);
        const author = await accounts.getAuthorAccount();
        ({ token: tokens.author } = await accounts.issueToken(author.id, 'author'));
        for (const role of ['reader', 'admin']) {
            const { id } = await accounts.createAccount({ name: role, email: `${role}@example.invalid`, role });
            ({ token: tokens[role] } = await accounts.issueToken(id, role));
        }
        api = new Api({ ...applied.config, apiToken: null });
        base = `http://127.0.0.1:${(await api.start()).address().port}/api`;

        fs.mkdirSync(path.dirname(secretFile()), { recursive: true });
        fs.writeFileSync(secretFile(), SECRET);
        fs.writeFileSync(path.join(getWorkspacePath(), 'Shared.md'), 'shared');
        await sealEmitter.edit(`_diary/${ENTRY}`);
    });

    after(async () => {
        await api.stop();
        await releaseVault();
        accounts.closeAccounts();
    });

    it('answers no reader with a restored diary file, under any spelling of its folder', async () => {
        for (const root of SPELLINGS) {
            const file = encodeURIComponent(`${root}/${ENTRY}`);
            const dir = encodeURIComponent(root);
            for (const url of [
                `/documents/read?path=${file}`, `/documents/raw?path=${file}`, `/reader/read?path=${file}`,
                `/documents/sidecar?path=${file}`, `/documents/links?path=${file}`,
                `/documents/list?path=${dir}`, `/documents/export?path=${dir}`,
            ]) {
                const res = await call('reader', 'GET', url);
                assert.ok(res.status >= 400, `${res.status} ${url}`);
                assert.ok(!everythingIn(Buffer.from(await res.arrayBuffer())).includes(SECRET), url);
            }
        }
    });

    it('answers no reader with Seal history, under any spelling of .git', async () => {
        for (const root of GIT_SPELLINGS) {
            for (const url of [
                `/documents/export?path=${encodeURIComponent(`${root}/objects`)}`, `/documents/export?path=${encodeURIComponent(root)}`,
                `/documents/list?path=${encodeURIComponent(root)}`, `/documents/read?path=${encodeURIComponent(`${root}/HEAD`)}`,
            ]) {
                const res = await call('reader', 'GET', url);
                assert.equal(res.status, 403, url);
                assert.equal((await res.json()).code, 'reserved_path', url);
            }
        }
    });

    it('leaves both out of a whole-workspace listing and export', async () => {
        for (const root of ['', '.', 'x/..']) {
            const res = await call('reader', 'GET', `/documents/list?path=${encodeURIComponent(root)}`);
            const names = (await res.json()).map((e) => e.name);
            assert.ok(names.includes('Shared.md'));
            assert.ok(!names.some((n) => ['_diary', '_decks', '_categories.json', '.git'].includes(n)), `"${root}" lists ${names}`);
        }
        for (const root of ['.', 'x/..']) {
            const res = await call('reader', 'GET', `/documents/export?path=${encodeURIComponent(root)}`);
            const bytes = Buffer.from(await res.arrayBuffer());
            const names = new AdmZip(bytes).getEntries().map((e) => e.entryName);
            assert.ok(names.some((n) => n.endsWith('/Shared.md')));
            assert.ok(!everythingIn(bytes).includes(SECRET), names.join(', '));
        }
    });

    it('lets no admin copy, overwrite, rename onto or delete them', async () => {
        for (const root of SPELLINGS.slice(0, 3)) {
            for (const [method, url, body] of [
                ['POST', '/documents/copy', { srcPath: root, destPath: 'stolen', isFolder: true }],
                ['POST', '/documents/move', { srcPath: root, destPath: 'stolen', isFolder: true }],
                ['POST', '/documents/move', { srcPath: 'Shared.md', destPath: `${root}/Shared.md` }],
                ['POST', '/documents/rename', { path: 'Shared.md', newName: root }],
                ['POST', '/documents/folder', { name: root, parentPath: '' }],
                ['POST', '/documents/file', { name: 'x.md', parentPath: root }],
                ['PUT', '/documents/file', { path: `${root}/${ENTRY}`, content: 'OVERWRITTEN' }],
                ['DELETE', '/documents', { path: root, isFolder: true }],
            ]) {
                const res = await call('admin', method, url, body);
                assert.equal(res.status, 403, `${method} ${url} ${JSON.stringify(body)}`);
            }
        }
        assert.equal(fs.readFileSync(secretFile(), 'utf-8'), SECRET);
    });

    it('lets no admin delete, move or copy the workspace itself', async () => {
        for (const [method, url, body] of [
            ['DELETE', '/documents', { path: '.', isFolder: true }],
            ['DELETE', '/documents', { path: 'x/..', isFolder: true }],
            ['POST', '/documents/move', { srcPath: '.', destPath: 'inside', isFolder: true }],
            ['POST', '/documents/copy', { srcPath: '.', destPath: 'inside', isFolder: true }],
            ['POST', '/documents/rename', { path: '.', newName: 'inside', isFolder: true }],
        ]) {
            const res = await call('admin', method, url, body);
            assert.equal(res.status, 400, `${method} ${url}`);
            assert.equal((await res.json()).code, 'workspace_root');
        }
        assert.ok(fs.existsSync(path.join(getWorkspacePath(), 'Shared.md')));
    });

    it('keeps serving names that only start like a reserved one', async () => {
        for (const name of ['_diary-notes', '_decksmith', '.gitignored']) {
            assert.equal((await call('admin', 'POST', '/documents/folder', { name, parentPath: '' })).status, 201, name);
            assert.equal((await call('reader', 'GET', `/documents/list?path=${name}`)).status, 200, name);
        }
    });

    it('shows a diary entry to its writer, and to no other role', async () => {
        const url = '/diary/entry/2026-06-10';
        assert.equal((await call('reader', 'PUT', url, { content: 'only mine' })).status, 200);
        assert.equal((await (await call('reader', 'GET', url)).json()).content, 'only mine');

        const { accounts: people } = await (await call('author', 'GET', '/accounts')).json();
        const reader = people.find((a) => a.role === 'reader');
        for (const role of ['admin', 'author']) {
            assert.equal((await (await call(role, 'GET', url)).json()).content, '');
            for (const other of [`/accounts/${reader.id}/logs`, `/accounts/${reader.id}/logs/entry/2026-06-10`, '/diary', '/diary/export']) {
                const bytes = Buffer.from(await (await call(role, 'GET', other)).arrayBuffer());
                assert.ok(!everythingIn(bytes).includes('only mine'), `${role} ${other}`);
            }
        }
    });

    it('leaves no export behind in the temp folder', async () => {
        const zips = () => fs.readdirSync(os.tmpdir()).filter((n) => /^workspace_\d+\.zip$/.test(n));
        const before = zips();
        await (await call('reader', 'GET', '/documents/export?path=.')).arrayBuffer();
        for (let i = 0; i < 50 && zips().length > before.length; i++) await new Promise((r) => setTimeout(r, 20));
        assert.deepEqual(zips(), before);
    });
});
