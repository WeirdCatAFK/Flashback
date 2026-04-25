import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';
import process from 'process';
import validate from '../src/api/config/validate.js';
import Documents from '../src/api/access/documents.js';
import db from '../src/api/access/database.js';
import { sealTools } from '../src/api/seal/seal.js';

process.env.USER_DATA_PATH = path.join(process.cwd(), 'data');
console.log('USER_DATA_PATH:', process.env.USER_DATA_PATH);

if (!validate()) {
    console.error('Validation failed.');
    process.exit(1);
}


const docs = new Documents();
const TEST_ROOT = "PerfTestWorkspace";

describe('Performance: Large File Operations', () => {

    // --- CLEANUP ---
    const cleanup = () => {
        try {
            const absPath = path.join(process.env.USER_DATA_PATH, 'workspace', TEST_ROOT);
            if (fs.existsSync(absPath)) fs.rmSync(absPath, { recursive: true, force: true });
        } catch (e) { }
    };

    before(async () => {
        cleanup();
        await sealTools.init();
        await docs.createFolder(TEST_ROOT);
    });

    after(() => {
        db.close();
        fs.rmSync(path.join(process.cwd(), 'data'), { recursive: true, force: true });
    });

    it('should import a 500MB file with 100 flashcards within reasonable time', async () => {
        const fileName = "HugeDummyFile.bin";
        const fileSizeMB = 500;
        const byteSize = fileSizeMB * 1024 * 1024;
        const TIME_LIMIT_MS = 15000;

        console.log(`\n Generating ${fileSizeMB}MB dummy buffer...`);

        const content = Buffer.allocUnsafe(byteSize);
        content.fill('S', 0, 100);
        content.fill('E', byteSize - 100, byteSize);

        const CARD_COUNT = 100;
        const flashcards = Array.from({ length: CARD_COUNT }, (_, i) => ({
            globalHash: crypto.randomUUID(),
            name: `Card ${i}`,
            level: 0,
            lastRecall: new Date().toISOString(),
            vanillaData: {
                frontText: `Question ${i} for big file`,
                backText: `Answer ${i} hidden in 500MB of data`
            }
        }));

        const metadata = {
            globalHash: crypto.randomUUID(),
            tags: ["Performance", "HugeFile"],
            flashcards
        };

        console.log(`Starting Import...`);
        const start = performance.now();

        await docs.importFile(fileName, TEST_ROOT, content, metadata);

        const duration = performance.now() - start;
        const seconds = (duration / 1000).toFixed(2);
        console.log(`IMPORT COMPLETE: ${fileSizeMB}MB + ${CARD_COUNT} Cards in ${seconds}s`);

        assert.ok(duration < TIME_LIMIT_MS, `Import took ${seconds}s — must complete in under ${TIME_LIMIT_MS / 1000}s`);

        // 1. Document exists in DB
        const fileRelPath = path.join(TEST_ROOT, fileName);
        const docEntry = docs.exists(fileRelPath, true, false);
        assert.ok(docEntry, "Document should exist in DB");

        // 2. File size on disk is correct
        const fullPath = path.join(process.env.USER_DATA_PATH, 'workspace', fileRelPath);
        const stats = fs.statSync(fullPath);
        assert.equal(stats.size, byteSize, "File on disk should match the generated size exactly");

        // 3. All flashcards were persisted
        const { default: db } = await import('../src/api/access/database.js');
        const fcCount = db.prepare('SELECT COUNT(*) as c FROM Flashcards WHERE document_id = ?').get(docEntry.id).c;
        assert.equal(fcCount, CARD_COUNT, `All ${CARD_COUNT} flashcards should be stored in the DB`);
    });
});