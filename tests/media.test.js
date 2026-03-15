import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import validate from '../src/api/config/validate.js';
import process from 'process';

process.env.USER_DATA_PATH = path.join(process.cwd(), 'data');

if (!validate()) {
    process.exit(1);
}

import Documents from '../src/api/access/documents.js';
import db from '../src/api/access/database.js';

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

    it('should orchestrate media addition: Write to Disk AND Update DB', async () => {
        const docName = "OrchestratedMedia.md";
        const fcHash = "unique-hash-999";
        const mediaName = "diagram.png";

        await docs.createFile(docName, TEST_ROOT);
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
        await docs.updateFile(relPath, "# Science", metadata);

        const mediaBuffer = Buffer.from("fake-image-data-integrity-check");
        const expectedHash = crypto.createHash('sha256').update(mediaBuffer).digest('hex');

        await docs.addMediaToFlashcard(relPath, fcHash, mediaBuffer, mediaName);

        const fullPath = path.join(process.env.USER_DATA_PATH, 'workspace', TEST_ROOT, 'media', mediaName);
        assert.ok(fs.existsSync(fullPath), "File should be created in the media folder");
        assert.equal(fs.readFileSync(fullPath, 'utf-8'), "fake-image-data-integrity-check", "Content on disk must match");

        const mediaEntry = db.prepare('SELECT * FROM Media WHERE name = ?').get(mediaName);

        assert.ok(mediaEntry, "Media table should have an entry");
        assert.equal(mediaEntry.hash, expectedHash, "DB Hash should match the SHA256 of the buffer");
        assert.ok(mediaEntry.relative_path.includes(mediaName), "Relative path in DB should be correct");

        const updatedMeta = docs.files.getMetadata(relPath);
        const card = updatedMeta.flashcards.find(f => f.globalHash === fcHash);
        const trimmedName = mediaName.split('.')[0];
        assert.ok(card.customData.media[trimmedName], "Metadata should reference the new media");
    });

    it('should rollback file creation if database fails', async () => {
        const docName = "FailTest.md";
        await docs.createFile(docName, TEST_ROOT);

        const buffer = Buffer.from("data");

        await assert.rejects(
            docs.addMediaToFlashcard(path.join(TEST_ROOT, docName), "non-existent-hash", buffer, "fail.png"),
            /Flashcard non-existent-hash not found/
        );

        const failPath = path.join(process.env.USER_DATA_PATH, 'workspace', TEST_ROOT, 'media', 'fail.png');
        assert.equal(fs.existsSync(failPath), false, "File should not be written on logic error");
    });
});