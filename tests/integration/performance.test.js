import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';
import process from 'process';
import validate from '../../src/api/config/validate.js';
import Documents from '../../src/api/access/modules/documents.js';
import db from '../../src/api/access/primitives/database.js';
import { sealTools } from '../../src/api/seal/seal.js';
import { getWorkspacePath } from '../../src/api/access/primitives/config.js';
import { testDataDir } from '../support/testData.js';

process.env.USER_DATA_PATH = testDataDir('performance');

if (!await validate()) {
    console.error('Validation failed.');
    process.exit(1);
}

const docs = new Documents();
const TEST_ROOT = "PerfTestWorkspace";

const OVERHEAD_FACTOR = 5;

const makeCards = (n) => Array.from({ length: n }, (_, i) => ({
    globalHash: crypto.randomUUID(),
    level: 0,
    vanillaData: { frontText: `Q${i}`, backText: `A${i}` }
}));

describe('Performance: Import Throughput', () => {

    const cleanup = () => {
        try {
            const absPath = path.join(getWorkspacePath(), TEST_ROOT);
            if (fs.existsSync(absPath)) fs.rmSync(absPath, { recursive: true, force: true });
        } catch {}
    };

    before(async () => {
        cleanup();
        await sealTools.init();
        await docs.createFolder(TEST_ROOT);
    });

    after(async () => {
        db.close();
        await new Promise(resolve => setTimeout(resolve, 50));
        try {
            fs.rmSync(testDataDir('performance'), { recursive: true, force: true });
        } catch (e) {
            console.warn('Teardown warning (safe to ignore): Failed to delete data directory:', e.message);
        }
    });

    it('file-size scaling: 100MB import should stay proportional to 5MB baseline', async () => {
        const SMALL_MB = 5;
        const LARGE_MB = 100;

        const t0 = performance.now();
        await docs.importFile('cal_size.bin', TEST_ROOT, Buffer.allocUnsafe(SMALL_MB * 1024 * 1024), {
            globalHash: crypto.randomUUID(),
            flashcards: makeCards(10)
        });
        const baseMs = performance.now() - t0;

        const beforeHead = (await sealTools.log(1))[0]?.oid;
        const t1 = performance.now();
        await docs.importFile('large_size.bin', TEST_ROOT, Buffer.allocUnsafe(LARGE_MB * 1024 * 1024), {
            globalHash: crypto.randomUUID(),
            tags: ['Performance'],
            flashcards: makeCards(100)
        });
        const largeMs = performance.now() - t1;

        console.log(
            `File-size: ${SMALL_MB}MB → ${baseMs.toFixed(0)}ms (${(baseMs/SMALL_MB).toFixed(1)} ms/MB)  |  ` +
            `${LARGE_MB}MB → ${largeMs.toFixed(0)}ms (${(largeMs/LARGE_MB).toFixed(1)} ms/MB)  |  ` +
            `ratio ${(largeMs / baseMs / (LARGE_MB / SMALL_MB)).toFixed(2)}× (max ${OVERHEAD_FACTOR}×)`
        );

        const maxAllowed = baseMs * (LARGE_MB / SMALL_MB) * OVERHEAD_FACTOR;
        assert.ok(
            largeMs <= maxAllowed,
            `File-size scaling degraded: ${LARGE_MB}MB took ${largeMs.toFixed(0)}ms — ` +
            `${(largeMs / baseMs / (LARGE_MB / SMALL_MB)).toFixed(1)}× overhead (max ${OVERHEAD_FACTOR}×)`
        );

        const afterHead = (await sealTools.log(1))[0]?.oid;
        assert.notEqual(afterHead, beforeHead, 'importFile should produce a Seal commit');

        const doc = await docs.exists(path.join(TEST_ROOT, 'large_size.bin'), true, false);
        assert.ok(doc, 'Document should be in DB');
        const fcCount = (await db.prepare('SELECT COUNT(*) as c FROM Flashcards WHERE document_id = ?').get(doc.id)).c;
        assert.equal(fcCount, 100, 'All 100 flashcards should be stored');
    });

    it('card-count scaling: 500-card import should stay proportional to 10-card baseline', async () => {
        const SMALL_CARDS = 10;
        const LARGE_CARDS = 500;
        const FILE_SIZE = 100 * 1024;

        const t0 = performance.now();
        await docs.importFile('cal_cards.md', TEST_ROOT, Buffer.allocUnsafe(FILE_SIZE), {
            globalHash: crypto.randomUUID(),
            flashcards: makeCards(SMALL_CARDS)
        });
        const baseMs = performance.now() - t0;

        const t1 = performance.now();
        await docs.importFile('large_cards.md', TEST_ROOT, Buffer.allocUnsafe(FILE_SIZE), {
            globalHash: crypto.randomUUID(),
            flashcards: makeCards(LARGE_CARDS)
        });
        const largeMs = performance.now() - t1;

        console.log(
            `Card-count: ${SMALL_CARDS} cards → ${baseMs.toFixed(0)}ms  |  ` +
            `${LARGE_CARDS} cards → ${largeMs.toFixed(0)}ms  |  ` +
            `ratio ${(largeMs / baseMs / (LARGE_CARDS / SMALL_CARDS)).toFixed(2)}× (max ${OVERHEAD_FACTOR}×)`
        );

        const maxAllowed = baseMs * (LARGE_CARDS / SMALL_CARDS) * OVERHEAD_FACTOR;
        assert.ok(
            largeMs <= maxAllowed,
            `Card-count scaling degraded: ${LARGE_CARDS} cards took ${largeMs.toFixed(0)}ms — ` +
            `${(largeMs / baseMs / (LARGE_CARDS / SMALL_CARDS)).toFixed(1)}× overhead (max ${OVERHEAD_FACTOR}×)`
        );

        const doc = await docs.exists(path.join(TEST_ROOT, 'large_cards.md'), true, false);
        assert.ok(doc, 'Document should be in DB');
        const fcCount = (await db.prepare('SELECT COUNT(*) as c FROM Flashcards WHERE document_id = ?').get(doc.id)).c;
        assert.equal(fcCount, LARGE_CARDS, `All ${LARGE_CARDS} flashcards should be stored`);
    });
});
