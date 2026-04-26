import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import validate from '../src/api/config/validate.js';
import process from 'process';
import { sealTools } from '../src/api/seal/seal.js';

process.env.USER_DATA_PATH = path.join(process.cwd(), 'data');
console.log('USER_DATA_PATH:', process.env.USER_DATA_PATH);

if (!validate()) {
    console.error('Validation failed.');
    process.exit(1);
}

import Documents from '../src/api/access/documents.js';
import Media from '../src/api/access/media.js';
import db from '../src/api/access/database.js';

const docs = new Documents();
const media = new Media();
const TEST_ROOT = "MediaTestWorkspace";

describe('Media & Binary Operations', () => {

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
        // DB and data teardown deferred to the Media Orchestrator suite's after()
    });

    it('should attach an image file to a flashcard (Manual/Low-level)', async () => {
        const docName = "VisualNotes_LowLevel.md";
        const imgName = "blue_pixel_ll.png";

        await docs.createFile(docName, TEST_ROOT);
        await docs.updateFile(path.join(TEST_ROOT, docName), "# Art", {
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
        const beforeCommits = (await sealTools.log()).length;

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

        const afterCommits = (await sealTools.log()).length;
        assert.equal(afterCommits, beforeCommits + 1, "addMediaToFlashcard should produce one Seal commit");
        assert.ok((await sealTools.log())[0].commit.message.startsWith('edit:'), "Seal commit for media addition should be an edit");
    });

    it('should not write file when flashcard hash is not found in sidecar', async () => {
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

describe('Media Orchestrator', () => {
    const ORCH_ROOT = path.join(TEST_ROOT, "OrchestratorSuite");

    before(async () => {
        await docs.createFolder("OrchestratorSuite", TEST_ROOT);
    });

    after(() => {
        db.close();
        fs.rmSync(path.join(process.cwd(), 'data'), { recursive: true, force: true });
    });

    it('should add vanilla media: write file, update sidecar, register in DB, and fire a Seal commit', async () => {
        const docName = "VanillaOrchestrated.md";
        const fcHash = "vo-hash-001";
        const relPath = path.join(ORCH_ROOT, docName);

        await docs.createFile(docName, ORCH_ROOT);
        await docs.updateFile(relPath, '# Vanilla Orch', {
            flashcards: [{ globalHash: fcHash, level: 0, vanillaData: {} }]
        });

        const audioBuffer = Buffer.from("orchestrated-audio-data");
        const audioName = "orch-narration.mp3";
        const expectedHash = crypto.createHash('sha256').update(audioBuffer).digest('hex');
        const beforeHead = (await sealTools.log(1))[0]?.oid;

        await media.addVanillaMedia(relPath, fcHash, audioBuffer, audioName, "sound", "front");

        // File on disk
        const audioPath = path.join(process.env.USER_DATA_PATH, 'workspace', ORCH_ROOT, 'media', audioName);
        assert.ok(fs.existsSync(audioPath), "Audio file should be written to disk");

        // Sidecar updated
        const meta = docs.files.getMetadata(relPath);
        assert.equal(meta.flashcards[0].vanillaData.media.frontSound, `./media/${audioName}`, "Sidecar frontSound should be set");

        // DB entry
        const entry = db.prepare('SELECT * FROM Media WHERE hash = ?').get(expectedHash);
        assert.ok(entry, "Media table should have an entry");
        assert.equal(entry.hash, expectedHash, "DB hash should match SHA256 of the buffer");
        assert.ok(entry.absolute_path.endsWith(audioName), "DB absolute_path should reference the file");

        // Seal commit
        const afterLog = await sealTools.log(1);
        assert.notEqual(afterLog[0]?.oid, beforeHead, "addVanillaMedia should produce a new Seal commit");
        assert.ok(afterLog[0].commit.message.startsWith('edit:'), "Seal commit for vanilla media should be an edit");
    });

    it('should serve a registered media file by hash', async () => {
        // Use the audio file registered in the previous test
        const audioBuffer = Buffer.from("orchestrated-audio-data");
        const hash = crypto.createHash('sha256').update(audioBuffer).digest('hex');

        const entry = media.serve(hash);
        assert.ok(entry, "serve() should return a DB entry");
        assert.equal(entry.hash, hash, "Returned entry hash must match");
        assert.ok(fs.existsSync(entry.absolute_path), "serve() should only return entries whose file exists on disk");
    });

    it('should throw from serve() when the hash is unknown', () => {
        assert.throws(
            () => media.serve("0000000000000000000000000000000000000000000000000000000000000000"),
            /Media not found/
        );
    });

    it('should list media files in a folder, including hash for DB-registered files', async () => {
        const items = media.list(ORCH_ROOT);
        assert.ok(Array.isArray(items), "list() should return an array");
        assert.ok(items.length > 0, "list() should find the audio file added earlier");

        const audio = items.find(i => i.name === "orch-narration.mp3");
        assert.ok(audio, "list() should include orch-narration.mp3");
        assert.ok(audio.hash !== null, "DB-registered file should have a non-null hash");
        assert.ok(fs.existsSync(audio.absolutePath), "Reported absolutePath should exist on disk");
    });

    it('should remove media: delete file, clean sidecar, remove DB entry, and fire a Seal commit', async () => {
        const docName = "VanillaOrchestrated.md";
        const audioName = "orch-narration.mp3";
        const relPath = path.join(ORCH_ROOT, docName);

        const audioBuffer = Buffer.from("orchestrated-audio-data");
        const hash = crypto.createHash('sha256').update(audioBuffer).digest('hex');

        const beforeHead = (await sealTools.log(1))[0]?.oid;

        await media.removeMedia(relPath, audioName);

        // File gone
        const audioPath = path.join(process.env.USER_DATA_PATH, 'workspace', ORCH_ROOT, 'media', audioName);
        assert.equal(fs.existsSync(audioPath), false, "Media file should be deleted from disk");

        // Sidecar cleaned
        const meta = docs.files.getMetadata(relPath);
        assert.ok(!meta.flashcards[0].vanillaData?.media?.frontSound, "Sidecar frontSound reference should be removed");

        // DB entry gone
        const entry = db.prepare('SELECT * FROM Media WHERE hash = ?').get(hash);
        assert.equal(entry, undefined, "DB entry should be deleted");

        // Seal commit
        const afterLog = await sealTools.log(1);
        assert.notEqual(afterLog[0]?.oid, beforeHead, "removeMedia should produce a new Seal commit");
        assert.ok(afterLog[0].commit.message.startsWith('edit:'), "Seal commit for removal should be an edit");
    });

    it('should reconcile: remove DB entries for missing files, leave existing ones intact', async () => {
        // Register a phantom entry directly in the DB (file never written to disk)
        const phantomHash = "deadbeef".repeat(8);
        const phantomAbs = path.join(process.env.USER_DATA_PATH, 'workspace', ORCH_ROOT, 'media', 'ghost.png');
        db.prepare('INSERT INTO Media (hash, name, relative_path, absolute_path) VALUES (?, ?, ?, ?)')
            .run(phantomHash, 'ghost.png', path.join(ORCH_ROOT, 'media', 'ghost.png'), phantomAbs);

        // Add a real file to the DB so we can confirm it survives reconciliation
        const realBuffer = Buffer.from("real-media-data");
        const realName = "real-for-reconcile.png";
        const realRelPath = path.join(ORCH_ROOT, "VanillaOrchestrated.md");
        await media.addVanillaMedia(realRelPath, "vo-hash-001", realBuffer, realName, "image", "back");

        const orphans = media.reconcile(ORCH_ROOT);

        assert.ok(orphans.some(o => o.name === 'ghost.png'), "reconcile() should report the phantom file as an orphan");

        const phantom = db.prepare('SELECT * FROM Media WHERE hash = ?').get(phantomHash);
        assert.equal(phantom, undefined, "Phantom DB entry should be deleted");

        const realHash = crypto.createHash('sha256').update(realBuffer).digest('hex');
        const real = db.prepare('SELECT * FROM Media WHERE hash = ?').get(realHash);
        assert.ok(real, "Real media DB entry should survive reconciliation");
    });
});