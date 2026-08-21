/**
 * Upgrading an existing install into the vault-registry build.
 *
 * The vault changer added a manifest file, four config.json fields and a rebindable
 * database handle — but NO schema migration and NO canonical update. That claim is only
 * worth as much as a test of it, because the failure it guards against is the expensive
 * kind: a user launches the new build over a vault they have been studying in for months
 * and finds it rebuilt, re-walked, or empty.
 *
 * So this file does not test the new features. It asserts that an install which predates
 * all of them opens untouched: same schema version, same canonical version, same
 * documents, same cards, same Seal history.
 *
 * The pre-upgrade state is reconstructed rather than mocked — a real vault is built, then
 * everything this feature adds to disk is stripped back off it (vault.json deleted,
 * config.json rewritten to its old flat shape). What remains is byte-for-byte what an
 * older build leaves behind, since the older build wrote every other file with the same
 * code that is still here.
 *
 * Run: node --test tests/upgrade.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';

const ROOT = path.join(process.cwd(), 'data_test_upgrade');
process.env.USER_DATA_PATH = ROOT;

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

// config.json exactly as an install predating this work has it: the flat fields and
// nothing else. No vaults[], no activeVaultId, no remotes[], no allowedOrigins.
const LEGACY_CONFIG = {
    port: 50500,
    logFormat: 'dev',
    host: 'localhost',
    isLocalhost: true,
    isCustomPath: false,
    customPath: '',
    vaultName: 'dreams',
};

function writeLegacyConfig() {
    fs.writeFileSync(path.join(ROOT, 'config.json'), JSON.stringify(LEGACY_CONFIG, null, 2));
}

writeLegacyConfig();

const config = await import('../src/api/access/primitives/config.js');
const { openVault } = await import('../src/api/vaultSession.js');
const { closeDatabase } = await import('../src/api/access/primitives/database.js');
const { default: query } = await import('../src/api/access/resources/query.js');
const { default: Documents } = await import('../src/api/access/orchestration/documents.js');
const { sealTools } = await import('../src/api/seal/seal.js');

const docs = new Documents();

/** State that must be identical either side of the upgrade. */
async function snapshot() {
    return {
        schemaVersion: await query.getSchemaVersion(),
        canonicalVersion: Math.max(0, ...await query.getCanonicalVersions(), 0),
        documents: (await await query.db.prepare('SELECT name FROM Documents ORDER BY name').all()).map((r) => r.name),
        cards: (await query.db.prepare('SELECT COUNT(*) AS n FROM Flashcards').get()).n,
        categories: (await query.db.prepare('SELECT COUNT(*) AS n FROM PedagogicalCategories').get()).n,
        commits: (await sealTools.log(200)).map((c) => c.oid),
    };
}

describe('upgrading an install that predates the vault registry', () => {
    let before_;
    let sidecarBefore;

    before(async () => {
        // 1. Build a vault the way the previous build would have: open it, use it.
        assert.ok(await openVault(), 'the legacy config should open a vault');

        await docs.createFile('kept.md', '');
        await docs.createFile('also-kept.md', '');

        before_ = await snapshot();
        sidecarBefore = fs.readFileSync(
            path.join(config.getWorkspacePath(), 'kept.md.flashback'), 'utf-8',
        );

        // 2. Strip everything this feature added to disk, leaving the pre-upgrade state.
        closeDatabase();
        fs.rmSync(path.join(config.getVaultPath(), 'vault.json'), { force: true });
        writeLegacyConfig();
        config.reload();

        // 3. First launch of the new build over that install.
        assert.ok(await openVault(), 'the new build must open a pre-upgrade vault');
    });

    after(() => {
        closeDatabase();
        try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* Windows handle lag */ }
    });

    it('runs no schema migration', async () => {
        // A new migration would have bumped this. The point of the assertion is not the
        // number 9 but that the number did not MOVE — no user's database is rewritten.
        const now = await snapshot();
        assert.equal(now.schemaVersion, before_.schemaVersion);
    });

    it('runs no canonical update, and does not rewrite the sidecars', async () => {
        const now = await snapshot();
        assert.equal(now.canonicalVersion, before_.canonicalVersion);

        // UpdateRunner walking would rewrite every sidecar and seal the result. Comparing
        // the file's bytes catches a rewrite even if it happened to preserve the version.
        const sidecarAfter = fs.readFileSync(
            path.join(config.getWorkspacePath(), 'kept.md.flashback'), 'utf-8',
        );
        assert.equal(sidecarAfter, sidecarBefore, 'the canonical layer must be untouched');
    });

    it('keeps the vault\'s data rather than rebuilding the database', async () => {
        // The nightmare case: validation decides the schema is wrong, rebuilds it, and the
        // user's documents are gone. Documents surviving is what proves it did not.
        const now = await snapshot();
        assert.deepEqual(now.documents, before_.documents);
        assert.deepEqual(now.documents, ['also-kept.md', 'kept.md']);
        assert.equal(now.cards, before_.cards);
        assert.equal(now.categories, before_.categories,
            'a reseed would duplicate the default categories');
    });

    it('adds no Seal commits — the upgrade is invisible to the history', async () => {
        const now = await snapshot();
        assert.deepEqual(now.commits, before_.commits);
    });

    it('stamps an identity onto the existing vault, outside the Seal repo', () => {
        const manifestPath = path.join(config.getVaultPath(), 'vault.json');
        assert.ok(fs.existsSync(manifestPath), 'an upgraded vault acquires an id on first launch');

        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        assert.ok(manifest.id);
        assert.equal(manifest.name, 'dreams');

        // Untracked by git, so it neither shows up in the user's Seal history nor gets
        // rolled back with it.
        assert.ok(!fs.existsSync(path.join(config.getWorkspacePath(), 'vault.json')));
    });

    it('leaves config.json\'s existing fields exactly as they were', () => {
        // The API process must not write the registry — that is Electron main's field to
        // own — and must never disturb the flat fields an older build reads.
        const onDisk = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf-8'));
        assert.deepEqual(onDisk, LEGACY_CONFIG);
    });

    it('synthesizes a registry from the flat fields instead of requiring one', () => {
        // Every new config reader has to answer sensibly for a config.json that has none
        // of the new fields, because that is what every existing install looks like until
        // Electron main writes the registry.
        const vaults = config.getVaults();
        assert.equal(vaults.length, 1);
        assert.equal(vaults[0].name, 'dreams');
        assert.equal(vaults[0].id, null, 'an un-migrated config has no id to report');

        assert.equal(config.getActiveVaultId(), null);
        assert.deepEqual(config.getRemotes(), []);
        assert.deepEqual(config.getAllowedOrigins(), []);
    });

    it('still resolves every vault path the old way', () => {
        // The flat fields remain the projection that actually resolves paths, so a config
        // with no registry addresses the same folders it always did.
        assert.equal(config.get().vaultName, 'dreams');
        assert.equal(config.getVaultPath(), path.join(ROOT, 'dreams'));
        assert.equal(config.getWorkspacePath(), path.join(ROOT, 'dreams', 'workspace'));
        assert.equal(config.getDatabasePath(), path.join(ROOT, 'dreams', 'dreams.db'));
    });
});
