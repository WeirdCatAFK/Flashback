import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import crypto from 'crypto';
import Documents from '../src/api/access/documents.js';
import db from '../src/api/access/database.js';
import fs from 'fs';
import validate from '../src/api/config/validate.js';
import AdmZip from 'adm-zip';

process.env.USER_DATA_PATH = path.join(process.cwd(), 'data');
console.log('Using USER_DATA_PATH:', process.env.USER_DATA_PATH);

if (!validate()) {
    console.error("Validation failed. May be an initialization issue.");
    if (!validate()) {
        process.exit(1);
    }
    console.log("Validation passed.");
}
// Initialize the Orchestrator
const docs = new Documents();
const TEST_ROOT = "TestWorkspace";

/**
 * Helper to generate a random hash
 */
const genHash = () => crypto.randomUUID();

describe('Documents Orchestrator Integration Tests', () => {

    // --- CLEANUP BEFORE & AFTER ---
    const cleanup = () => {
        // First try the proper orchestrated delete (handles both DB and FS)
        try {
            if (docs.exists(TEST_ROOT, true, true)) docs.delete(TEST_ROOT, true);
        } catch (e) {}
        // Fallback: nuke the filesystem directly in case the DB was reset but FS still has data
        try {
            const absPath = path.join(process.env.USER_DATA_PATH, 'workspace', TEST_ROOT);
            if (fs.existsSync(absPath)) fs.rmSync(absPath, { recursive: true, force: true });
        } catch (e) {}
    };

    before(async () => {
        cleanup();
        await docs.createFolder(TEST_ROOT);
    });

    after(() => {
        cleanup();
    });

    // --- 1. FILE SYSTEM STRUCTURE ---
    describe('File System & Hierarchy', () => {

        it('should create nested folders correctly', () => {
            const folderPath = path.join(TEST_ROOT, 'Math', 'Algebra');
            docs.createFolder('Math', TEST_ROOT);
            docs.createFolder('Algebra', path.join(TEST_ROOT, 'Math'));

            // Verify in DB
            const existsDB = docs.exists(folderPath, true, true);
            assert.ok(existsDB, 'Folder should exist in DB');

            // Verify in FS
            const existsFS = docs.exists(folderPath, false, true);
            assert.ok(existsFS, 'Folder should exist in FileSystem');
        });

        it('should create a file and register it in the DB', () => {
            const fileName = 'LinearEquations.md';
            const relPath = path.join(TEST_ROOT, 'Math', 'Algebra');

            docs.createFile(fileName, relPath);

            const fullPath = path.join(relPath, fileName);
            const doc = docs.exists(fullPath, true, false);

            assert.ok(doc, 'File should exist in DB');
            assert.equal(doc.name, fileName);
        });

        it('should rename a file and update the DB path', () => {
            const oldPath = path.join(TEST_ROOT, 'Math', 'Algebra', 'LinearEquations.md');
            const newName = 'LinEq.md';

            docs.rename(oldPath, newName, false);

            const newPath = path.join(TEST_ROOT, 'Math', 'Algebra', newName);
            assert.ok(docs.exists(newPath, true, false), 'New path should exist in DB');
            assert.ok(!docs.exists(oldPath, true, false), 'Old path should NOT exist in DB');
        });

        it('should move a folder and cascade path updates to children', () => {
            // Setup: Move 'Algebra' to 'TestWorkspace' root
            const oldPath = path.join(TEST_ROOT, 'Math', 'Algebra');
            const newPath = path.join(TEST_ROOT, 'Algebra');

            docs.move(oldPath, newPath, true);

            // Verify Folder Move
            assert.ok(docs.exists(newPath, true, true), 'Folder should exist at new location');

            // Verify Child File Moved (LinEq.md)
            const childPath = path.join(newPath, 'LinEq.md');
            assert.ok(docs.exists(childPath, true, false), 'Child file path should be updated in DB');
        });
    });

    // --- 2. METADATA & TAG PROPAGATION ---
    describe('Metadata & Tag Inheritance', () => {
        const docPath = path.join(TEST_ROOT, 'Algebra', 'LinEq.md');
        const folderPath = path.join(TEST_ROOT, 'Algebra');

        it('should sync tags and propagate from folder to document', () => {
            // 1. Add tag to Folder
            const folderMeta = { tags: ['Math', 'Hard'] };
            docs.updateMetadata(folderPath, folderMeta, true);

            // 2. Add tag to Document
            const docMeta = { tags: ['Equations'], globalHash: genHash() };
            docs.updateMetadata(docPath, docMeta, false);

            const docNode = db.prepare('SELECT node_id FROM Documents WHERE relative_path = ?').get(docPath);

            // Get all tags connected to doc (direct + inherited)
            const tags = db.prepare(`
                SELECT t.name FROM Tags t
                JOIN Connections c ON c.destiny_id = t.node_id
                WHERE c.origin_id = ?
                UNION
                SELECT t.name FROM Tags t
                JOIN InheritedTags it ON it.tag_id = t.id
                JOIN Connections c ON c.id = it.connection_id
                WHERE c.destiny_id = ?
            `).all(docNode.node_id, docNode.node_id).map(t => t.name);

            assert.ok(tags.includes('Math'), 'Document should inherit "Math"');
            assert.ok(tags.includes('Hard'), 'Document should inherit "Hard"');
            assert.ok(tags.includes('Equations'), 'Document should have direct tag "Equations"');
        });
    });

    // --- 3. FLASHCARDS & SYNC ---
    describe('Flashcard Synchronization', () => {
        const docPath = path.join(TEST_ROOT, 'Algebra', 'LinEq.md');
        const fcHash1 = genHash();
        const fcHash2 = genHash();

        it('should insert new flashcards from metadata', () => {
            const content = "# Test Content";
            const metadata = {
                globalHash: genHash(),
                tags: ['Equations'],
                flashcards: [
                    {
                        globalHash: fcHash1,
                        level: 0,
                        lastRecall: new Date().toISOString(),
                        vanillaData: { frontText: "Q1", backText: "A1" }
                    },
                    {
                        globalHash: fcHash2,
                        level: 0,
                        lastRecall: new Date().toISOString(),
                        vanillaData: { frontText: "Q2", backText: "A2" }
                    }
                ]
            };

            docs.updateFile(docPath, content, metadata);

            // Verify in DB
            const count = db.prepare('SELECT COUNT(*) as c FROM Flashcards').get().c;
            assert.ok(count >= 2, 'Should have at least 2 flashcards in DB');

            const fc1 = db.prepare('SELECT * FROM Flashcards WHERE global_hash = ?').get(fcHash1);
            assert.ok(fc1, 'Flashcard 1 should exist');
        });

        it('should update existing flashcards and delete removed ones', () => {
            // Update: Keep fcHash1 (modify it), Remove fcHash2, Add fcHash3
            const fcHash3 = genHash();
            const metadata = {
                globalHash: genHash(),
                tags: ['Equations'],
                flashcards: [
                    {
                        globalHash: fcHash1,
                        level: 1, // Changed level
                        lastRecall: new Date().toISOString(),
                        vanillaData: { frontText: "Q1 Modified", backText: "A1" }
                    },
                    {
                        globalHash: fcHash3,
                        level: 0,
                        lastRecall: new Date().toISOString(),
                        vanillaData: { frontText: "Q3", backText: "A3" }
                    }
                ]
            };

            docs.updateFile(docPath, "# Test Content", metadata);

            // Verify fcHash1 updated
            const fc1 = db.prepare('SELECT level FROM Flashcards WHERE global_hash = ?').get(fcHash1);
            assert.equal(fc1.level, 1, 'Flashcard 1 level should be updated');

            // Verify fcHash2 deleted
            const fc2 = db.prepare('SELECT id FROM Flashcards WHERE global_hash = ?').get(fcHash2);
            assert.strictEqual(fc2, undefined, 'Flashcard 2 should be deleted');

            // Verify fcHash3 created
            const fc3 = db.prepare('SELECT id FROM Flashcards WHERE global_hash = ?').get(fcHash3);
            assert.ok(fc3, 'Flashcard 3 should be created');
        });
    });

    // --- 4. SRS & PRESENCE ---
    describe('SRS & Presence', () => {
        const docPath = path.join(TEST_ROOT, 'Algebra', 'LinEq.md');
        let fcHash;

        before(() => {
            const row = db.prepare(`
                SELECT f.global_hash FROM Flashcards f
                JOIN Documents d ON f.document_id = d.id
                WHERE d.relative_path = ? LIMIT 1
            `).get(docPath);
            assert.ok(row, 'A flashcard must exist for SRS tests (check Flashcard Synchronization group)');
            fcHash = row.global_hash;
        });

        it('should submit a review and update the flashcard level', async () => {
            await docs.submitReview(docPath, fcHash, 5, 2.5, 5);

            const fc = db.prepare('SELECT level FROM Flashcards WHERE global_hash = ?').get(fcHash);
            assert.equal(fc.level, 5, 'Flashcard level should be updated to 5');
        });

        it('should write a ReviewLog entry on each review', async () => {
            const fc = db.prepare('SELECT id FROM Flashcards WHERE global_hash = ?').get(fcHash);
            const before = db.prepare('SELECT COUNT(*) as c FROM ReviewLogs WHERE flashcard_id = ?').get(fc.id).c;

            await docs.submitReview(docPath, fcHash, 3, 2.0, 4);

            const after = db.prepare('SELECT COUNT(*) as c FROM ReviewLogs WHERE flashcard_id = ?').get(fc.id).c;
            assert.equal(after, before + 1, 'A new ReviewLog entry should be created for each review');
        });

        it('should propagate presence (mastery) up to the folder', () => {
            const doc = db.prepare('SELECT presence FROM Documents WHERE relative_path = ?').get(docPath);
            assert.ok(doc.presence > 0, 'Document presence should be positive');

            const folder = db.prepare('SELECT presence FROM Folders WHERE relative_path = ?').get(path.join(TEST_ROOT, 'Algebra'));
            assert.ok(folder.presence > 0, 'Folder presence should be positive (propagated from document)');
        });

        it('should return valid Leitner box statistics', () => {
            const stats = docs.srs.getLeitnerStats();

            assert.ok(typeof stats.totalCards === 'number', 'totalCards should be a number');
            assert.ok(stats.totalCards > 0, 'Should have at least one card from prior tests');
            assert.ok(typeof stats.masteryPercentage === 'number', 'masteryPercentage should be a number');
            assert.ok(stats.masteryPercentage >= 0 && stats.masteryPercentage <= 100, 'masteryPercentage must be between 0 and 100');
            assert.ok(Array.isArray(stats.boxes), 'boxes should be an array');
            assert.ok(stats.boxes.every(b => typeof b.level === 'number' && typeof b.count === 'number'), 'Each box entry must have level and count');
        });
    });

    // --- 5. SEARCH & GRAPH ---
    describe('Search & Graph', () => {
        it('should find the flashcard by text', () => {
            const results = docs.search('Q1 Modified'); // Text set in previous test
            assert.ok(results.length > 0, 'Should return search results');
            assert.equal(results[0].type, 'flashcard');
        });

        it('should return valid graph data', () => {
            const graph = docs.getGraphData();
            assert.ok(Array.isArray(graph.nodes), 'Nodes should be an array');
            assert.ok(Array.isArray(graph.edges), 'Edges should be an array');
            assert.ok(graph.nodes.length > 0, 'Should have nodes');
        });
    });

    describe('Import Operations', () => {
        it('should import a file with content, metadata, and flashcards', async () => {
            const importName = "ImportedNotes.md";
            const importContent = "# Imported Content\nThis file was imported.";
            const importMeta = {
                globalHash: genHash(),
                tags: ["Imported", "Urgent"],
                flashcards: [
                    {
                        globalHash: genHash(),
                        level: 0,
                        lastRecall: new Date().toISOString(),
                        vanillaData: { frontText: "Imp Q1", backText: "Imp A1" }
                    }
                ]
            };

            await docs.importFile(importName, TEST_ROOT, importContent, importMeta);

            const docRelPath = path.join(TEST_ROOT, importName);
            const docEntry = docs.exists(docRelPath, true, false);
            assert.ok(docEntry, "Imported document should exist in DB");
            assert.equal(docEntry.name, importName);

            const fullPath = path.join(process.env.USER_DATA_PATH, 'workspace', docRelPath);
            const diskContent = fs.readFileSync(fullPath, 'utf-8');
            assert.equal(diskContent, importContent, "Disk content should match imported content");

            const tagCheck = db.prepare(`
                SELECT t.name FROM Tags t
                JOIN Connections c ON c.destiny_id = t.node_id
                JOIN Documents d ON d.node_id = c.origin_id
                WHERE d.id = ? AND t.name = ?
            `).get(docEntry.id, "Imported");
            assert.ok(tagCheck, "Document should have the 'Imported' tag connected");

            const fcCount = db.prepare('SELECT COUNT(*) as c FROM Flashcards WHERE document_id = ?').get(docEntry.id).c;
            assert.equal(fcCount, 1, "Should have 1 flashcard linked to the imported document");
        });
    });

    // --- 6. PACKAGE IMPORT (EXTERNAL COURSES) ---
    describe('Package Import', () => {
        const pkgName = "DummyCourse";
        const externalPath = path.join(process.cwd(), pkgName);

        before(() => {
            if (fs.existsSync(externalPath)) fs.rmSync(externalPath, { recursive: true, force: true });
            fs.mkdirSync(path.join(externalPath, 'media'), { recursive: true });

            fs.writeFileSync(path.join(externalPath, '.flashback'), JSON.stringify({
                globalHash: "original-root-hash",
                tags: ["Biology", "101"],
                presence: 0.85 
            }));

            const docContent = "# Mitosis\nProcess of cell division...";
            fs.writeFileSync(path.join(externalPath, 'Lecture1.md'), docContent);

            fs.writeFileSync(path.join(externalPath, 'Lecture1.md.flashback'), JSON.stringify({
                globalHash: "original-file-hash",
                tags: ["Cell"],
                flashcards: [
                    {
                        globalHash: "original-card-hash",
                        level: 5, 
                        easeFactor: 2.5, 
                        lastRecall: "2023-01-01T00:00:00.000Z", 
                        vanillaData: {
                            frontText: "Phases of Mitosis",
                            backText: "Prophase, Metaphase..."
                        }
                    }
                ]
            }));

            fs.writeFileSync(path.join(externalPath, 'media', 'cell_diagram.png'), Buffer.from("fake_image_bytes"));
        });

        after(() => {
            if (fs.existsSync(externalPath)) fs.rmSync(externalPath, { recursive: true, force: true });
        });

        it('should import a package, preserve structure, and sanitize learning progress', async () => {
            await docs.importPackage(externalPath, TEST_ROOT);

            const importedRootRel = path.join(TEST_ROOT, pkgName);

            const folderEntry = docs.exists(importedRootRel, true, true);
            assert.ok(folderEntry, "Imported root folder should exist in DB");
            assert.notEqual(folderEntry.globalHash, "original-root-hash", "Root hash should be regenerated");

            const docRel = path.join(importedRootRel, 'Lecture1.md');
            const docEntry = docs.exists(docRel, true, false);
            assert.ok(docEntry, "Lecture1.md should be indexed");

            const flashcard = db.prepare('SELECT * FROM Flashcards WHERE document_id = ?').get(docEntry.id);
            assert.ok(flashcard, "Flashcard should be imported");
            assert.equal(flashcard.level, 0, "Flashcard level should be reset to 0");
            assert.notEqual(flashcard.global_hash, "original-card-hash", "Flashcard hash should be regenerated");

            const importedMeta = docs.files.getMetadata(docRel);
            assert.strictEqual(importedMeta.flashcards[0].lastRecall, undefined, "lastRecall should be stripped from file metadata");

            const mediaRel = path.join(importedRootRel, "media", "cell_diagram.png");
            
            // Check file system
            assert.ok(docs.files.exists(mediaRel), "Media file should be copied to workspace");
            // Check DB registry
            const mediaEntry = db.prepare('SELECT * FROM Media WHERE relative_path = ?').get(mediaRel);
            assert.ok(mediaEntry, "Media file should be registered in the Media table");
        });
    });

    // --- 7. ZIP PACKAGE IMPORT ---
    describe('Zip Package Processing', () => {
        const zipName = "CourseArchive.zip";
        const zipPath = path.join(process.cwd(), zipName);

        before(() => {
            const zip = new AdmZip();

            zip.addFile("Intro.md", Buffer.from("# Welcome\nIntroduction to the course."));

            const metaContent = JSON.stringify({
                globalHash: "old-hash-to-be-replaced",
                tags: ["ZippedTag"],
                flashcards: [{
                    globalHash: "old-card-hash",
                    level: 5, 
                    lastRecall: "2022-01-01", 
                    vanillaData: { frontText: "ZipQ", backText: "ZipA" }
                }]
            });
            zip.addFile("Chapter1/Lesson1.md.flashback", Buffer.from(metaContent));
            zip.addFile("Chapter1/Lesson1.md", Buffer.from("# Lesson 1 Content"));

            zip.writeZip(zipPath);
        });

        after(() => {
            if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
        });

        it('should unzip, import, and sanitize a zip package', async () => {
            await docs.processZipPackage(zipPath, TEST_ROOT);

            const expectedRoot = path.join(TEST_ROOT, "CourseArchive");

            const rootExists = docs.exists(expectedRoot, true, true);
            assert.ok(rootExists, "Unzipped root folder should exist in DB");

            const fileRel = path.join(expectedRoot, "Chapter1", "Lesson1.md");
            const fileExists = docs.exists(fileRel, true, false);
            assert.ok(fileExists, "Nested file from zip should be indexed");

            const dbCard = db.prepare('SELECT level, global_hash FROM Flashcards WHERE document_id = ?').get(fileExists.id);
            assert.ok(dbCard, "Flashcard from zip should be imported");
            assert.equal(dbCard.level, 0, "Flashcard level should be reset to 0");
            assert.notEqual(dbCard.global_hash, "old-card-hash", "Flashcard hash should be regenerated");
        });
    });

    // --- 7b. SEARCH (EXTENDED) ---
    describe('Search — extended', () => {
        it('should find a document by name', () => {
            const results = docs.search('LinEq');
            const docResult = results.find(r => r.type === 'document');
            assert.ok(docResult, 'Should return at least one document result');
        });

        it('should find a tag by name', () => {
            const results = docs.search('Equations');
            const tagResult = results.find(r => r.type === 'tag');
            assert.ok(tagResult, 'Should return at least one tag result');
        });

        it('should return graph nodes with recognised type labels', () => {
            const { nodes } = docs.getGraphData();
            const types = new Set(nodes.map(n => n.type));
            const expected = ['Document', 'Folder', 'Flashcard', 'Tag'];
            for (const t of expected) {
                assert.ok(types.has(t), `Graph should contain at least one node of type "${t}"`);
            }
        });
    });

    // --- 8. PACKAGE EXPORT ---
    describe('Package Export', () => {
        const exportFolder = "ExportTest";

        const cleanupExport = () => {
            try {
                if (docs.exists(exportFolder, true, true)) {
                    docs.delete(exportFolder, true);
                }
            } catch (e) {
                // Ignore if doesn't exist
            }
        };

        before(async () => {
            cleanupExport();
            await docs.createFolder(exportFolder);
            await docs.createFile("Notes.md", exportFolder);

            await docs.updateMetadata(path.join(exportFolder, "Notes.md"), {
                tags: ["ExportedTag"],
                globalHash: "export-test-hash"
            });
        });

        after(() => {
            cleanupExport();
        });

        it('should zip a workspace folder and return a valid file path', () => {
            const zipPath = docs.exportPackage(exportFolder);

            assert.ok(fs.existsSync(zipPath), "Export zip file should exist");
            assert.ok(zipPath.endsWith('.zip'), "File should be a zip");

            const zip = new AdmZip(zipPath);
            const entries = zip.getEntries();

            const hasFile = entries.some(e => e.entryName === `${exportFolder}/Notes.md`);
            assert.ok(hasFile, "Zip should contain the inner file with correct structure");

            const hasMeta = entries.some(e => e.entryName === `${exportFolder}/Notes.md.flashback`);
            assert.ok(hasMeta, "Zip should include hidden .flashback metadata files");

            fs.unlinkSync(zipPath);
        });
    });

    // --- 9. DELETION & CASCADE ---
    describe('Deletion & Cascade', () => {
        const subFolder = 'DeletionTests';
        const subFolderPath = path.join(TEST_ROOT, subFolder);
        const fileName = 'ToDelete.md';
        const filePath = path.join(subFolderPath, fileName);
        const fcHash = crypto.randomUUID();

        before(async () => {
            await docs.createFolder(subFolder, TEST_ROOT);
            await docs.createFile(fileName, subFolderPath);
            await docs.updateFile(filePath, '# Delete me', {
                globalHash: crypto.randomUUID(),
                flashcards: [{ globalHash: fcHash, vanillaData: { frontText: 'Q', backText: 'A' } }]
            });
        });

        it('should delete a file from both filesystem and DB', async () => {
            await docs.delete(filePath, false);
            assert.ok(!docs.files.exists(filePath), 'File should not exist on filesystem');
            assert.ok(!docs.exists(filePath, true, false), 'File should not exist in DB');
        });

        it('should cascade-delete documents and flashcards when a folder is deleted', async () => {
            // Re-create the file so we have something to cascade-delete
            await docs.createFile(fileName, subFolderPath);
            await docs.updateFile(filePath, '# Delete me', {
                globalHash: crypto.randomUUID(),
                flashcards: [{ globalHash: crypto.randomUUID(), vanillaData: { frontText: 'Q', backText: 'A' } }]
            });

            const docEntry = docs.exists(filePath, true, false);
            assert.ok(docEntry, 'Document should exist before folder deletion');

            await docs.delete(subFolderPath, true);

            assert.ok(!docs.files.exists(subFolderPath), 'Folder should not exist on filesystem');
            assert.ok(!docs.exists(subFolderPath, true, true), 'Folder should not exist in DB');

            const orphanedDoc = db.prepare('SELECT id FROM Documents WHERE id = ?').get(docEntry.id);
            assert.strictEqual(orphanedDoc, undefined, 'Document should be cascade-deleted with its folder');

            const orphanedFc = db.prepare('SELECT id FROM Flashcards WHERE document_id = ?').get(docEntry.id);
            assert.strictEqual(orphanedFc, undefined, 'Flashcards should be cascade-deleted with their document');
        });

        it('should not delete a non-existent file without throwing silently', async () => {
            await assert.rejects(
                () => docs.delete('nonexistent/path/file.md', false),
                'Deleting a non-existent path should throw'
            );
        });
    });

    // --- 10. FILE UTILITIES ---
    describe('File Utilities', () => {
        const existingDoc = path.join(TEST_ROOT, 'Algebra', 'LinEq.md');

        it('should read a file and return content with detected encoding', () => {
            const result = docs.files.readFile(existingDoc);
            assert.ok(typeof result.content === 'string', 'content should be a string');
            assert.ok(typeof result.encoding === 'string', 'encoding should be detected and returned');
        });

        it('should list folder contents including type and metadata', () => {
            const items = docs.files.listFolder(TEST_ROOT);
            assert.ok(Array.isArray(items), 'listFolder should return an array');
            assert.ok(items.length > 0, 'TestWorkspace should have items after all prior tests');
            assert.ok(items.every(i => i.type === 'file' || i.type === 'folder'), 'Every item should have a recognised type');
        });

        it('should copy a file and assign a new globalHash to the copy', () => {
            const destPath = path.join(TEST_ROOT, 'Algebra', 'LinEqCopy.md');
            const srcMeta = docs.files.getMetadata(existingDoc);

            const result = docs.files.copy(existingDoc, destPath, false);

            assert.ok(docs.files.exists(existingDoc), 'Original should still exist after copy');
            assert.ok(docs.files.exists(destPath), 'Copy should exist on filesystem');

            const destMeta = docs.files.getMetadata(destPath);
            assert.notEqual(destMeta.globalHash, srcMeta.globalHash, 'Copy must have a different globalHash');
            assert.equal(destMeta.copiedFrom, srcMeta.globalHash, 'Copy should record the source globalHash');
            assert.ok(Array.isArray(result), 'copy() should return an array of created items');
            assert.equal(result[0].globalHash, destMeta.globalHash, 'Returned item globalHash should match the new sidecar');

            // Cleanup — filesystem only; the copy is not in the DB
            docs.files.delete(destPath, false);
        });
    });
});
