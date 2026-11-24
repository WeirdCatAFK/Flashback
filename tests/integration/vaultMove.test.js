import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import AdmZip from 'adm-zip';
import { testDataDir } from '../support/testData.js';

process.env.USER_DATA_PATH = testDataDir('vaultMove');
fs.rmSync(process.env.USER_DATA_PATH, { recursive: true, force: true });

const { default: validate } = await import('../../src/api/config/validate.js');
if (!await validate()) {
    console.error('Validation failed.');
    process.exit(1);
}

const Documents = await import('../../src/api/access/modules/documents.js');
const config = await import('../../src/api/access/primitives/config.js');
const documentRows = await import('../../src/api/access/resources/db/documents.js');
const { default: db } = await import('../../src/api/access/primitives/database.js');
const { sealTools, sealEmitter } = await import('../../src/api/seal/seal.js');
const { openVault, releaseVault } = await import('../../src/api/vaultSession.js');
const { exportVault, importVault } = await import('../../scripts/vaultMove.js');

const DOC = path.join('Moved', 'note.md');
const ZIP = path.join(testDataDir('vaultMove'), 'vault.zip');
const card = crypto.randomUUID();

describe('moving a vault to another install', () => {
    before(async () => {
        await sealTools.init();
        await Documents.createFolder('Moved');
        await Documents.importFile('note.md', 'Moved', Buffer.from('# Moved'), {
            globalHash: crypto.randomUUID(),
            flashcards: [{ globalHash: card, vanillaData: { frontText: 'Q', backText: 'A' } }],
        });
        await Documents.submitReview(DOC, card, 1, 2.5, 3);
        await sealEmitter.flushEdits();
    });

    after(async () => await releaseVault());

    it('exports the portable files, progress.db and vault.json, without the Seal history', () => {
        exportVault(config.getVaultPath(), ZIP);
        const names = new AdmZip(ZIP).getEntries().map((e) => e.entryName);
        assert.ok(names.includes('workspace/Moved/note.md'));
        assert.ok(names.includes('workspace/Moved/note.md.flashback'));
        assert.ok(names.includes('progress.db'));
        assert.ok(names.includes('vault.json'));
        assert.ok(!names.some((n) => n.includes('.git/')), 'Seal history stays behind');
    });

    it('imports into a new vault, rebuilds the index and keeps the progress', async () => {
        await releaseVault();
        config.set({ ...config.get(), vaultName: 'moved' });

        const result = await importVault(ZIP);
        assert.equal(result.summary.documentsIndexed, 1);

        await openVault();
        assert.ok(await documentRows.getByPath(DOC), 'the document is in the new index');
        const row = await db.prepare('SELECT level FROM progress.CardProgress WHERE card_hash = ?').get(card);
        assert.equal(row?.level, 3, 'the review survived the move');
    });

    it('refuses to import over a vault that already holds documents', async () => {
        await releaseVault();
        await assert.rejects(() => importVault(ZIP), /already holds/);
        await openVault();
    });
});
