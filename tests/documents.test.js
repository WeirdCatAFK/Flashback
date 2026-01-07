import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import crypto from 'crypto';
import Documents from '../src/api/access/documents.js';
import db from '../src/api/access/database.js';
import fs from 'fs';
import validate from '../src/api/config/validate.js';

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
        try {
            if (docs.exists(TEST_ROOT, true, true)) {
                docs.delete(TEST_ROOT, true);
            }
        } catch (e) {
            // Ignore if doesn't exist 
        }
    };

    before(() => {
        cleanup();
        docs.createFolder(TEST_ROOT);
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

            // 3. Verify Document inherited 'Math' and 'Hard'
            // We check the InheritedTags table indirectly or via internal logic, 
            // but checking the "Effective Tags" requires querying the DB connections.

            const docNode = db.prepare('SELECT node_id FROM Documents WHERE relative_path = ?').get(docPath);

            // Get all tags connected to doc (direct + inherited)
            // Note: This query mocks what the frontend would do to fetch tags
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

            // Read original content to simulate real usage (optional but good practice)
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
            // ensure we have a card to test
            const rows = db.prepare(`
                SELECT f.global_hash FROM Flashcards f 
                JOIN Documents d ON f.document_id = d.id 
                WHERE d.relative_path = ? LIMIT 1
            `).get(docPath);
            fcHash = rows.global_hash;
        });

        it('should submit a review and update levels', () => {
            const newLevel = 5;
            docs.submitReview(docPath, fcHash, 5, 2.5, newLevel);

            const fc = db.prepare('SELECT level FROM Flashcards WHERE global_hash = ?').get(fcHash);
            assert.equal(fc.level, 5, 'Flashcard level should be 5');
        });

        it('should propagate presence (mastery) up to the folder', () => {
            // Trigger propagation (submitReview calls it, but let's verify the result of the previous test)

            // Check Document Presence
            // Only 1 doc, assuming mixed levels if other tests ran, but we just set one to 5.
            const doc = db.prepare('SELECT presence FROM Documents WHERE relative_path = ?').get(docPath);
            assert.ok(doc.presence > 0, 'Document presence should be positive');

            // Check Folder Presence (Algebra)
            const folder = db.prepare('SELECT presence FROM Folders WHERE relative_path = ?').get(path.join(TEST_ROOT, 'Algebra'));
            assert.ok(folder.presence > 0, 'Folder presence should be positive (propagated)');
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
        it('should import a file with content, metadata, and flashcards', () => {
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

            // Run Import
            docs.importFile(importName, TEST_ROOT, importContent, importMeta);

            // 1. Verify Document Exists in DB
            const docRelPath = path.join(TEST_ROOT, importName);
            const docEntry = docs.exists(docRelPath, true, false);
            assert.ok(docEntry, "Imported document should exist in DB");
            assert.equal(docEntry.name, importName);

            // 2. Verify File Content on Disk
            const fullPath = path.join(process.env.USER_DATA_PATH, 'workspace', docRelPath);
            const diskContent = fs.readFileSync(fullPath, 'utf-8');
            assert.equal(diskContent, importContent, "Disk content should match imported content");

            // 3. Verify Tags Synced
            // We verify "Imported" tag presence by checking the DB connections
            const tagCheck = db.prepare(`
                SELECT t.name FROM Tags t
                JOIN Connections c ON c.destiny_id = t.node_id
                JOIN Documents d ON d.node_id = c.origin_id
                WHERE d.id = ? AND t.name = ?
            `).get(docEntry.id, "Imported");
            assert.ok(tagCheck, "Document should have the 'Imported' tag connected");

            // 4. Verify Flashcards Synced
            const fcCount = db.prepare('SELECT COUNT(*) as c FROM Flashcards WHERE document_id = ?').get(docEntry.id).c;
            assert.equal(fcCount, 1, "Should have 1 flashcard linked to the imported document");
        });
    });
});