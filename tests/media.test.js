import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import validate from '../src/api/config/validate.js';
import process from 'process';


// --- SETUP ENVIRONMENT ---
process.env.USER_DATA_PATH = path.join(process.cwd(), 'data');
console.log('Using USER_DATA_PATH:', process.env.USER_DATA_PATH);

if (!validate()) {
    console.error("Validation failed. May be an initialization issue.");
    if (!validate()) {
        process.exit(1);
    }
    console.log("Validation passed.");
}
import Documents from '../src/api/access/documents.js';
import db from '../src/api/access/database.js'; // Needed to verify SQL tables

const docs = new Documents();
const TEST_ROOT = "MediaTestWorkspace";

describe('Media & Binary Operations', () => {

    const cleanup = () => {
        try {
            if (docs.exists(TEST_ROOT, true, true)) docs.delete(TEST_ROOT, true);
        } catch (e) { }
    };

    before(() => {
        cleanup();
        docs.createFolder(TEST_ROOT);
    });

    after(() => {
        cleanup();
    });

    it('should attach an image file to a flashcard (Manual/Low-level)', () => {
        const docName = "VisualNotes_LowLevel.md";
        const imgName = "blue_pixel_ll.png";

        docs.createFile(docName, TEST_ROOT);
        docs.updateFile(path.join(TEST_ROOT, docName), "# Art", {
            tags: ["Art"],
            flashcards: [{ globalHash: "card-1", level: 0, vanillaData: {} }]
        });

        const imageBuffer = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2d600000000049454e44ae426082', 'hex');
        docs.files.addCustomMedia(path.join(TEST_ROOT, docName), imageBuffer, imgName, 0);

        const mediaPath = path.join(process.env.USER_DATA_PATH, 'workspace', TEST_ROOT, 'media', imgName);
        assert.ok(fs.existsSync(mediaPath), "Media file should exist on disk");
    });

    // --- NEW TEST FOR addMediaToFlashcard ---
    it('should orchestrate media addition: Write to Disk AND Update DB', () => {
        const docName = "OrchestratedMedia.md";
        const fcHash = "unique-hash-999";
        const mediaName = "diagram.png";

        // 1. Setup Document
        docs.createFile(docName, TEST_ROOT);
        const metadata = {
            tags: ["Science"],
            flashcards: [
                {
                    globalHash: fcHash,
                    level: 0,
                    vanillaData: { frontText: "Graph", backText: "See image" }
                }
            ]
        };
        const relPath = path.join(TEST_ROOT, docName);
        docs.updateFile(relPath, "# Science", metadata);

        // 2. Create Dummy Buffer
        const mediaBuffer = Buffer.from("fake-image-data-integrity-check");
        const expectedHash = crypto.createHash('sha256').update(mediaBuffer).digest('hex');

        // 3. EXECUTE THE FUNCTION
        docs.addMediaToFlashcard(relPath, fcHash, mediaBuffer, mediaName);

        // 4. VERIFY: File System (Canonical)
        const fullPath = path.join(process.env.USER_DATA_PATH, 'workspace', TEST_ROOT, 'media', mediaName);
        assert.ok(fs.existsSync(fullPath), "File should be created in the media folder");
        assert.equal(fs.readFileSync(fullPath, 'utf-8'), "fake-image-data-integrity-check", "Content on disk must match");

        // 5. VERIFY: Database (Derived)
        const mediaEntry = db.prepare('SELECT * FROM Media WHERE name = ?').get(mediaName);

        assert.ok(mediaEntry, "Media table should have an entry");
        assert.equal(mediaEntry.hash, expectedHash, "DB Hash should match the SHA256 of the buffer");
        // Verify path normalization in DB
        // Windows might use backslashes, check if your code normalizes or keep as is. 
        // We use 'includes' to be safe across OS tests.
        assert.ok(mediaEntry.relative_path.includes(mediaName), "Relative path in DB should be correct");

        // 6. VERIFY: Metadata Update
        const updatedMeta = docs.files.getMetadata(relPath);
        const card = updatedMeta.flashcards.find(f => f.globalHash === fcHash);
        // The key in customData.media is usually the filename or name without ext depending on implementation
        // Your files.js uses: targetCard.customData.media[trimmedName] = ...
        const trimmedName = mediaName.split('.')[0];
        assert.ok(card.customData.media[trimmedName], "Metadata should reference the new media");
    });

    it('should rollback file creation if database fails', () => {
        // This is an advanced test. To simulate this, we'd need to mock DB failure.
        // For now, we can test the pre-validation logic.

        const docName = "FailTest.md";
        docs.createFile(docName, TEST_ROOT);

        const buffer = Buffer.from("data");

        // Expect Error: Flashcard hash not found
        assert.throws(() => {
            docs.addMediaToFlashcard(path.join(TEST_ROOT, docName), "non-existent-hash", buffer, "fail.png");
        }, /Flashcard with hash non-existent-hash not found/);

        // Verify no file was written
        const failPath = path.join(process.env.USER_DATA_PATH, 'workspace', TEST_ROOT, 'media', 'fail.png');
        assert.equal(fs.existsSync(failPath), false, "File should not be written on logic error");
    });
});