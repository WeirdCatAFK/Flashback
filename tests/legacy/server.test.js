import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import process from 'process';
import { testDataDir } from '../support/testData.js';

const ROOT = testDataDir('server');
process.env.USER_DATA_PATH = ROOT;

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

const SERVER_ENV = [
    'FLASHBACK_PORT', 'FLASHBACK_HOST', 'FLASHBACK_VAULT_NAME',
    'FLASHBACK_ALLOWED_ORIGINS', 'FLASHBACK_LOG_FORMAT', 'FLASHBACK_AUTHOR_TOKEN',
    'FLASHBACK_WORKSPACE_PATH', 'FLASHBACK_INDEX_PATH', 'FLASHBACK_STORAGE_LIMIT',
    'FLASHBACK_MAX_ACCOUNTS',
];
for (const key of SERVER_ENV) delete process.env[key];

const { applyServerConfig } = await import('../../src/server/serverConfig.js');
const serverTestConfig = await import('../../src/api/access/primitives/config.js');
const { compareVersions, updateCheckEnabled, startUpdateCheck } = await import('../../src/server/updateCheck.js');

const VAULT = 'servedvault';
process.env.FLASHBACK_PORT = '0';
process.env.FLASHBACK_HOST = '127.0.0.1';
process.env.FLASHBACK_VAULT_NAME = VAULT;
process.env.FLASHBACK_ALLOWED_ORIGINS = 'https://study.example.com, https://two.example.com';

const applied = applyServerConfig();

const { default: validate } = await import('../../src/api/config/validate.js');
if (!await validate()) {
    console.error('Validation failed.');
    process.exit(1);
}

const { default: Api } = await import('../../src/api/api.js');
const { openVault } = await import('../../src/api/vaultSession.js');
const { sealEmitter } = await import('../../src/api/seal/seal.js');
const { default: db } = await import('../../src/api/access/primitives/database.js');
const { closeDatabase } = await import('../../src/api/access/primitives/database.js');
const accounts = await import('../../src/api/access/primitives/accounts.js');
const { getDatabasePath, getWorkspacePath, getProgressDatabasePath } = await import('../../src/api/access/primitives/config.js');
const { parseSize } = await import('../../src/api/access/primitives/storage.js');

describe('Flashback Server', () => {
    let api, baseUrl, authorToken;

    before(async () => {
        assert.ok(await openVault({ onFatal: (m) => { throw new Error(m); } }), 'vault opened');

        await accounts.ensureLocalAuthor(null);
        const author = await accounts.getAuthorAccount();
        ({ token: authorToken } = await accounts.issueToken(author.id, 'test bootstrap'));

        api = new Api({ ...applied.config, apiToken: null });
        const server = await api.start();
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    after(async () => {
        try { await api?.stop(); } catch {  }
        try { db.close(); } catch {  }
        accounts.closeAccounts();
        await new Promise((r) => setTimeout(r, 60));
        try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {  }
        for (const key of SERVER_ENV) delete process.env[key];
    });

    const auth = (extra = {}) => ({ Authorization: `Bearer ${authorToken}`, ...extra });


    describe('server configuration', () => {
        it('writes the environment into config.json, not just into memory', () => {
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
            const saved = process.env.FLASHBACK_VAULT_NAME;
            const rejected = [
                'shared/v2',
                'shared\\v2',
                '..',
                '../elsewhere',
                'config.json',
                'accounts.db',
                'logs',
                'trailing.',
            ];
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
            const dirs = fs.readdirSync(ROOT, { withFileTypes: true })
                .filter((e) => e.isDirectory())
                .map((e) => e.name);
            assert.deepEqual(dirs, [VAULT]);
        });
    });



    describe('splitting the vault across mounts', () => {
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

                assert.equal(getWorkspacePath(), path.join(ROOT, 'canonical-mount'));

                assert.equal(getDatabasePath(), path.join(ROOT, 'cache-mount', `${VAULT}.db`));

                assert.equal(getProgressDatabasePath(), path.join(ROOT, VAULT, 'progress.db'));
            } finally {
                restore();
            }
        });

        it('refuses a relative path rather than resolving it against the cwd', () => {
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

    describe('account cap', () => {
        const restoreCap = () => {
            delete process.env.FLASHBACK_MAX_ACCOUNTS;
            applyServerConfig();
            const file = path.join(ROOT, 'config.json');
            const cfg = JSON.parse(fs.readFileSync(file, 'utf-8'));
            delete cfg.maxAccounts;
            fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
            serverTestConfig.reload();
        };
        const post = (body) => fetch(`${baseUrl}/api/accounts`, {
            method: 'POST', headers: auth({ 'Content-Type': 'application/json' }), body: JSON.stringify(body),
        });
        const patch = (id, body) => fetch(`${baseUrl}/api/accounts/${id}`, {
            method: 'PATCH', headers: auth({ 'Content-Type': 'application/json' }), body: JSON.stringify(body),
        });

        it('refuses a cap that is not a positive integer at startup', () => {
            for (const bad of ['0', '-3', 'ten', '2.5']) {
                process.env.FLASHBACK_MAX_ACCOUNTS = bad;
                try {
                    assert.throws(() => applyServerConfig(), /FLASHBACK_MAX_ACCOUNTS/, bad);
                } finally {
                    restoreCap();
                }
            }
        });

        it('reports no cap when none is declared', async () => {
            restoreCap();
            const res = await fetch(`${baseUrl}/api/accounts`, { headers: auth() });
            assert.equal(res.status, 200);
            assert.equal((await res.json()).limit, null);
        });

        it('counts active accounts, the Author included, and frees a slot on deactivation', async () => {
            process.env.FLASHBACK_MAX_ACCOUNTS = '2';
            try {
                applyServerConfig();
                const list = await (await fetch(`${baseUrl}/api/accounts`, { headers: auth() })).json();
                assert.equal(list.limit, 2, 'the cap round-trips through config.json');
                assert.equal(list.accounts.filter((a) => a.active).length, 1, 'just the Author so far');

                const first = await post({ name: 'Rita', email: 'rita@example.com', role: 'reader' });
                assert.equal(first.status, 201, 'the second slot is free');
                const rita = await first.json();

                const third = await post({ name: 'Sam', email: 'sam@example.com', role: 'reader' });
                assert.equal(third.status, 409, 'the cap is the Author plus one');
                const refusal = await third.json();
                assert.equal(refusal.code, 'account_limit');
                assert.equal(refusal.limit, 2);
                assert.equal(refusal.count, 2);
                assert.equal(refusal.status, undefined, 'the HTTP status is not echoed into the body');

                const off = await patch(rita.id, { active: false });
                assert.equal(off.status, 200);
                const afterwards = await post({ name: 'Sam', email: 'sam@example.com', role: 'reader' });
                assert.equal(afterwards.status, 201, 'a deactivated account no longer holds a slot');

                const back = await patch(rita.id, { active: true });
                assert.equal(back.status, 409, 're-activating takes a slot, and there is none');
                assert.equal((await back.json()).code, 'account_limit');

                const noop = await patch((await afterwards.json()).id, { active: true });
                assert.equal(noop.status, 200, 'setting active on an already-active account takes nothing');
            } finally {
                restoreCap();
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
                const author = await accounts.getAuthorAccount();
                ({ token: authorToken } = await accounts.issueToken(author.id, 'test re-bootstrap'));
            }
        });
    });


    describe('singleVault', () => {
        it('still answers the identity handshake a remote depends on', async () => {
            const res = await fetch(`${baseUrl}/api/vault`, { headers: auth() });
            assert.equal(res.status, 200);
            const body = await res.json();
            assert.equal(body.vaultName, VAULT);
            assert.ok(body.vaultId, 'a remote identifies the vault by its id');
            assert.equal(typeof body.schemaVersion, 'number');
        });

        const probeSwitch = (url) => fetch(url, {
            method: 'POST',
            headers: auth({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({}),
        });

        it('reports the switch routes as absent, not as forbidden', async () => {
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
            const res = await fetch(`${baseUrl}/api/vault`, { headers: auth() });
            const body = await res.json();
            assert.ok('update' in body, 'the field must always be present for a client to branch on');
            assert.equal(body.update, null);
        });
    });


    describe('graceful shutdown', () => {
        it('checkpoints the WAL so the volume is consistent for the next container', async () => {
            const walPath = `${getDatabasePath()}-wal`;

            await db.exec('CREATE TABLE IF NOT EXISTS ShutdownProbe (id INTEGER PRIMARY KEY)');
            for (let i = 0; i < 200; i++) {
                await db.prepare('INSERT INTO ShutdownProbe (id) VALUES (?)').run(i);
            }
            assert.ok(fs.existsSync(walPath) && fs.statSync(walPath).size > 0,
                'precondition: uncommitted pages are sitting in the WAL');

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
