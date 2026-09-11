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
    'FLASHBACK_WORKSPACE_PATH', 'FLASHBACK_INDEX_PATH', 'FLASHBACK_STORAGE_LIMIT',
];
for (const key of SERVER_ENV) delete process.env[key];

// Dynamic, and in this order, for the reason src/server/main.js documents at length:
// importing api.js instantiates seven routers, each of which builds a Documents (and so a
// Files, which creates the workspace directory) from whatever config.json says at import
// time. serverConfig has to be able to run before that happens.
const { applyServerConfig } = await import('../src/server/serverConfig.js');
// Already in the module cache — serverConfig.js imports it — so this adds no side effect.
// Needed because applyServerConfig() ends on a config.get(), which repopulates the module
// cache: a test that hand-edits config.json on disk has to drop that cache to be seen.
const serverTestConfig = await import('../src/api/access/primitives/config.js');
// Pure and importable before anything opens a vault — no config, no database, no network.
const { compareVersions, updateCheckEnabled, startUpdateCheck } = await import('../src/server/updateCheck.js');

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
const { getDatabasePath, getWorkspacePath, getProgressDatabasePath } = await import('../src/api/access/primitives/config.js');
const { parseSize } = await import('../src/api/access/primitives/storage.js');

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

        it('refuses a vault name that is not a single path component', () => {
            // getVaultPath() joins this straight onto the volume root, so a separator nests
            // the vault a level down and `..` puts it outside the volume — and neither
            // fails at boot. It surfaces later as an empty vault where the real one was,
            // which is why this has to be caught at the point the name is handed over.
            const saved = process.env.FLASHBACK_VAULT_NAME;
            const rejected = [
                'shared/v2',        // separator: nests below the volume root
                'shared\\v2',       // the Windows one, for a zip deployment
                '..',               // climbs out of the volume
                '../elsewhere',
                'config.json',      // collides with the install's own files, which sit
                'accounts.db',      // beside the vault directories rather than inside one
                'logs',
                'trailing.',        // Windows strips it, so the folder made is not the one asked for
            ];
            // Note what is NOT here: the empty string. env() treats whitespace-only as
            // unset on purpose — docker-compose.yml writes `${FLASHBACK_AUTHOR_TOKEN:-}`
            // and friends, so an unset compose variable arrives as "". That has to keep
            // meaning "leave config.json alone", not "refuse to boot".
            try {
                for (const name of rejected) {
                    process.env.FLASHBACK_VAULT_NAME = name;
                    assert.throws(
                        () => applyServerConfig(),
                        /FLASHBACK_VAULT_NAME/,
                        `expected "${name}" to be refused`
                    );
                }
            } finally {
                process.env.FLASHBACK_VAULT_NAME = saved;
                applyServerConfig();
            }
        });

        it('leaves an already-configured vault name alone even if it breaks the rules', () => {
            // The merge is non-destructive by contract, and a vault that has been serving
            // fine must not become a boot failure because the rules got stricter. The guard
            // is about a name being handed over NOW, not about auditing the volume.
            const saved = process.env.FLASHBACK_VAULT_NAME;
            const configPath = path.join(ROOT, 'config.json');
            const before = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            fs.writeFileSync(configPath, JSON.stringify({ ...before, vaultName: 'logs' }, null, 2));
            serverTestConfig.reload();
            delete process.env.FLASHBACK_VAULT_NAME;
            try {
                const { config: merged } = applyServerConfig();
                assert.equal(merged.vaultName, 'logs');
            } finally {
                fs.writeFileSync(configPath, JSON.stringify(before, null, 2));
                serverTestConfig.reload();
                process.env.FLASHBACK_VAULT_NAME = saved;
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


    // The whole database separation exists so a deployment can give each mount ONE answer to
    // "can I lose this?" — the workspace is authorial and irreplaceable, the index is
    // rebuildable and disposable. The overrides are what express that, and they are opt-in
    // precisely because an existing deployment has its workspace INSIDE the data volume:
    // pointing the server at an empty root would create a second, empty vault and orphan the
    // real one, silently.
    describe('splitting the vault across mounts', () => {
        // Unsetting the variables is NOT enough to undo these. applyServerConfig() is
        // non-destructive on purpose — that is the contract a mounted volume with a
        // hand-edited config.json depends on — so a persisted override survives its variable
        // going away. Leaving one behind moves the workspace for every later test in this
        // file, which surfaces as "Folder does not exist" a long way from the cause.
        const restore = () => {
            delete process.env.FLASHBACK_WORKSPACE_PATH;
            delete process.env.FLASHBACK_INDEX_PATH;
            applyServerConfig();

            const file = path.join(ROOT, 'config.json');
            const cfg = JSON.parse(fs.readFileSync(file, 'utf-8'));
            delete cfg.workspacePath;
            delete cfg.indexPath;
            fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
            serverTestConfig.reload();
        };

        it('resolves exactly as before when neither override is set', () => {
            restore();
            const vault = path.join(ROOT, VAULT);
            assert.equal(getWorkspacePath(), path.join(vault, 'workspace'));
            assert.equal(getDatabasePath(), path.join(vault, `${VAULT}.db`));
        });

        it('moves the workspace and the index independently', () => {
            process.env.FLASHBACK_WORKSPACE_PATH = path.join(ROOT, 'canonical-mount');
            process.env.FLASHBACK_INDEX_PATH = path.join(ROOT, 'cache-mount');
            try {
                applyServerConfig();

                // The workspace override names the directory ITSELF — no `workspace/` is
                // appended — because the mount IS the canonical layer.
                assert.equal(getWorkspacePath(), path.join(ROOT, 'canonical-mount'));

                // The index override names a DIRECTORY; the filename still tracks the vault
                // name, so renaming a vault on disk still lines up.
                assert.equal(getDatabasePath(), path.join(ROOT, 'cache-mount', `${VAULT}.db`));

                // Everything else stays where it was. progress.db in particular is a sibling
                // of the workspace by design, not a child, and does not follow it out.
                assert.equal(getProgressDatabasePath(), path.join(ROOT, VAULT, 'progress.db'));
            } finally {
                restore();
            }
        });

        it('refuses a relative path rather than resolving it against the cwd', () => {
            // A container's working directory is an implementation detail of the image, so a
            // relative override would fail as a mystery empty vault rather than as an error.
            const saved = process.env.FLASHBACK_WORKSPACE_PATH;
            process.env.FLASHBACK_WORKSPACE_PATH = './canonical';
            try {
                assert.throws(() => applyServerConfig(), /FLASHBACK_WORKSPACE_PATH/);
            } finally {
                if (saved === undefined) delete process.env.FLASHBACK_WORKSPACE_PATH;
                else process.env.FLASHBACK_WORKSPACE_PATH = saved;
                restore();
            }
        });

        it('leaves the overrides alone when their variables are unset', () => {
            // Same non-destructive contract as every other setting: a hand-edited config.json
            // on a mounted volume must survive a restart that passes only some variables.
            process.env.FLASHBACK_INDEX_PATH = path.join(ROOT, 'cache-mount');
            try {
                applyServerConfig();
                delete process.env.FLASHBACK_INDEX_PATH;
                applyServerConfig();
                const onDisk = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf-8'));
                assert.equal(onDisk.indexPath, path.join(ROOT, 'cache-mount'));
            } finally {
                restore();
            }
        });
    });


    // A container's statvfs reports the HOST's disk, and a Docker named volume has no quota of
    // its own, so the ceiling has to be declared. Only the usage is measured. Reporting only:
    // nothing here refuses a write, so there is no failure mode to test — just that the
    // numbers are honest, the limit round-trips, and the breakdown matches the layout the
    // volume split is built around.
    describe('storage report', () => {
        const restoreLimit = () => {
            delete process.env.FLASHBACK_STORAGE_LIMIT;
            applyServerConfig();
            const file = path.join(ROOT, 'config.json');
            const cfg = JSON.parse(fs.readFileSync(file, 'utf-8'));
            delete cfg.storageLimit;
            fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
            serverTestConfig.reload();
        };

        it('parses the sizes an operator would actually type', () => {
            assert.equal(parseSize('10GB'), 10 * 1024 ** 3);
            assert.equal(parseSize('10 GiB'), 10 * 1024 ** 3, 'a space and the IEC suffix are both fine');
            assert.equal(parseSize('512mb'), 512 * 1024 ** 2, 'case does not matter');
            assert.equal(parseSize('1.5T'), Math.floor(1.5 * 1024 ** 4), 'a bare letter and a fraction');
            assert.equal(parseSize('1099511627776'), 1024 ** 4, 'a raw byte count');
            assert.equal(parseSize(4096), 4096, 'a number passes through');
        });

        it('rejects what is not a size, rather than guessing', () => {
            for (const bad of ['', '  ', 'ten gigs', '10 parsecs', '-5GB', '0', 'GB', null, undefined]) {
                assert.equal(parseSize(bad), null, `${JSON.stringify(bad)} should be null`);
            }
        });

        it('refuses a limit it cannot parse at startup', () => {
            process.env.FLASHBACK_STORAGE_LIMIT = 'lots';
            try {
                assert.throws(() => applyServerConfig(), /FLASHBACK_STORAGE_LIMIT/);
            } finally {
                restoreLimit();
            }
        });

        it('measures the vault and reports it on the handshake, with no ceiling when none is declared', async () => {
            restoreLimit();
            const res = await fetch(`${baseUrl}/api/vault`, { headers: auth() });
            assert.equal(res.status, 200);
            const { storage } = await res.json();

            assert.equal(storage.limit, null, 'nothing declared, nothing invented');
            assert.equal(storage.remaining, null);
            assert.ok(storage.used > 0, 'a vault that has been written to occupies something');
            assert.ok(typeof storage.measuredAt === 'string');

            // The breakdown is by durability class — the same classes the volume split
            // separates — so it tells you which mount to grow.
            for (const key of ['canonical', 'progress', 'index', 'accounts', 'diary']) {
                assert.ok(Number.isInteger(storage.breakdown[key]) && storage.breakdown[key] >= 0, key);
            }
            const sum = Object.values(storage.breakdown).reduce((a, b) => a + b, 0);
            assert.equal(storage.used, sum, 'used is exactly the sum of its parts');
            assert.ok(storage.breakdown.index > 0, 'the index exists');
            assert.ok(storage.breakdown.progress > 0, 'the progress store exists');
        });

        it('reports the declared limit and what is left of it', async () => {
            process.env.FLASHBACK_STORAGE_LIMIT = '2GB';
            try {
                applyServerConfig();
                const res = await fetch(`${baseUrl}/api/vault`, { headers: auth() });
                const { storage } = await res.json();
                assert.equal(storage.limit, 2 * 1024 ** 3);
                assert.equal(storage.remaining, storage.limit - storage.used);
                assert.ok(storage.remaining > 0);
            } finally {
                restoreLimit();
            }
        });
    });

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

    // ── 4. Knowing there is a newer release ───────────────────────────────

    // A server that cannot be told about a release is a server nobody upgrades. The check
    // itself talks to github.com and is not exercised here — what is pinned is the ordering
    // rule it depends on, and the promise that a deployment can switch it off.
    describe('update check', () => {
        it('orders versions the way a release ladder means them', () => {
            assert.equal(compareVersions('0.4.1', '0.5.0'), -1);
            assert.equal(compareVersions('0.5.0', '0.4.1'), 1);
            assert.equal(compareVersions('0.4.1', '0.4.1'), 0);
            assert.equal(compareVersions('0.4.1', 'v0.4.2'), -1, 'a leading v is a tag, not a version');
            assert.equal(compareVersions('0.9.0', '0.10.0'), -1, 'numeric, not lexicographic');
        });

        it('does not mistake a prerelease for an upgrade over the release it qualifies', () => {
            assert.equal(compareVersions('0.5.0', '0.5.0-rc1'), 1);
            assert.equal(compareVersions('0.5.0-rc1', '0.5.0'), -1);
        });

        it('has no opinion about a version it cannot parse', () => {
            // A malformed tag is not evidence of an update, and telling somebody to upgrade
            // to nothing is worse than saying nothing.
            assert.equal(compareVersions('0.4.1', 'nightly'), 0);
            assert.equal(compareVersions(undefined, '0.5.0'), 0);
        });

        it('is on by default and off when the deployment says so', () => {
            assert.equal(updateCheckEnabled({}), true);
            for (const value of ['off', 'OFF', 'false', '0', 'no']) {
                assert.equal(updateCheckEnabled({ FLASHBACK_UPDATE_CHECK: value }), false, value);
            }
            assert.equal(updateCheckEnabled({ FLASHBACK_UPDATE_CHECK: 'on' }), true);
        });

        it('makes no request when it is off, and reports nothing', () => {
            const off = startUpdateCheck({ currentVersion: '0.4.1', enabled: false });
            assert.equal(off.status(), null);
            off.stop();
        });

        it('reports null on the handshake until a check has answered', async () => {
            // The Api under test was built without an updateStatus getter, which is also the
            // desktop build's shape. `null` has to be a legal answer, not a missing field.
            const res = await fetch(`${baseUrl}/api/vault`, { headers: auth() });
            const body = await res.json();
            assert.ok('update' in body, 'the field must always be present for a client to branch on');
            assert.equal(body.update, null);
        });
    });

    // ── 5. Shutting down without losing anything ──────────────────────────────

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
