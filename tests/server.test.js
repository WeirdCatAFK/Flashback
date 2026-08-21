/**
 * Flashback Server — the headless build.
 *
 * The server is the same `src/api` the desktop app runs, with three switches thrown. This
 * file pins the switches, because each one is a thing that is either on or catastrophic:
 *
 *   1. **Configuration comes from the environment, and reaches the file.** `cors.js` and
 *      every path resolver read through `config.get()`, so an override that stayed in
 *      memory would be invisible to them. The merge must also be non-destructive — a
 *      hand-edited `config.json` on a mounted volume is a supported way to configure this.
 *   2. **`requireAuth` refuses anonymous callers.** On loopback, treating an anonymous
 *      caller as the Author is a convenience; on a network it is an open door.
 *   3. **`singleVault` unmounts the switch routes.** A switch closes the database and
 *      re-points every path resolver — under every connected user at once.
 *
 * Plus the shutdown path, which is the difference between a container restart that is
 * uneventful and one that loses the last few minutes of everybody's work.
 *
 * Run: node --test tests/server.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import process from 'process';

const ROOT = path.join(process.cwd(), 'data_test_server');
process.env.USER_DATA_PATH = ROOT;

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

// Every env var this suite manipulates is cleared first, so a developer who happens to have
// one exported does not silently change what is being asserted.
const SERVER_ENV = [
    'FLASHBACK_PORT', 'FLASHBACK_HOST', 'FLASHBACK_VAULT_NAME',
    'FLASHBACK_ALLOWED_ORIGINS', 'FLASHBACK_LOG_FORMAT', 'FLASHBACK_AUTHOR_TOKEN',
];
for (const key of SERVER_ENV) delete process.env[key];

// Dynamic, and in this order, for the reason src/server/main.js documents at length:
// importing api.js instantiates seven routers, each of which builds a Documents (and so a
// Files, which creates the workspace directory) from whatever config.json says at import
// time. serverConfig has to be able to run before that happens.
const { applyServerConfig } = await import('../src/server/serverConfig.js');

const VAULT = 'servedvault';
process.env.FLASHBACK_PORT = '0';
process.env.FLASHBACK_HOST = '127.0.0.1';
process.env.FLASHBACK_VAULT_NAME = VAULT;
process.env.FLASHBACK_ALLOWED_ORIGINS = 'https://study.example.com, https://two.example.com';

const applied = applyServerConfig();

const { default: validate } = await import('../src/api/config/validate.js');
if (!await validate()) {
    console.error('Validation failed.');
    process.exit(1);
}

const { default: Api } = await import('../src/api/api.js');
const { openVault } = await import('../src/api/vaultSession.js');
const { sealEmitter } = await import('../src/api/seal/seal.js');
const { default: db } = await import('../src/api/access/primitives/database.js');
const { closeDatabase } = await import('../src/api/access/primitives/database.js');
const accounts = await import('../src/api/access/primitives/accounts.js');
const { getDatabasePath } = await import('../src/api/access/primitives/config.js');

describe('Flashback Server', () => {
    let api, baseUrl, authorToken;

    before(async () => {
        assert.ok(await openVault({ onFatal: (m) => { throw new Error(m); } }), 'vault opened');

        // The bootstrap src/server/main.js performs: adopt an injected token, or mint one.
        await accounts.ensureLocalAuthor(null);
        const author = await accounts.getAuthorAccount();
        ({ token: authorToken } = await accounts.issueToken(author.id, 'test bootstrap'));

        api = new Api({ ...applied.config, apiToken: null });
        const server = await api.start();
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    after(async () => {
        try { await api?.stop(); } catch { /* already stopped by the shutdown test */ }
        try { db.close(); } catch { /* ditto */ }
        accounts.closeAccounts();
        await new Promise((r) => setTimeout(r, 60));
        try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* windows locks */ }
        for (const key of SERVER_ENV) delete process.env[key];
    });

    const auth = (extra = {}) => ({ Authorization: `Bearer ${authorToken}`, ...extra });

    // ── 1. Configuration from the environment ─────────────────────────────────

    describe('server configuration', () => {
        it('writes the environment into config.json, not just into memory', () => {
            // Read the FILE, not the cache. cors.js and the path resolvers go through
            // config.get(), so an override that never landed on disk would be invisible to
            // them the moment anything called reload().
            const onDisk = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf-8'));
            assert.equal(onDisk.host, '127.0.0.1');
            assert.equal(onDisk.vaultName, VAULT);
            assert.deepEqual(onDisk.allowedOrigins, ['https://study.example.com', 'https://two.example.com']);
        });

        it('turns on requireAuth and singleVault, which desktop never sets', () => {
            assert.equal(applied.config.requireAuth, true);
            assert.equal(applied.config.singleVault, true);
        });

        it('leaves settings alone when their variable is unset', () => {
            // Non-destructive is the contract: a mounted volume with a hand-edited
            // config.json must survive a restart that passes only some of the variables.
            const before = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf-8'));
            delete process.env.FLASHBACK_ALLOWED_ORIGINS;
            delete process.env.FLASHBACK_VAULT_NAME;
            try {
                applyServerConfig();
                const after = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf-8'));
                assert.deepEqual(after.allowedOrigins, before.allowedOrigins);
                assert.equal(after.vaultName, before.vaultName);
            } finally {
                process.env.FLASHBACK_ALLOWED_ORIGINS = 'https://study.example.com, https://two.example.com';
                process.env.FLASHBACK_VAULT_NAME = VAULT;
                applyServerConfig();
            }
        });

        it('refuses a port that is not a port', () => {
            const saved = process.env.FLASHBACK_PORT;
            process.env.FLASHBACK_PORT = 'not-a-number';
            try {
                assert.throws(() => applyServerConfig(), /FLASHBACK_PORT/);
            } finally {
                process.env.FLASHBACK_PORT = saved;
                applyServerConfig();
            }
        });

        it('refuses half an identity rather than silently deriving one', () => {
            // A name with no email looks configured and behaves as though it were not:
            // getIdentity() only accepts a pair, so it would fall back to the OS account —
            // which in a container is `node`, stamped into a git history that outlives it.
            const saved = process.env.FLASHBACK_USER_NAME;
            process.env.FLASHBACK_USER_NAME = 'Study Group';
            try {
                assert.throws(() => applyServerConfig(), /must be set together/);
            } finally {
                if (saved === undefined) delete process.env.FLASHBACK_USER_NAME;
                else process.env.FLASHBACK_USER_NAME = saved;
                applyServerConfig();
            }
        });

        it('writes a full identity through to config.user', () => {
            process.env.FLASHBACK_USER_NAME = 'Study Group';
            process.env.FLASHBACK_USER_EMAIL = 'group@example.com';
            try {
                const { config: withUser } = applyServerConfig();
                assert.deepEqual(withUser.user, { name: 'Study Group', email: 'group@example.com' });
            } finally {
                delete process.env.FLASHBACK_USER_NAME;
                delete process.env.FLASHBACK_USER_EMAIL;
                applyServerConfig();
            }
        });

        it('serves the vault the environment named', () => {
            assert.equal(path.basename(path.dirname(getDatabasePath())), VAULT);
        });

        it('creates no vault other than the one it was told to serve', () => {
            // Regression: importing api.js builds seven routers, each of which constructs a
            // Documents — and Files' constructor creates the workspace directory from
            // whatever config.json says AT IMPORT TIME. A static import in the server entry
            // point therefore left an empty `{volume}/dreams/workspace` beside the real
            // vault. It is harmless until someone has to guess which directory is their data.
            const dirs = fs.readdirSync(ROOT, { withFileTypes: true })
                .filter((e) => e.isDirectory())
                .map((e) => e.name);
            assert.deepEqual(dirs, [VAULT]);
        });
    });

    // ── 2. Authentication is not optional ─────────────────────────────────────

    describe('requireAuth', () => {
        it('leaves the readiness ping open, so a health check needs no credentials', async () => {
            const res = await fetch(`${baseUrl}/`);
            assert.equal(res.status, 200);
        });

        it('refuses an anonymous /api caller instead of treating them as the Author', async () => {
            const res = await fetch(`${baseUrl}/api/documents/list?path=`);
            assert.equal(res.status, 401);
        });

        it('refuses a token that resolves to nobody', async () => {
            const res = await fetch(`${baseUrl}/api/documents/list?path=`, {
                headers: { Authorization: 'Bearer not-a-real-token' },
            });
            assert.equal(res.status, 401);
        });

        it('accepts the Author token', async () => {
            const res = await fetch(`${baseUrl}/api/documents/list?path=`, { headers: auth() });
            assert.equal(res.status, 200);
        });

        it('refuses to start at all when nobody can authenticate', async () => {
            // The inverse of the bootstrap: a served deployment with no usable token is an
            // unreachable deployment, and failing to boot says so immediately.
            const revoked = [];
            for (const account of await accounts.listAccounts()) {
                for (const token of account.tokens ?? []) {
                    if (!token.revoked_at) { await accounts.revokeToken(token.id); revoked.push(token.id); }
                }
            }
            try {
                assert.equal(await accounts.hasUsableToken(), false);
                const doomed = new Api({ ...applied.config, port: 0, apiToken: null });
                await assert.rejects(() => doomed.start(), /requireAuth/);
            } finally {
                // Re-issue rather than un-revoke: revocation is deliberately one-way.
                const author = await accounts.getAuthorAccount();
                ({ token: authorToken } = await accounts.issueToken(author.id, 'test re-bootstrap'));
            }
        });
    });

    // ── 3. One vault per server ───────────────────────────────────────────────

    describe('singleVault', () => {
        it('still answers the identity handshake a remote depends on', async () => {
            const res = await fetch(`${baseUrl}/api/vault`, { headers: auth() });
            assert.equal(res.status, 200);
            const body = await res.json();
            assert.equal(body.vaultName, VAULT);
            assert.ok(body.vaultId, 'a remote identifies the vault by its id');
            assert.equal(typeof body.schemaVersion, 'number');
        });

        // Probing `/switch` with NO name is deliberate: the handler rejects that with 400
        // before it touches anything, so "is this route mounted?" can be asked without
        // actually switching a vault out from under the rest of the suite. Unmounted → 404,
        // mounted → 400. (`/release` has no such dry run — it releases on any request — so
        // it is only ever probed on the server build, where it is absent.)
        const probeSwitch = (url) => fetch(url, {
            method: 'POST',
            headers: auth({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({}),
        });

        it('reports the switch routes as absent, not as forbidden', async () => {
            // 404 rather than 403 on purpose: a client probing capabilities should see a
            // server that CANNOT switch, not one that would if you had a better role.
            assert.equal((await probeSwitch(`${baseUrl}/api/vault/switch`)).status, 404);

            const released = await fetch(`${baseUrl}/api/vault/release`, {
                method: 'POST', headers: auth(),
            });
            assert.equal(released.status, 404, '/release must be unmounted too');
        });

        it('leaves the routes mounted when the flag is off, so desktop is unaffected', async () => {
            const desktop = new Api({ ...applied.config, port: 0, singleVault: false, apiToken: null });
            const server = await desktop.start();
            try {
                const res = await probeSwitch(`http://127.0.0.1:${server.address().port}/api/vault/switch`);
                assert.equal(res.status, 400,
                    'the desktop build must keep its switch routes: 400 is the handler answering');
            } finally {
                await desktop.stop();
            }
        });
    });

    // ── 4. Shutting down without losing anything ──────────────────────────────

    describe('graceful shutdown', () => {
        it('checkpoints the WAL so the volume is consistent for the next container', async () => {
            const walPath = `${getDatabasePath()}-wal`;

            // Give the WAL something to lose.
            await db.exec('CREATE TABLE IF NOT EXISTS ShutdownProbe (id INTEGER PRIMARY KEY)');
            for (let i = 0; i < 200; i++) {
                await db.prepare('INSERT INTO ShutdownProbe (id) VALUES (?)').run(i);
            }
            assert.ok(fs.existsSync(walPath) && fs.statSync(walPath).size > 0,
                'precondition: uncommitted pages are sitting in the WAL');

            // The sequence from src/server/main.js's shutdown(): stop accepting, flush
            // Seal, then close — which truncates the WAL.
            await api.stop();
            api = null;
            await sealEmitter.quiesce();
            closeDatabase();

            const walSize = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
            assert.equal(walSize, 0,
                'a WAL left behind is how a vault loses its most recent writes on restart');
        });
    });
});
