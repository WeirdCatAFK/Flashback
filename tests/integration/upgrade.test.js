import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { testDataDir } from '../support/testData.js';

const ROOT = testDataDir('upgrade');
process.env.USER_DATA_PATH = ROOT;

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

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

const config = await import('../../src/api/access/primitives/config.js');
const { openVault } = await import('../../src/api/vaultSession.js');
const { default: db, closeDatabase } = await import('../../src/api/access/primitives/database.js');
const vaultRows = await import('../../src/api/access/resources/db/vault.js');
const Documents = await import('../../src/api/access/modules/documents.js');
const { sealTools } = await import('../../src/api/seal/seal.js');


async function snapshot() {
    return {
        schemaVersion: await vaultRows.getSchemaVersion(),
        formatVersion: Math.max(0, ...await vaultRows.getFormatVersions(), 0),
        documents: (await await db.prepare('SELECT name FROM Documents ORDER BY name').all()).map((r) => r.name),
        cards: (await db.prepare('SELECT COUNT(*) AS n FROM Flashcards').get()).n,
        categories: (await db.prepare('SELECT COUNT(*) AS n FROM PedagogicalCategories').get()).n,
        commits: (await sealTools.log(200)).map((c) => c.oid),
    };
}

describe('upgrading an install that predates the vault registry', () => {
    let before_;
    let sidecarBefore;

    before(async () => {
        assert.ok(await openVault(), 'the legacy config should open a vault');

        await Documents.createFile('kept.md', '');
        await Documents.createFile('also-kept.md', '');

        before_ = await snapshot();
        sidecarBefore = fs.readFileSync(
            path.join(config.getWorkspacePath(), 'kept.md.flashback'), 'utf-8',
        );

        closeDatabase();
        fs.rmSync(path.join(config.getVaultPath(), 'vault.json'), { force: true });
        writeLegacyConfig();
        config.reload();

        assert.ok(await openVault(), 'the new build must open a pre-upgrade vault');
    });

    after(() => {
        closeDatabase();
        try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {  }
    });

    it('runs no schema migration', async () => {
        const now = await snapshot();
        assert.equal(now.schemaVersion, before_.schemaVersion);
    });

    it('runs no format update, and does not rewrite the sidecars', async () => {
        const now = await snapshot();
        assert.equal(now.formatVersion, before_.formatVersion);

        const sidecarAfter = fs.readFileSync(
            path.join(config.getWorkspacePath(), 'kept.md.flashback'), 'utf-8',
        );
        assert.equal(sidecarAfter, sidecarBefore, 'the portable files must be untouched');
    });

    it('keeps the vault\'s data rather than rebuilding the database', async () => {
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

        assert.ok(!fs.existsSync(path.join(config.getWorkspacePath(), 'vault.json')));
    });

    it('leaves config.json\'s existing fields exactly as they were', () => {
        const onDisk = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf-8'));
        assert.deepEqual(onDisk, LEGACY_CONFIG);
    });

    it('synthesizes a registry from the flat fields instead of requiring one', () => {
        const vaults = config.getVaults();
        assert.equal(vaults.length, 1);
        assert.equal(vaults[0].name, 'dreams');
        assert.equal(vaults[0].id, null, 'an un-migrated config has no id to report');

        assert.equal(config.getActiveVaultId(), null);
        assert.deepEqual(config.getRemotes(), []);
        assert.deepEqual(config.getAllowedOrigins(), []);
    });

    it('still resolves every vault path the old way', () => {
        assert.equal(config.get().vaultName, 'dreams');
        assert.equal(config.getVaultPath(), path.join(ROOT, 'dreams'));
        assert.equal(config.getWorkspacePath(), path.join(ROOT, 'dreams', 'workspace'));
        assert.equal(config.getDatabasePath(), path.join(ROOT, 'dreams', 'dreams.db'));
    });
});
