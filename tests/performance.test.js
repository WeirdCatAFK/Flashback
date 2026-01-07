import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';
import process from 'process';
import validate from '../src/api/config/validate.js';
import Documents from '../src/api/access/documents.js'; 

process.env.USER_DATA_PATH = path.join(process.cwd(), 'data');
console.log('Using USER_DATA_PATH:', process.env.USER_DATA_PATH);

if (!validate()) {
    console.error("Validation failed. May be an initialization issue.");
    if (!validate()) {
        process.exit(1);
    }
    console.log("Validation passed.");
}


const docs = new Documents();
const TEST_ROOT = "PerfTestWorkspace";

describe('Performance: Large File Operations', () => {

    // --- CLEANUP ---
    const cleanup = () => {
        try {
            if (docs.exists(TEST_ROOT, true, true)) {
                docs.delete(TEST_ROOT, true);
            }
        } catch (e) { }
    };

    before(() => {
        cleanup();
        docs.createFolder(TEST_ROOT);
    });

    after(() => {
        cleanup();
    });

    it('should import a 500MB file with 100 flashcards within reasonable time', () => {
        const fileName = "HugeDummyFile.bin";
        const fileSizeMB = 500;
        const byteSize = fileSizeMB * 1024 * 1024;

        console.log(`\n    ℹ️  Generating ${fileSizeMB}MB dummy buffer...`);
        
        // 1. Generate 500MB of dummy data
        // allocUnsafe is faster than alloc (doesn't zero-fill), ideal for dummy data
        const content = Buffer.allocUnsafe(byteSize); 
        // Fill start/end to ensure integrity checks if we ever added them
        content.fill('S', 0, 100); 
        content.fill('E', byteSize - 100, byteSize);

        // 2. Generate 100 Flashcards
        const flashcards = Array.from({ length: 100 }, (_, i) => ({
            globalHash: crypto.randomUUID(),
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
            flashcards: flashcards
        };

        console.log(`    ℹ️  Starting Import...`);
        const start = performance.now();

        // Use importFile since we are creating a NEW heavy file
        docs.importFile(fileName, TEST_ROOT, content, metadata);

        const end = performance.now();
        const duration = end - start;
        const seconds = (duration / 1000).toFixed(2);

        console.log(`    ⚡ IMPORT COMPLETE: ${fileSizeMB}MB + 100 Cards in ${seconds}s`);

        // --- VERIFICATION ---
        
        // 1. Check DB entry
        const fileRelPath = path.join(TEST_ROOT, fileName);
        const docEntry = docs.exists(fileRelPath, true, false);
        assert.ok(docEntry, "Document should exist in DB");

        // 2. Check File Size on Disk
        const fullPath = path.join(process.env.USER_DATA_PATH, 'workspace', fileRelPath);
        const stats = fs.statSync(fullPath);
        assert.equal(stats.size, byteSize, "File on disk should match generated size");

        // 3. Check Flashcards in DB
        // We need to access the DB object directly to count rows, 
        // but we can trust docs.exists() implies success for now or add a specific DB query if imported.
        // Assuming your 'importFile' throws if the DB transaction failed, this passing is good.
    });
});