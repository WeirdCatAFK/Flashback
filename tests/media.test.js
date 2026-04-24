import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import validate from '../src/api/config/validate.js';
import process from 'process';

process.env.USER_DATA_PATH = path.join(process.cwd(), 'data');
console.log('USER_DATA_PATH:', process.env.USER_DATA_PATH);

if (!validate()) {
    console.error('Validation failed.');
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
        db.close();
        fs.rmSync(path.join(process.cwd(), 'data'), { recursive: true, force: true });
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

    it('should attach vanilla audio to the front of a flashcard', async () => {
        const docName = "VanillaAudio.md";
        const fcHash = "vanilla-audio-hash";
        const relPath = path.join(TEST_ROOT, docName);

        await docs.createFile(docName, TEST_ROOT);
        await docs.updateFile(relPath, '# Audio test', {
            flashcards: [{ globalHash: fcHash, level: 0, vanillaData: {} }]
        });

        const audioBuffer = Buffer.from("fake-audio-data");
        docs.files.addVanillaData(relPath, audioBuffer, "narration.mp3", "sound", "front", 0);

        const audioPath = path.join(process.env.USER_DATA_PATH, 'workspace', TEST_ROOT, 'media', 'narration.mp3');
        assert.ok(fs.existsSync(audioPath), "Audio file should be written to the media folder");

        const meta = docs.files.getMetadata(relPath);
        assert.equal(
            meta.flashcards[0].vanillaData.media.frontSound,
            './media/narration.mp3',
            "Sidecar should reference the audio file under frontSound"
        );
    });

    it('should attach a vanilla image to the back of a flashcard', async () => {
        const docName = "VanillaImage.md";
        const fcHash = "vanilla-image-hash";
        const relPath = path.join(TEST_ROOT, docName);

        await docs.createFile(docName, TEST_ROOT);
        await docs.updateFile(relPath, '# Image test', {
            flashcards: [{ globalHash: fcHash, level: 0, vanillaData: {} }]
        });

        const imgBuffer = Buffer.from("fake-image-data");
        docs.files.addVanillaData(relPath, imgBuffer, "back-figure.png", "image", "back", 0);

        const imgPath = path.join(process.env.USER_DATA_PATH, 'workspace', TEST_ROOT, 'media', 'back-figure.png');
        assert.ok(fs.existsSync(imgPath), "Image file should be written to the media folder");

        const meta = docs.files.getMetadata(relPath);
        assert.equal(
            meta.flashcards[0].vanillaData.media.backImg,
            './media/back-figure.png',
            "Sidecar should reference the image under backImg"
        );
    });

    it('should remove a custom media file and clean up all sidecar references', async () => {
        // Reuse the orchestrated doc from test 2; diagram.png was added as customData there
        const relPath = path.join(TEST_ROOT, "OrchestratedMedia.md");
        const mediaName = "diagram.png";

        // Verify precondition: file and sidecar reference both exist
        const metaBefore = docs.files.getMetadata(relPath);
        const cardBefore = metaBefore.flashcards[0];
        assert.ok(cardBefore.customData?.media?.diagram, "Precondition: sidecar should reference diagram before removal");

        docs.files.removeCustomMedia(relPath, mediaName);

        const fullPath = path.join(process.env.USER_DATA_PATH, 'workspace', TEST_ROOT, 'media', mediaName);
        assert.equal(fs.existsSync(fullPath), false, "Media file should be deleted from disk");

        const metaAfter = docs.files.getMetadata(relPath);
        const cardAfter = metaAfter.flashcards[0];
        const stillReferenced = cardAfter.customData?.media?.diagram;
        assert.ok(!stillReferenced, "Sidecar should no longer reference the removed media file");
    });
});