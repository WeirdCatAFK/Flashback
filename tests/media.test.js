import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import validate from '../src/api/config/validate.js';
import process from 'process';
import { sealTools, sealEmitter } from '../src/api/seal/seal.js';
import { getWorkspacePath } from '../src/api/access/primitives/config.js';

process.env.USER_DATA_PATH = path.join(process.cwd(), 'data');
console.log('USER_DATA_PATH:', process.env.USER_DATA_PATH);

if (!await validate()) {
    console.error('Validation failed.');
    process.exit(1);
}

import Documents from '../src/api/access/orchestration/documents.js';
import Media from '../src/api/access/orchestration/media.js';
import db from '../src/api/access/primitives/database.js';

const docs = new Documents();
const media = new Media();
const TEST_ROOT = "MediaTestWorkspace";

describe('Media & Binary Operations', () => {

    const cleanup = () => {
        try {
            const absPath = path.join(getWorkspacePath(),TEST_ROOT);
            if (fs.existsSync(absPath)) fs.rmSync(absPath, { recursive: true, force: true });
        } catch (e) { }
    };

    before(async () => {
        cleanup();
        await db.exec(`
            PRAGMA foreign_keys = OFF;
            DELETE FROM FlashcardReference;
            DELETE FROM FlashcardContent;
            DELETE FROM Flashcards;
            DELETE FROM DocumentLinks;
            DELETE FROM Documents;
            DELETE FROM Folders;
            DELETE FROM Connections;
            DELETE FROM InheritedTags;
            DELETE FROM Tags;
            DELETE FROM ReviewLogs;
            DELETE FROM Media;
            DELETE FROM Decks;
            DELETE FROM DeckEntries;
            DELETE FROM Subscriptions;
            PRAGMA foreign_keys = ON;
        `);
        const gitDir = path.join(getWorkspacePath(), '.git');
        if (fs.existsSync(gitDir)) {
            fs.rmSync(gitDir, { recursive: true, force: true });
        }
        await sealTools.init();
        await docs.createFolder(TEST_ROOT);
    });

    after(() => {
        // DB and data teardown deferred to the move/copy suite's after()
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

        const mediaPath = path.join(getWorkspacePath(),TEST_ROOT, 'media', imgName);
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
        const beforeCommits = (await sealTools.log(1000)).length;

        await docs.addMediaToFlashcard(relPath, fcHash, mediaBuffer, mediaName);

        const fullPath = path.join(getWorkspacePath(),TEST_ROOT, 'media', mediaName);
        assert.ok(fs.existsSync(fullPath), "File should be created in the media folder");
        assert.equal(fs.readFileSync(fullPath, 'utf-8'), "fake-image-data-integrity-check", "Content on disk must match");

        const mediaEntry = await db.prepare('SELECT * FROM Media WHERE name = ?').get(mediaName);

        assert.ok(mediaEntry, "Media table should have an entry");
        assert.equal(mediaEntry.hash, expectedHash, "DB Hash should match the SHA256 of the buffer");
        assert.ok(mediaEntry.relative_path.includes(mediaName), "Relative path in DB should be correct");

        const updatedMeta = docs.files.getMetadata(relPath);
        const card = updatedMeta.flashcards.find(f => f.globalHash === fcHash);
        const trimmedName = mediaName.split('.')[0];
        assert.ok(card.customData.media[trimmedName], "Metadata should reference the new media");

        await sealEmitter.flushEdits();
        const afterCommits = (await sealTools.log(1000)).length;
        assert.equal(afterCommits, beforeCommits + 1, "addMediaToFlashcard should produce one Seal commit");
        assert.ok((await sealTools.log(1000))[0].commit.message.startsWith('edit:'), "Seal commit for media addition should be an edit");
    });

    it('should not write file when flashcard hash is not found in sidecar', async () => {
        const docName = "FailTest.md";
        await docs.createFile(docName, TEST_ROOT);

        const buffer = Buffer.from("data");

        await assert.rejects(
            async () => await docs.addMediaToFlashcard(path.join(TEST_ROOT, docName), "non-existent-hash", buffer, "fail.png"),
            /Flashcard non-existent-hash not found/
        );

        const failPath = path.join(getWorkspacePath(),TEST_ROOT, 'media', 'fail.png');
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

        const audioPath = path.join(getWorkspacePath(),TEST_ROOT, 'media', 'narration.mp3');
        assert.ok(fs.existsSync(audioPath), "Audio file should be written to the media folder");

        const meta = docs.files.getMetadata(relPath);
        assert.equal(
            meta.flashcards[0].vanillaData.media.front_sound,
            './media/narration.mp3',
            "Sidecar should reference the audio file under front_sound"
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

        const imgPath = path.join(getWorkspacePath(),TEST_ROOT, 'media', 'back-figure.png');
        assert.ok(fs.existsSync(imgPath), "Image file should be written to the media folder");

        const meta = docs.files.getMetadata(relPath);
        assert.equal(
            meta.flashcards[0].vanillaData.media.back_img,
            './media/back-figure.png',
            "Sidecar should reference the image under back_img"
        );
    });

    it('should create a flashcard with attached media in one call (no client sequencing)', async () => {
        const docName = "CreateWithMedia.md";
        const relPath = path.join(TEST_ROOT, docName);
        await docs.createFile(docName, TEST_ROOT);

        const imgBuffer = Buffer.from("inline-front-image");
        const expectedHash = crypto.createHash('sha256').update(imgBuffer).digest('hex');

        const card = await docs.createFlashcard(
            relPath,
            { vanillaData: { frontText: "Q?", backText: "A." }, tags: ["Inline"], category: "Concept" },
            [{ buffer: imgBuffer, originalName: "front.png", type: "image", position: "front" }]
        );

        // Returned card carries an API-assigned hash and the media reference.
        assert.ok(card.globalHash, "Created card should have an API-assigned globalHash");
        assert.match(card.vanillaData.media.front_img, /^\.\/media\/front-[0-9a-f]{8}\.png$/, "front_img should reference the generated media name");

        // Media file is on disk under the generated name.
        const mediaName = card.vanillaData.media.front_img.replace('./media/', '');
        const mediaPath = path.join(getWorkspacePath(),TEST_ROOT, 'media', mediaName);
        assert.ok(fs.existsSync(mediaPath), "Generated media file should exist on disk");

        // Derived layer: media + flashcard rows registered.
        const mediaEntry = await db.prepare('SELECT * FROM Media WHERE hash = ?').get(expectedHash);
        assert.ok(mediaEntry, "Media table should have an entry for the attached file");
        const fcRow = await db.prepare('SELECT * FROM Flashcards WHERE global_hash = ?').get(card.globalHash);
        assert.ok(fcRow, "Flashcard should be synced into the derived layer");
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

        const fullPath = path.join(getWorkspacePath(),TEST_ROOT, 'media', mediaName);
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
        // DB and data teardown deferred to the move/copy suite's after()
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
        const audioPath = path.join(getWorkspacePath(),ORCH_ROOT, 'media', audioName);
        assert.ok(fs.existsSync(audioPath), "Audio file should be written to disk");

        // Sidecar updated
        const meta = docs.files.getMetadata(relPath);
        assert.equal(meta.flashcards[0].vanillaData.media.front_sound, `./media/${audioName}`, "Sidecar front_sound should be set");

        // DB entry
        const entry = await db.prepare('SELECT * FROM Media WHERE hash = ?').get(expectedHash);
        assert.ok(entry, "Media table should have an entry");
        assert.equal(entry.hash, expectedHash, "DB hash should match SHA256 of the buffer");
        assert.ok(entry.absolute_path.endsWith(audioName), "DB absolute_path should reference the file");

        // Seal commit
        await sealEmitter.flushEdits();
        const afterLog = await sealTools.log(1);
        assert.notEqual(afterLog[0]?.oid, beforeHead, "addVanillaMedia should produce a new Seal commit");
        assert.ok(afterLog[0].commit.message.startsWith('edit:'), "Seal commit for vanilla media should be an edit");
    });

    it('should serve a registered media file by hash', async () => {
        // Use the audio file registered in the previous test
        const audioBuffer = Buffer.from("orchestrated-audio-data");
        const hash = crypto.createHash('sha256').update(audioBuffer).digest('hex');

        const entry = await media.serve(hash);
        assert.ok(entry, "serve() should return a DB entry");
        assert.equal(entry.hash, hash, "Returned entry hash must match");
        assert.ok(fs.existsSync(entry.absolute_path), "serve() should only return entries whose file exists on disk");
    });

    it('should throw from serve() when the hash is unknown', async () => {
        // assert.rejects, not assert.throws: serve() reads the database, which is async now,
        // so the failure arrives as a rejected promise rather than a synchronous throw.
        await assert.rejects(
            async () => await media.serve("0000000000000000000000000000000000000000000000000000000000000000"),
            /Media not found/
        );
    });

    it('should list media files in a folder, including hash for DB-registered files', async () => {
        const items = await media.list(ORCH_ROOT);
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
        const audioPath = path.join(getWorkspacePath(),ORCH_ROOT, 'media', audioName);
        assert.equal(fs.existsSync(audioPath), false, "Media file should be deleted from disk");

        // Sidecar cleaned
        const meta = docs.files.getMetadata(relPath);
        assert.ok(!meta.flashcards[0].vanillaData?.media?.front_sound, "Sidecar front_sound reference should be removed");

        // DB entry gone
        const entry = await db.prepare('SELECT * FROM Media WHERE hash = ?').get(hash);
        assert.equal(entry, undefined, "DB entry should be deleted");

        // Seal commit
        await sealEmitter.flushEdits();
        const afterLog = await sealTools.log(1);
        assert.notEqual(afterLog[0]?.oid, beforeHead, "removeMedia should produce a new Seal commit");
        assert.ok(afterLog[0].commit.message.startsWith('edit:'), "Seal commit for removal should be an edit");
    });

    it('should reconcile: remove DB entries for missing files, leave existing ones intact', async () => {
        // Register a phantom entry directly in the DB (file never written to disk)
        const phantomHash = "deadbeef".repeat(8);
        const phantomAbs = path.join(getWorkspacePath(),ORCH_ROOT, 'media', 'ghost.png');
        await db.prepare('INSERT INTO Media (hash, name, relative_path, absolute_path) VALUES (?, ?, ?, ?)')
            .run(phantomHash, 'ghost.png', path.join(ORCH_ROOT, 'media', 'ghost.png'), phantomAbs);

        // Add a real file to the DB so we can confirm it survives reconciliation
        const realBuffer = Buffer.from("real-media-data");
        const realName = "real-for-reconcile.png";
        const realRelPath = path.join(ORCH_ROOT, "VanillaOrchestrated.md");
        await media.addVanillaMedia(realRelPath, "vo-hash-001", realBuffer, realName, "image", "back");

        const orphans = await media.reconcile(ORCH_ROOT);

        assert.ok(orphans.some(o => o.name === 'ghost.png'), "reconcile() should report the phantom file as an orphan");

        const phantom = await db.prepare('SELECT * FROM Media WHERE hash = ?').get(phantomHash);
        assert.equal(phantom, undefined, "Phantom DB entry should be deleted");

        const realHash = crypto.createHash('sha256').update(realBuffer).digest('hex');
        const real = await db.prepare('SELECT * FROM Media WHERE hash = ?').get(realHash);
        assert.ok(real, "Real media DB entry should survive reconciliation");
    });
});

// Media is stored per-folder at `<dirname(doc)>/media/<name>` and referenced by
// cards as the folder-relative `./media/<name>`. Moving a document to another
// folder therefore re-points every one of its refs unless the media travels too.
describe('Media follows its document across a move or copy', () => {
    const MOVE_ROOT = "MediaMoveWorkspace";
    const SRC = path.join(MOVE_ROOT, "src");
    const DEST = path.join(MOVE_ROOT, "dest");

    const absMedia = (folderRel, name) =>
        path.join(getWorkspacePath(), folderRel, 'media', name);

    // Creates a document in `folderRel` with one vanilla card holding `name` as its front image.
    const makeCardWithImage = async (folderRel, docName, cardHash, name, buffer) => {
        const relPath = path.join(folderRel, docName);
        await docs.createFile(docName, folderRel);
        await docs.updateFile(relPath, '# doc', {
            flashcards: [{ globalHash: cardHash, level: 0, vanillaData: {} }]
        });
        await media.addVanillaMedia(relPath, cardHash, buffer, name, "image", "front");
        return relPath;
    };

    before(async () => {
        const abs = path.join(getWorkspacePath(), MOVE_ROOT);
        if (fs.existsSync(abs)) fs.rmSync(abs, { recursive: true, force: true });
        await docs.createFolder(MOVE_ROOT);
        await docs.createFolder("src", MOVE_ROOT);
        await docs.createFolder("dest", MOVE_ROOT);
    });

    after(async () => {
        db.close();
        await new Promise(resolve => setTimeout(resolve, 50));
        try {
            fs.rmSync(path.join(process.cwd(), 'data'), { recursive: true, force: true });
        } catch (e) {
            console.warn('Teardown warning (safe to ignore): Failed to delete data directory:', e.message);
        }
    });

    it('carries the media file into the destination folder', async () => {
        const name = "solo-figure.png";
        const buffer = Buffer.from("solo-figure-bytes");
        const relPath = await makeCardWithImage(SRC, "Solo.md", "move-solo-1", name, buffer);

        assert.ok(fs.existsSync(absMedia(SRC, name)), "precondition: media starts in the source folder");

        const destPath = path.join(DEST, "Solo.md");
        await docs.move(relPath, destPath);

        assert.ok(
            fs.existsSync(absMedia(DEST, name)),
            "media referenced by the moved document must exist in the destination folder"
        );
        assert.equal(
            fs.readFileSync(absMedia(DEST, name), 'utf-8'), "solo-figure-bytes",
            "carried media must keep its bytes"
        );

        // The ref itself is folder-relative and unchanged, so it now resolves again.
        const meta = docs.files.getMetadata(destPath);
        assert.equal(meta.flashcards[0].vanillaData.media.front_img, `./media/${name}`);
    });

    it('leaves no orphan behind when no other document needs the media', async () => {
        const name = "lonely.png";
        const relPath = await makeCardWithImage(SRC, "Lonely.md", "move-lonely-1", name, Buffer.from("lonely-bytes"));

        await docs.move(relPath, path.join(DEST, "Lonely.md"));

        assert.equal(
            fs.existsSync(absMedia(SRC, name)), false,
            "media no document references any more must not be left in the source folder"
        );
    });

    it('keeps media in the source folder when a sibling document still references it', async () => {
        const name = "shared-figure.png";
        const buffer = Buffer.from("shared-figure-bytes");
        const movingPath = await makeCardWithImage(SRC, "Mover.md", "move-shared-1", name, buffer);

        // A second document in the same folder pointing at the very same file.
        const stayingPath = path.join(SRC, "Stayer.md");
        await docs.createFile("Stayer.md", SRC);
        await docs.updateFile(stayingPath, '# stays', {
            flashcards: [{
                globalHash: "move-shared-2", level: 0,
                vanillaData: { media: { front_img: `./media/${name}` } }
            }]
        });

        await docs.move(movingPath, path.join(DEST, "Mover.md"));

        assert.ok(
            fs.existsSync(absMedia(SRC, name)),
            "media still referenced by a sibling document must stay in the source folder"
        );
        assert.ok(
            fs.existsSync(absMedia(DEST, name)),
            "the moved document needs its own copy in the destination folder"
        );
    });

    // Copy has the same folder-relative ref problem as move, minus the cleanup half:
    // the original keeps its media, so the destination needs its own copy.
    it('copies the media alongside a document copied into another folder', async () => {
        const name = "copyable.png";
        const buffer = Buffer.from("copyable-bytes");
        const relPath = await makeCardWithImage(SRC, "Copyable.md", "copy-1", name, buffer);

        await docs.copy(relPath, path.join(DEST, "Copyable.md"));

        assert.ok(
            fs.existsSync(absMedia(DEST, name)),
            "the copy needs its own media in the destination folder"
        );
        assert.equal(
            fs.readFileSync(absMedia(DEST, name), 'utf-8'), "copyable-bytes",
            "copied media must keep its bytes"
        );
    });

    it('leaves the original media untouched when a document is copied away', async () => {
        const name = "original-stays.png";
        const relPath = await makeCardWithImage(SRC, "OriginalStays.md", "copy-2", name, Buffer.from("stay-bytes"));

        await docs.copy(relPath, path.join(DEST, "OriginalStays.md"));

        assert.ok(
            fs.existsSync(absMedia(SRC, name)),
            "a copy must never remove media from the source folder"
        );
        // The original document still resolves its own ref.
        const meta = docs.files.getMetadata(relPath);
        assert.equal(meta.flashcards[0].vanillaData.media.front_img, `./media/${name}`);
    });

    it('copies media for a document duplicated under an auto-renamed name', async () => {
        // Copying onto an existing name makes Files.copy pick a free one; the media
        // still has to land in the folder the copy actually ended up in.
        const name = "collide.png";
        const relPath = await makeCardWithImage(SRC, "Collide.md", "copy-3", name, Buffer.from("collide-bytes"));
        await docs.createFile("Collide.md", DEST);   // occupy the destination name

        await docs.copy(relPath, path.join(DEST, "Collide.md"));

        assert.ok(
            fs.existsSync(absMedia(DEST, name)),
            "media must follow the copy to its auto-renamed destination folder"
        );
    });

    it('carries media for every document in a copied folder tree', async () => {
        const name = "tree-figure.png";
        const buffer = Buffer.from("tree-figure-bytes");
        await docs.createFolder("treesrc", MOVE_ROOT);
        const treeRel = path.join(MOVE_ROOT, "treesrc");
        await makeCardWithImage(treeRel, "Leaf.md", "copy-tree-1", name, buffer);

        const destTreeRel = path.join(DEST, "treecopy");
        await docs.copy(treeRel, destTreeRel, true);

        assert.ok(
            fs.existsSync(absMedia(destTreeRel, name)),
            "a copied folder must bring its media/ dir along"
        );
        assert.ok(
            fs.existsSync(absMedia(treeRel, name)),
            "the source folder keeps its media"
        );
    });

    // A folder carries its own media/ dir along on disk, so the files stay resolvable.
    // The derived index is what goes stale, which breaks hash-served media.
    it('re-points the Media table when the owning folder itself moves', async () => {
        const name = "in-folder.png";
        const buffer = Buffer.from("in-folder-bytes");
        const hash = crypto.createHash('sha256').update(buffer).digest('hex');

        await docs.createFolder("movable", MOVE_ROOT);
        const folderRel = path.join(MOVE_ROOT, "movable");
        await makeCardWithImage(folderRel, "Inside.md", "move-folder-1", name, buffer);

        const destFolderRel = path.join(DEST, "movable");
        await docs.move(folderRel, destFolderRel, true);

        assert.ok(
            fs.existsSync(absMedia(destFolderRel, name)),
            "precondition: the media/ dir travels inside the folder on disk"
        );
        const entry = await db.prepare('SELECT * FROM Media WHERE hash = ?').get(hash);
        assert.equal(
            entry.absolute_path, absMedia(destFolderRel, name),
            "Media.absolute_path must follow the folder move"
        );
    });

    it('re-points the Media table at the new location', async () => {
        const name = "indexed.png";
        const buffer = Buffer.from("indexed-bytes");
        const hash = crypto.createHash('sha256').update(buffer).digest('hex');
        const relPath = await makeCardWithImage(SRC, "Indexed.md", "move-indexed-1", name, buffer);

        await docs.move(relPath, path.join(DEST, "Indexed.md"));

        const entry = await db.prepare('SELECT * FROM Media WHERE hash = ?').get(hash);
        assert.ok(entry, "media must remain registered after the move");
        assert.equal(
            entry.absolute_path, absMedia(DEST, name),
            "Media.absolute_path must point at the file's new location"
        );
    });
});