/**
 * Vault identity, and switching between vaults in-process.
 *
 * The switch is the interesting half. Until now the API process resolved its vault once
 * at module load — the database handle was opened at import, and `Files`/`Decks` froze
 * their workspace root in a constructor — so "which vault am I" was answered exactly once
 * per process. These tests drive `switchVault()` against two real vaults and assert the
 * thing that actually matters: that no trace of one leaks into the other.
 *
 * The isolation test is the point of the file. Everything else here is a guard around it.
 *
 * Run: node --test tests/vault.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';

const ROOT = path.join(process.cwd(), 'data_test_vault');
process.env.USER_DATA_PATH = ROOT;

// A clean slate — these tests create and destroy whole vaults, so a leftover run would
// otherwise show up as an extra registry entry or a pre-existing document.
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });
fs.writeFileSync(
    path.join(ROOT, 'config.json'),
    JSON.stringify({
        port: 0, logFormat: 'dev', host: 'localhost', isLocalhost: true,
        isCustomPath: false, customPath: '', vaultName: 'alpha',
    }, null, 2),
);

const { vaultNameError } = await import('../src/shared/vaultName.js');
const config = await import('../src/api/access/primitives/config.js');
const { openVault, switchVault, releaseVault, isSwitching } =
    await import('../src/api/vaultSession.js');
const vault = await import('../src/api/access/primitives/vault.js');
const { default: query } = await import('../src/api/access/resources/query.js');
const { default: Documents } = await import('../src/api/access/orchestration/documents.js');
const { default: db, closeDatabase } = await import('../src/api/access/primitives/database.js');

// Both vaults are torn down when the file finishes, so a run leaves nothing behind for the
// next one to inherit — the fixture is built fresh at the top of this file every time.
after(() => {
    closeDatabase();
    try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* Windows handle lag */ }
});

const ALPHA = { id: 'id-alpha', name: 'alpha', isCustomPath: false, customPath: '' };
const BETA = { id: 'id-beta', name: 'beta', isCustomPath: false, customPath: '' };

const docs = new Documents();

async function createDoc(name) {
    await docs.createFile(name, '');
}

function documentNames() {
    return db.prepare('SELECT name FROM Documents ORDER BY name').all().map((r) => r.name);
}

// Pure, and shared with the Electron main process — the half that actually creates and
// renames folders. It used to exist only inside the Setup wizard, which meant the Config
// field that renamed a vault on disk validated nothing at all.
describe('vault name rules', () => {
    it('accepts an ordinary name', () => {
        assert.equal(vaultNameError('Work notes'), null);
    });

    it('rejects empty, over-long and path-illegal names', () => {
        assert.equal(vaultNameError('   '), 'required');
        assert.equal(vaultNameError('x'.repeat(65)), 'too-long');
        for (const bad of ['a/b', 'a\\b', 'a:b', 'a?b', 'a*b', 'a|b', 'a<b', 'a"b']) {
            assert.equal(vaultNameError(bad), 'invalid-chars', `${bad} should be rejected`);
        }
    });

    it('rejects a trailing dot, which Windows would silently strip', () => {
        // The folder created would not be the one asked for, and the mismatch surfaces
        // later as a vault that cannot be found.
        assert.equal(vaultNameError('notes.'), 'trailing-dot');
        // A trailing space is trimmed rather than rejected — the user meant the name.
        assert.equal(vaultNameError('notes '), null);
    });

    it('rejects names that would collide with app or Chromium state in userData', () => {
        assert.equal(vaultNameError('logs'), 'reserved');
        assert.equal(vaultNameError('config.json'), 'reserved');
        assert.equal(vaultNameError('Cache'), 'reserved', 'the match is case-insensitive');
        assert.equal(vaultNameError('Local Storage'), 'reserved');
    });
});

describe('vault identity', () => {
    before(async () => {
        await openVault();
    });

    it('stamps a manifest with a stable id and leaves it alone afterwards', () => {
        const first = vault.ensureManifest();
        assert.ok(first.id, 'a vault should get an id');
        assert.equal(first.manifestVersion, vault.MANIFEST_VERSION);

        const again = vault.ensureManifest();
        assert.equal(again.id, first.id, 'ensureManifest must be idempotent');
        assert.equal(vault.getVaultId(), first.id);
    });

    it('writes vault.json at the vault root, outside the Seal repo', () => {
        const manifestPath = path.join(config.getVaultPath(), 'vault.json');
        assert.ok(fs.existsSync(manifestPath));

        // Inside workspace/ it would be versioned by Seal and walked by UpdateRunner,
        // neither of which should ever see a vault's identity.
        const inWorkspace = path.join(config.getWorkspacePath(), 'vault.json');
        assert.ok(!fs.existsSync(inWorkspace));
    });

    it('recognises a real vault directory and rejects anything else', () => {
        assert.equal(vault.inspectVaultDir(config.getVaultPath()).ok, true);
        assert.equal(vault.inspectVaultDir(path.join(ROOT, 'nope')).ok, false);

        // A directory with a workspace/ but no database is a half-copied folder, not a vault.
        const partial = path.join(ROOT, 'partial', 'workspace');
        fs.mkdirSync(partial, { recursive: true });
        const verdict = vault.inspectVaultDir(path.join(ROOT, 'partial'));
        assert.equal(verdict.ok, false);
        assert.match(verdict.reason, /database/i);
    });
});

describe('switching vaults', () => {
    let alphaId;

    before(async () => {
        await openVault();
        alphaId = vault.getVaultId();
        await createDoc('alpha-note.md');
    });

    after(async () => {
        await switchVault(ALPHA);
    });

    it('moves every derived path to the new vault', async () => {
        const alphaDbPath = config.getDatabasePath();

        const result = await switchVault(BETA);
        assert.equal(result.ok, true, result.error);

        assert.equal(config.get().vaultName, 'beta');
        assert.equal(config.get().activeVaultId, BETA.id);
        assert.match(config.getVaultPath(), /beta$/);
        assert.match(config.getWorkspacePath(), /beta[\\/]workspace$/);
        assert.notEqual(config.getDatabasePath(), alphaDbPath);
        assert.match(config.getDatabasePath(), /beta\.db$/);
    });

    it('provisions a brand-new vault without a restart', () => {
        // The switch ran validate(), which builds the schema for an empty database — the
        // same path a fresh install takes.
        assert.ok(query.getSchemaVersion() > 0, 'migrations should have run on the new vault');
        assert.ok(fs.existsSync(config.getDatabasePath()));
        assert.ok(fs.existsSync(path.join(config.getWorkspacePath(), '_decks')));
        assert.ok(query.getSystemDeck(), 'the system deck must exist in the new vault');
    });

    it('does not carry the previous vault\'s documents across', () => {
        assert.deepEqual(documentNames(), [], 'beta should be empty');
    });

    it('gives the new vault its own identity', () => {
        const betaId = vault.getVaultId();
        assert.ok(betaId);
        assert.notEqual(betaId, alphaId, 'two vaults must not share an id');
    });

    it('leaves the original vault intact when switched back', async () => {
        const result = await switchVault(ALPHA);
        assert.equal(result.ok, true, result.error);

        assert.equal(config.get().vaultName, 'alpha');
        assert.equal(vault.getVaultId(), alphaId, 'a vault keeps its id across switches');
        assert.deepEqual(documentNames(), ['alpha-note.md']);
        assert.ok(fs.existsSync(path.join(config.getWorkspacePath(), 'alpha-note.md')));
    });

    it('writes new documents into the vault that is actually active', async () => {
        await switchVault(BETA);
        await createDoc('beta-note.md');
        assert.deepEqual(documentNames(), ['beta-note.md']);

        await switchVault(ALPHA);
        assert.deepEqual(documentNames(), ['alpha-note.md'],
            'writing to beta must not have touched alpha');
    });

    it('reports a switch in flight and clears the flag afterwards', async () => {
        assert.equal(isSwitching(), false);
        const pending = switchVault(BETA);
        assert.equal(isSwitching(), true, 'the API gate depends on this being raised synchronously');
        await pending;
        assert.equal(isSwitching(), false);
        await switchVault(ALPHA);
    });

    it('refuses an entry with no name rather than half-switching', async () => {
        const before = config.get().vaultName;
        const result = await switchVault({ id: 'x' });
        assert.equal(result.ok, false);
        assert.equal(config.get().vaultName, before, 'a rejected switch must not move the pointer');
    });

    it('releases the database so the folder can be renamed', async () => {
        await releaseVault();
        // The WAL siblings are what block a directory rename on Windows; a checkpointed
        // close removes them.
        const dbPath = config.getDatabasePath();
        assert.ok(!fs.existsSync(`${dbPath}-wal`), 'WAL should be checkpointed away on release');

        // The connection re-opens lazily on the next access, with no explicit resume.
        assert.ok(query.getSchemaVersion() > 0);
    });
});

describe('vault-scoped caches', () => {
    // NodeTypes/ConnectionTypes ids are per-database autoincrements, so a cache carried
    // across a switch would write one vault's type ids into another's Nodes rows.
    it('exposes a reset that clears the type-id cache', async () => {
        await switchVault(ALPHA);
        assert.ok(query._typeIds().tagNodeTypeId, 'the cache should populate on first use');

        query.onVaultOpened();
        assert.equal(query._typeCache, null);
    });

    it('re-resolves type ids against the vault that is now open', async () => {
        await switchVault(BETA);
        // The switch itself repopulates this — opening a vault ensures its system deck,
        // which reads the type ids. What matters is that they came from beta's database,
        // so they resolve to real rows there.
        const types = query._typeIds();
        assert.ok(types.tagNodeTypeId);
        assert.equal(
            db.prepare('SELECT name FROM NodeTypes WHERE id = ?').get(types.tagNodeTypeId)?.name,
            'Tag',
        );
        await switchVault(ALPHA);
    });
});
