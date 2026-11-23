import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import crypto from 'crypto';
import Documents from '../../src/api/access/modules/documents.js';
import db from '../../src/api/access/primitives/database.js';
import fs from 'fs';
import validate from '../../src/api/config/validate.js';
import AdmZip from 'adm-zip';
import { sealTools, sealEmitter } from '../../src/api/seal/seal.js';
import { getWorkspacePath } from '../../src/api/access/primitives/config.js';
import * as documentRows from '../../src/api/access/resources/db/documents.js';
import * as flashcardRows from '../../src/api/access/resources/db/flashcards.js';
import * as linkRows from '../../src/api/access/resources/db/links.js';
import * as nodeRows from '../../src/api/access/resources/db/nodes.js';
import { testDataDir } from '../support/testData.js';

process.env.USER_DATA_PATH = testDataDir('docs');
console.log('USER_DATA_PATH:', process.env.USER_DATA_PATH);

if (!await validate()) {
    console.error('Validation failed.');
    process.exit(1);
}
const docs = new Documents();
const TEST_ROOT = "TestWorkspace";

const genHash = () => crypto.randomUUID();

describe('Documents Orchestrator Integration Tests', () => {

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
            fs.rmSync(testDataDir('docs'), { recursive: true, force: true });
        } catch (e) {
            console.warn('Teardown warning (safe to ignore): Failed to delete data directory:', e.message);
        }
    });

    describe('File System & Hierarchy', () => {

        it('should create nested folders correctly', async () => {
            const folderPath = path.join(TEST_ROOT, 'Math', 'Algebra');
            await docs.createFolder('Math', TEST_ROOT);
            await docs.createFolder('Algebra', path.join(TEST_ROOT, 'Math'));

            const existsDB = await docs.exists(folderPath, true, true);
            assert.ok(existsDB, 'Folder should exist in DB');

            const existsFS = await docs.exists(folderPath, false, true);
            assert.ok(existsFS, 'Folder should exist in FileSystem');
        });

        it('should create a file and register it in the DB', async () => {
            const fileName = 'LinearEquations.md';
            const relPath = path.join(TEST_ROOT, 'Math', 'Algebra');

            await docs.createFile(fileName, relPath);

            const fullPath = path.join(relPath, fileName);
            const doc = await docs.exists(fullPath, true, false);

            assert.ok(doc, 'File should exist in DB');
            assert.equal(doc.name, fileName);
        });

        it('should rename a file and update the DB path', async () => {
            const oldPath = path.join(TEST_ROOT, 'Math', 'Algebra', 'LinearEquations.md');
            const newName = 'LinEq.md';

            await docs.rename(oldPath, newName, false);

            const newPath = path.join(TEST_ROOT, 'Math', 'Algebra', newName);
            assert.ok(await docs.exists(newPath, true, false), 'New path should exist in DB');
            assert.ok(!await docs.exists(oldPath, true, false), 'Old path should NOT exist in DB');
        });

        it('should move a folder and cascade path updates to children', async () => {
            const oldPath = path.join(TEST_ROOT, 'Math', 'Algebra');
            const newPath = path.join(TEST_ROOT, 'Algebra');

            await docs.move(oldPath, newPath, true);

            assert.ok(await docs.exists(newPath, true, true), 'Folder should exist at new location');

            const childPath = path.join(newPath, 'LinEq.md');
            assert.ok(await docs.exists(childPath, true, false), 'Child file path should be updated in DB');
        });
    });

    describe('Metadata & Tag Inheritance', () => {
        const docPath = path.join(TEST_ROOT, 'Algebra', 'LinEq.md');
        const folderPath = path.join(TEST_ROOT, 'Algebra');

        it('should sync tags and propagate from folder to document', async () => {
            const folderMeta = { tags: ['Math', 'Hard'] };
            await docs.updateMetadata(folderPath, folderMeta, true);

            const docMeta = { tags: ['Equations'], globalHash: genHash() };
            await docs.updateMetadata(docPath, docMeta, false);

            const docNode = await db.prepare('SELECT node_id FROM Documents WHERE relative_path = ?').get(docPath);

            const tags = (await await db.prepare(`
                SELECT t.name FROM Tags t
                JOIN Connections c ON c.destiny_id = t.node_id
                WHERE c.origin_id = ?
                UNION
                SELECT t.name FROM Tags t
                JOIN InheritedTags it ON it.tag_id = t.id
                JOIN Connections c ON c.id = it.connection_id
                WHERE c.destiny_id = ?
            `).all(docNode.node_id, docNode.node_id)).map(t => t.name);

            assert.ok(tags.includes('Math'), 'Document should inherit "Math"');
            assert.ok(tags.includes('Hard'), 'Document should inherit "Hard"');
            assert.ok(tags.includes('Equations'), 'Document should have direct tag "Equations"');
        });
    });

    describe('Flashcard Synchronization', () => {
        const docPath = path.join(TEST_ROOT, 'Algebra', 'LinEq.md');
        const fcHash1 = genHash();
        const fcHash2 = genHash();

        it('should insert new flashcards from metadata', async () => {
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

            await docs.updateFile(docPath, content, metadata);

            const count = (await db.prepare('SELECT COUNT(*) as c FROM Flashcards').get()).c;
            assert.ok(count >= 2, 'Should have at least 2 flashcards in DB');

            const fc1 = await db.prepare('SELECT * FROM Flashcards WHERE global_hash = ?').get(fcHash1);
            assert.ok(fc1, 'Flashcard 1 should exist');
        });

        it('should update existing flashcards and delete removed ones', async () => {
            const fcHash3 = genHash();
            const metadata = {
                globalHash: genHash(),
                tags: ['Equations'],
                flashcards: [
                    {
                        globalHash: fcHash1,
                        level: 1,
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

            await docs.updateFile(docPath, "# Test Content", metadata);

            const fc1 = await db.prepare(`
                SELECT p.level FROM CardProgress p
                JOIN Flashcards f ON f.global_hash = p.card_hash
                WHERE f.global_hash = ? AND p.account_id = 'owner'
            `).get(fcHash1);
            assert.equal(fc1.level, 0, 'the sidecar cannot raise an existing schedule');

            const fc2 = await db.prepare('SELECT id FROM Flashcards WHERE global_hash = ?').get(fcHash2);
            assert.strictEqual(fc2, undefined, 'Flashcard 2 should be deleted');

            const fc3 = await db.prepare('SELECT id FROM Flashcards WHERE global_hash = ?').get(fcHash3);
            assert.ok(fc3, 'Flashcard 3 should be created');
        });
    });

    describe('Flashcard Type Persistence', () => {
        const docPath = path.join(TEST_ROOT, 'Algebra', 'TypedCards.md');

        before(async () => {
            await docs.createFile('TypedCards.md', path.join(TEST_ROOT, 'Algebra'));
        });

        const makeCard = (cardType, overrides = {}) => ({
            globalHash: genHash(),
            level: 0,
            cardType,
            vanillaData: { frontText: 'Q', backText: 'A', media: {} },
            customData: { html: '' },
            ...overrides,
        });

        it('should persist card_type for all five card types', async () => {
            const cards = [
                makeCard('basic'),
                makeCard('reversible'),
                makeCard('cloze', { vanillaData: { frontText: 'The {{sun}} is a {{star}}.', backText: 'The {{sun}} is a {{star}}.', media: {} } }),
                makeCard('type_answer', { vanillaData: { frontText: 'Capital of France?', backText: 'Paris', media: {} } }),
                makeCard('custom', { vanillaData: { frontText: '', backText: '', media: {} }, customData: { html: '<b>Hi</b>' } }),
            ];

            await docs.updateFile(docPath, '# Typed Cards', { globalHash: genHash(), flashcards: cards });

            for (const card of cards) {
                const row = await db.prepare('SELECT card_type FROM Flashcards WHERE global_hash = ?').get(card.globalHash);
                assert.ok(row, `Card with type "${card.cardType}" should exist in DB`);
                assert.equal(row.card_type, card.cardType, `card_type should be stored as "${card.cardType}"`);
            }
        });

        it('should preserve card_type on flashcard update', async () => {
            const hash = genHash();
            await docs.updateFile(docPath, '# Typed Cards', {
                globalHash: genHash(),
                flashcards: [makeCard('cloze', { globalHash: hash, vanillaData: { frontText: 'The {{sun}} is a star.', backText: 'The {{sun}} is a star.', media: {} } })],
            });

            await docs.updateFile(docPath, '# Typed Cards updated', {
                globalHash: genHash(),
                flashcards: [makeCard('cloze', { globalHash: hash, vanillaData: { frontText: 'The {{moon}} orbits Earth.', backText: 'The {{moon}} orbits Earth.', media: {} } })],
            });

            const row = await db.prepare('SELECT card_type, content_id FROM Flashcards WHERE global_hash = ?').get(hash);
            assert.equal(row.card_type, 'cloze', 'card_type should survive an update');

            const content = await db.prepare('SELECT frontText FROM FlashcardContent WHERE id = ?').get(row.content_id);
            assert.ok(content.frontText.includes('moon'), 'Content frontText should be updated');
        });

        it('should store a type_answer card\'s answer and notes separately', async () => {
            const hash = genHash();
            await docs.updateFile(docPath, '# Kana', {
                globalHash: genHash(),
                flashcards: [makeCard('type_answer', {
                    globalHash: hash,
                    vanillaData: { frontText: 'か', answerText: 'ka', backText: 'Looks like a kayak.', media: {} },
                })],
            });

            const row = await db.prepare('SELECT content_id FROM Flashcards WHERE global_hash = ?').get(hash);
            const content = await db.prepare('SELECT frontText, backText, answerText FROM FlashcardContent WHERE id = ?').get(row.content_id);
            assert.equal(content.answerText, 'ka');
            assert.equal(content.backText, 'Looks like a kayak.');
        });

        it('should leave a pre-split type_answer card without an answerText', async () => {
            const hash = genHash();
            await docs.updateFile(docPath, '# Kana legacy', {
                globalHash: genHash(),
                flashcards: [makeCard('type_answer', {
                    globalHash: hash,
                    vanillaData: { frontText: 'き', backText: 'ki', media: {} },
                })],
            });

            const row = await db.prepare('SELECT content_id FROM Flashcards WHERE global_hash = ?').get(hash);
            const content = await db.prepare('SELECT backText, answerText FROM FlashcardContent WHERE id = ?').get(row.content_id);
            assert.equal(content.answerText, null, 'no answer is invented');
            assert.equal(content.backText, 'ki', 'the answer stays where the card put it');
        });

        it('should not invent an answerText when editing a pre-split card', async () => {
            const hash = genHash();
            await docs.updateFile(docPath, '# Kana legacy edit', {
                globalHash: genHash(),
                flashcards: [makeCard('type_answer', {
                    globalHash: hash,
                    vanillaData: { frontText: 'け', backText: 'ke', media: {} },
                })],
            });

            const updated = await docs.updateFlashcard(docPath, hash, { frontText: 'け (edited)' });
            assert.equal(updated.vanillaData.answerText, undefined, 'still reads as pre-split');
            assert.equal(updated.vanillaData.backText, 'ke', 'the answer stays where it is');

            const row = await db.prepare('SELECT content_id FROM Flashcards WHERE global_hash = ?').get(hash);
            const content = await db.prepare('SELECT backText, answerText FROM FlashcardContent WHERE id = ?').get(row.content_id);
            assert.equal(content.answerText, null);
            assert.equal(content.backText, 'ke');
        });

        it('should update a type_answer card\'s notes without touching its answer', async () => {
            const hash = genHash();
            await docs.updateFile(docPath, '# Kana edit', {
                globalHash: genHash(),
                flashcards: [makeCard('type_answer', {
                    globalHash: hash,
                    vanillaData: { frontText: 'く', answerText: 'ku', backText: 'A cuckoo.', media: {} },
                })],
            });

            const updated = await docs.updateFlashcard(docPath, hash, { backText: 'A coo-coo bird.' });
            assert.equal(updated.vanillaData.answerText, 'ku');
            assert.equal(updated.vanillaData.backText, 'A coo-coo bird.');

            const row = await db.prepare('SELECT content_id FROM Flashcards WHERE global_hash = ?').get(hash);
            const content = await db.prepare('SELECT backText, answerText FROM FlashcardContent WHERE id = ?').get(row.content_id);
            assert.equal(content.answerText, 'ku');
            assert.equal(content.backText, 'A coo-coo bird.');
        });
    });

    describe('SRS & Presence', () => {
        const docPath = path.join(TEST_ROOT, 'Algebra', 'LinEq.md');
        let fcHash;

        before(async () => {
            const row = await db.prepare(`
                SELECT f.global_hash FROM Flashcards f
                JOIN Documents d ON f.document_id = d.id
                WHERE d.relative_path = ? LIMIT 1
            `).get(docPath);
            assert.ok(row, 'A flashcard must exist for SRS tests (check Flashcard Synchronization group)');
            fcHash = row.global_hash;
        });

        it('should submit a review and update the flashcard level', async () => {
            await docs.submitReview(docPath, fcHash, 5, 2.5, 5);

            const fc = await db.prepare(`
                SELECT p.level FROM CardProgress p
                JOIN Flashcards f ON f.global_hash = p.card_hash
                WHERE f.global_hash = ? AND p.account_id = 'owner'
            `).get(fcHash);
            assert.equal(fc.level, 5, 'Flashcard level should be updated to 5');
        });

        it('should write a ReviewLog entry on each review', async () => {
            const before = (await db.prepare('SELECT COUNT(*) as c FROM ReviewLogs WHERE card_hash = ?').get(fcHash)).c;

            await docs.submitReview(docPath, fcHash, 3, 2.0, 4);

            const after = (await db.prepare('SELECT COUNT(*) as c FROM ReviewLogs WHERE card_hash = ?').get(fcHash)).c;
            assert.equal(after, before + 1, 'A new ReviewLog entry should be created for each review');
        });

        it('should propagate presence (mastery) up to the folder', async () => {
            const doc = await db.prepare('SELECT presence FROM Documents WHERE relative_path = ?').get(docPath);
            assert.ok(doc.presence > 0, 'Document presence should be positive');

            const folder = await db.prepare('SELECT presence FROM Folders WHERE relative_path = ?').get(path.join(TEST_ROOT, 'Algebra'));
            assert.ok(folder.presence > 0, 'Folder presence should be positive (propagated from document)');
        });

        it('should return valid Leitner box statistics', async () => {
            const stats = await docs.srs.getLeitnerStats();

            assert.ok(typeof stats.total === 'number', 'total should be a number');
            assert.ok(stats.total > 0, 'Should have at least one card from prior tests');
            assert.ok(typeof stats.mastered === 'number', 'mastered should be a number');
            assert.ok(stats.mastered <= stats.total, 'mastered cards are a subset of all cards');
            assert.ok(typeof stats.masteryPercentage === 'number', 'masteryPercentage should be a number');
            assert.ok(stats.masteryPercentage >= 0 && stats.masteryPercentage <= 100, 'masteryPercentage must be between 0 and 100');
            assert.ok(Array.isArray(stats.boxes), 'boxes should be an array');
            assert.ok(stats.boxes.every(b => typeof b.level === 'number' && typeof b.count === 'number'), 'Each box entry must have level and count');
        });
    });

    describe('Search & Graph', () => {
        it('should find the flashcard by text', async () => {
            const results = await docs.search('Q1 Modified');
            assert.ok(results.length > 0, 'Should return search results');
            assert.equal(results[0].type, 'flashcard');
        });

        it('should return valid graph data', async () => {
            const graph = await docs.getGraphData();
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
            const docEntry = await docs.exists(docRelPath, true, false);
            assert.ok(docEntry, "Imported document should exist in DB");
            assert.equal(docEntry.name, importName);

            const fullPath = path.join(getWorkspacePath(), docRelPath);
            const diskContent = fs.readFileSync(fullPath, 'utf-8');
            assert.equal(diskContent, importContent, "Disk content should match imported content");

            const tagCheck = await db.prepare(`
                SELECT t.name FROM Tags t
                JOIN Connections c ON c.destiny_id = t.node_id
                JOIN Documents d ON d.node_id = c.origin_id
                WHERE d.id = ? AND t.name = ?
            `).get(docEntry.id, "Imported");
            assert.ok(tagCheck, "Document should have the 'Imported' tag connected");

            const fcCount = (await db.prepare('SELECT COUNT(*) as c FROM Flashcards WHERE document_id = ?').get(docEntry.id)).c;
            assert.equal(fcCount, 1, "Should have 1 flashcard linked to the imported document");
        });
    });

    describe('Package Import', () => {
        const pkgName = "DummyCourse";
        const externalPath = path.join(testDataDir(), pkgName);

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

            const folderEntry = await docs.exists(importedRootRel, true, true);
            assert.ok(folderEntry, "Imported root folder should exist in DB");
            assert.notEqual(folderEntry.globalHash, "original-root-hash", "Root hash should be regenerated");

            const docRel = path.join(importedRootRel, 'Lecture1.md');
            const docEntry = await docs.exists(docRel, true, false);
            assert.ok(docEntry, "Lecture1.md should be indexed");

            const flashcard = await db.prepare(`
                SELECT f.*, COALESCE(p.level, 0) AS level
                FROM Flashcards f
                LEFT JOIN CardProgress p ON p.card_hash = f.global_hash AND p.account_id = 'owner'
                WHERE f.document_id = ?
            `).get(docEntry.id);
            assert.ok(flashcard, "Flashcard should be imported");
            assert.equal(flashcard.level, 0, "Flashcard level should be reset to 0");
            assert.notEqual(flashcard.global_hash, "original-card-hash", "Flashcard hash should be regenerated");

            const importedMeta = docs.files.getMetadata(docRel);
            assert.strictEqual(importedMeta.flashcards[0].lastRecall, undefined, "lastRecall should be stripped from file metadata");

            const mediaRel = path.join(importedRootRel, "media", "cell_diagram.png");
            
            assert.ok(await docs.files.exists(mediaRel), "Media file should be copied to workspace");
            const mediaEntry = await db.prepare('SELECT * FROM Media WHERE relative_path = ?').get(mediaRel);
            assert.ok(mediaEntry, "Media file should be registered in the Media table");
        });
    });

    describe('Zip Package Processing', () => {
        const zipName = "CourseArchive.zip";
        const zipPath = path.join(testDataDir(), zipName);

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

            const rootExists = await docs.exists(expectedRoot, true, true);
            assert.ok(rootExists, "Unzipped root folder should exist in DB");

            const fileRel = path.join(expectedRoot, "Chapter1", "Lesson1.md");
            const fileExists = await docs.exists(fileRel, true, false);
            assert.ok(fileExists, "Nested file from zip should be indexed");

            const dbCard = await db.prepare(`
                SELECT COALESCE(p.level, 0) AS level, f.global_hash
                FROM Flashcards f
                LEFT JOIN CardProgress p ON p.card_hash = f.global_hash AND p.account_id = 'owner'
                WHERE f.document_id = ?
            `).get(fileExists.id);
            assert.ok(dbCard, "Flashcard from zip should be imported");
            assert.equal(dbCard.level, 0, "Flashcard level should be reset to 0");
            assert.notEqual(dbCard.global_hash, "old-card-hash", "Flashcard hash should be regenerated");
        });
    });

    describe('Search — extended', () => {
        it('should find a document by name', async () => {
            const results = await docs.search('LinEq');
            const docResult = results.find(r => r.type === 'document');
            assert.ok(docResult, 'Should return at least one document result');
        });

        it('should find a tag by name', async () => {
            const results = await docs.search('Equations');
            const tagResult = results.find(r => r.type === 'tag');
            assert.ok(tagResult, 'Should return at least one tag result');
        });

        it('should return graph nodes with recognised type labels', async () => {
            const { nodes } = await docs.getGraphData();
            const types = new Set(nodes.map(n => n.type));
            const expected = ['Document', 'Folder', 'Flashcard', 'Tag'];
            for (const t of expected) {
                assert.ok(types.has(t), `Graph should contain at least one node of type "${t}"`);
            }
        });
    });

    describe('Package Export', () => {
        const exportFolder = "ExportTest";

        const cleanupExport = () => {
            try {
                const absPath = path.join(getWorkspacePath(), exportFolder);
                if (fs.existsSync(absPath)) fs.rmSync(absPath, { recursive: true, force: true });
            } catch {}
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

    describe('Atomic sidecar writes', () => {
        const docRel = path.join(TEST_ROOT, 'Algebra', 'LinEq.md');
        const sidecarOf = (rel) => `${path.join(getWorkspacePath(), rel)}.flashback`;
        const tmpSiblings = (rel) => fs.readdirSync(path.dirname(sidecarOf(rel)))
            .filter((n) => n.includes('.flashback.tmp-'));

        it('leaves no temporary sibling behind after a successful write', () => {
            const meta = docs.files.getMetadata(docRel, false);
            meta.description = 'written atomically';
            docs.files.writeMetadata(docRel, meta, false);
            assert.equal(docs.files.getMetadata(docRel, false).description, 'written atomically');
            assert.deepEqual(tmpSiblings(docRel), []);
        });

        it('keeps the previous sidecar intact when the disk fills mid-write', () => {
            const before = fs.readFileSync(sidecarOf(docRel), 'utf-8');
            const meta = JSON.parse(before);
            meta.description = 'this must never land';

            const realWrite = fs.writeFileSync;
            fs.writeFileSync = (file, ...rest) => {
                if (String(file).includes('.tmp-')) {
                    throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
                }
                return realWrite(file, ...rest);
            };
            try {
                assert.throws(() => docs.files.writeMetadata(docRel, meta, false), (err) => err.code === 'ENOSPC',
                    'the raw errno travels up so the HTTP layer can answer 507');
            } finally {
                fs.writeFileSync = realWrite;
            }

            assert.equal(fs.readFileSync(sidecarOf(docRel), 'utf-8'), before, 'byte-identical to before');
            assert.deepEqual(tmpSiblings(docRel), [], 'the failed sibling was removed');
        });
    });

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
            assert.ok(!await docs.files.exists(filePath), 'File should not exist on filesystem');
            assert.ok(!await docs.exists(filePath, true, false), 'File should not exist in DB');
        });

        it('should cascade-delete documents and flashcards when a folder is deleted', async () => {
            await docs.createFile(fileName, subFolderPath);
            await docs.updateFile(filePath, '# Delete me', {
                globalHash: crypto.randomUUID(),
                flashcards: [{ globalHash: crypto.randomUUID(), vanillaData: { frontText: 'Q', backText: 'A' } }]
            });

            const docEntry = await docs.exists(filePath, true, false);
            assert.ok(docEntry, 'Document should exist before folder deletion');

            await docs.delete(subFolderPath, true);

            assert.ok(!await docs.files.exists(subFolderPath), 'Folder should not exist on filesystem');
            assert.ok(!await docs.exists(subFolderPath, true, true), 'Folder should not exist in DB');

            const orphanedDoc = await db.prepare('SELECT id FROM Documents WHERE id = ?').get(docEntry.id);
            assert.strictEqual(orphanedDoc, undefined, 'Document should be cascade-deleted with its folder');

            const orphanedFc = await db.prepare('SELECT id FROM Flashcards WHERE document_id = ?').get(docEntry.id);
            assert.strictEqual(orphanedFc, undefined, 'Flashcards should be cascade-deleted with their document');
        });

        it('should not delete a non-existent file without throwing silently', async () => {
            await assert.rejects(
                async () => await docs.delete('nonexistent/path/file.md', false),
                'Deleting a non-existent path should throw'
            );
        });
    });

    describe('File Utilities', () => {
        const existingDoc = path.join(TEST_ROOT, 'Algebra', 'LinEq.md');

        it('should read a file and return content with detected encoding', () => {
            const result = docs.files.readFile(existingDoc);
            assert.ok(typeof result.content === 'string', 'content should be a string');
            assert.ok(typeof result.encoding === 'string', 'encoding should be detected and returned');
            assert.equal(result.binary, false, 'a markdown file is not binary');
            assert.ok(result.size > 0, 'size is reported');
        });

        it('should flag a binary file instead of decoding it, and refuse a text overwrite', async () => {
            const binRel = path.join(TEST_ROOT, 'Algebra', 'scan.pdf');
            const bytes = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from([0x00, 0x01]), Buffer.alloc(512, 0xa7)]);
            await docs.importFile('scan.pdf', path.join(TEST_ROOT, 'Algebra'), bytes, {});

            const result = docs.files.readFile(binRel);
            assert.equal(result.binary, true, 'flagged as binary');
            assert.equal(result.content, null, 'no decoded content');
            assert.equal(result.encoding, 'binary');
            assert.equal(result.size, bytes.length);
            assert.equal(docs.files.isBinaryFile(binRel), true);
            assert.equal(docs.files.isBinaryFile(existingDoc), false);

            await assert.rejects(
                async () => await docs.updateFile(binRel, 'plain text', null),
                /Cannot overwrite the binary file/,
                'a text write over a binary file is refused',
            );
            assert.equal(docs.files.readFile(binRel).size, bytes.length, 'file untouched');

            await docs.delete(binRel, false);
        });

        it('should list folder contents including type and metadata', async () => {
            const items = await docs.files.listFolder(TEST_ROOT);
            assert.ok(Array.isArray(items), 'listFolder should return an array');
            assert.ok(items.length > 0, 'TestWorkspace should have items after all prior tests');
            assert.ok(items.every(i => i.type === 'file' || i.type === 'folder'), 'Every item should have a recognised type');
            assert.ok(items.every(i => !i.name.endsWith('.flashback')), 'Sidecar files must not appear in listings');
        });

        it('should copy a file and assign a new globalHash to the copy (Files layer)', async () => {
            const destPath = path.join(TEST_ROOT, 'Algebra', 'LinEqCopy.md');
            const srcMeta = docs.files.getMetadata(existingDoc);

            const result = await docs.files.copy(existingDoc, destPath, false);

            assert.ok(await docs.files.exists(existingDoc), 'Original should still exist after copy');
            assert.ok(await docs.files.exists(destPath), 'Copy should exist on filesystem');

            const destMeta = docs.files.getMetadata(destPath);
            assert.notEqual(destMeta.globalHash, srcMeta.globalHash, 'Copy must have a different globalHash');
            assert.equal(destMeta.copiedFrom, srcMeta.globalHash, 'Copy should record the source globalHash');
            assert.ok(Array.isArray(result), 'copy() should return an array of created items');
            assert.equal(result[0].globalHash, destMeta.globalHash, 'Returned item globalHash should match the new sidecar');

            await docs.files.delete(destPath, false);
        });
    });

    describe('Copy Operations', () => {
        const srcPath = path.join(TEST_ROOT, 'Algebra', 'LinEq.md');
        const destPath = path.join(TEST_ROOT, 'Algebra', 'LinEqCopy_Orchestrated.md');

        before(async () => {
            try { if (await docs.files.exists(destPath)) await docs.files.delete(destPath, false); } catch {}
        });

        after(async () => {
            try { if (await docs.files.exists(destPath)) await docs.files.delete(destPath, false); } catch {}
        });

        it('should register the copy in DB with a new globalHash and fire a Seal commit', async () => {
            const srcMeta = docs.files.getMetadata(srcPath);
            const beforeHead = (await sealTools.log(1))[0]?.oid;

            await docs.copy(srcPath, destPath, false);

            assert.ok(await docs.files.exists(destPath), 'Copy should exist on filesystem');
            assert.ok(await docs.files.exists(srcPath), 'Original should still exist');

            const destDoc = await docs.exists(destPath, true, false);
            assert.ok(destDoc, 'Copy should be registered in the DB');
            assert.notEqual(destDoc.global_hash, srcMeta.globalHash, 'Copy must have a distinct globalHash in DB');

            const fcCount = (await db.prepare('SELECT COUNT(*) as c FROM Flashcards WHERE document_id = ?').get(destDoc.id)).c;
            assert.ok(fcCount > 0, 'Copied flashcards should be inserted into the DB');

            const afterLog = await sealTools.log(1);
            assert.notEqual(afterLog[0]?.oid, beforeHead, 'Documents.copy() should produce a new Seal commit');
            assert.ok(afterLog[0].commit.message.startsWith('create:'), 'Seal commit for a copy should be a create');
        });
    });

    describe('Document Links', () => {
        const linksRoot = path.join(TEST_ROOT, 'LinksTest');
        let sourceHash, targetHash, sourceRelPath, targetRelPath;

        before(async () => {
            await docs.createFolder('LinksTest', TEST_ROOT);
            await docs.createFile('source.md', linksRoot);
            await docs.createFile('target.md', linksRoot);

            sourceRelPath = path.join(linksRoot, 'source.md');
            targetRelPath = path.join(linksRoot, 'target.md');

            sourceHash = docs.files.getMetadata(sourceRelPath).globalHash;
            targetHash = docs.files.getMetadata(targetRelPath).globalHash;
        });

        it('creates a link Connection when source references a known target hash', async () => {
            const content = `# Source\n\nSee also [target](flashback://${targetHash}).`;
            await docs.updateFile(sourceRelPath, content, null);

            const sourceDoc = await documentRows.getByPath(sourceRelPath);
            const targetDoc = await documentRows.getByHash(targetHash);
            const linkTypeId = (await nodeRows.typeIds()).linkConnTypeId;

            const conn = await db.prepare(
                'SELECT * FROM Connections WHERE origin_id = ? AND destiny_id = ? AND type_id = ?'
            ).get(sourceDoc.node_id, targetDoc.node_id, linkTypeId);

            assert.ok(conn, 'A link Connection should be created between source and target nodes');
        });

        it('updates the sidecar links array after sync', () => {
            const sidecar = docs.files.getMetadata(sourceRelPath);
            assert.ok(Array.isArray(sidecar.links), 'sidecar.links should be an array');
            assert.equal(sidecar.links.length, 1, 'sidecar should record one outbound link');
            assert.equal(sidecar.links[0].targetHash, targetHash);
        });

        it('queues unresolved links for future import', async () => {
            const unknownHash = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
            const content = `# Source\n\nSee [unknown](flashback://${unknownHash}).`;
            await docs.updateFile(sourceRelPath, content, null);

            const pending = await linkRows.getPendingForTarget(unknownHash);
            assert.equal(pending.length, 1, 'Unresolved link should land in DocumentLinks queue');
            assert.equal(pending[0].source_hash, sourceHash);
        });

        it('removes a link Connection when the link is removed from the file', async () => {
            await docs.updateFile(sourceRelPath, `See [target](flashback://${targetHash}).`, null);
            const sourceDoc = await documentRows.getByPath(sourceRelPath);
            const targetDoc = await documentRows.getByHash(targetHash);
            const linkTypeId = (await nodeRows.typeIds()).linkConnTypeId;
            const connBefore = await db.prepare(
                'SELECT * FROM Connections WHERE origin_id = ? AND destiny_id = ? AND type_id = ?'
            ).get(sourceDoc.node_id, targetDoc.node_id, linkTypeId);
            assert.ok(connBefore, 'Connection should exist before removal');

            await docs.updateFile(sourceRelPath, '# No links here.', null);
            const connAfter = await db.prepare(
                'SELECT * FROM Connections WHERE origin_id = ? AND destiny_id = ? AND type_id = ?'
            ).get(sourceDoc.node_id, targetDoc.node_id, linkTypeId);
            assert.equal(connAfter, undefined, 'Connection should be removed when link is deleted from file');
        });

        it('link edges appear in getGraphData()', async () => {
            const content = `# Source\n\nSee [target](flashback://${targetHash}).`;
            await docs.updateFile(sourceRelPath, content, null);

            const { edges } = await docs.getGraphData();
            const linkEdge = edges.find(e => e.relation === 'link');
            assert.ok(linkEdge, 'getGraphData() should include at least one link-type edge');
        });

        it('leaves no out-of-band drift after importing a linked document', async () => {
            await docs.importFile('linktarget.md', linksRoot, '# Target', {});
            const tHash = docs.files.getMetadata(path.join(linksRoot, 'linktarget.md')).globalHash;
            await docs.importFile('linksource.md', linksRoot, `See [t](flashback://${tHash}).`, {});
            await sealEmitter.flushEdits();

            const sidecar = docs.files.getMetadata(path.join(linksRoot, 'linksource.md'));
            assert.equal(sidecar.links?.[0]?.targetHash, tHash, 'imported sidecar should record the link');

            const drift = await sealTools.inspect();
            const dirty = [...drift.added, ...drift.modified, ...drift.deleted];
            assert.ok(
                !dirty.some(p => p.endsWith('linksource.md.flashback')),
                `linked import should seal the sidecar, but it drifted: ${JSON.stringify(dirty)}`
            );
        });
    });

    describe('Card removal budget', () => {
        const BUDGET_ROOT = path.join(TEST_ROOT, 'BudgetTest');
        const DOC = path.join(BUDGET_ROOT, 'deck.md');
        const collaborator = { id: 'collab-budget-test', name: 'Sam', role: 'collaborator' };
        const admin = { id: 'admin-budget-test', name: 'Alex', role: 'admin' };

        let runWithAccount, budget;
        let cards;

        const sidecarCards = () => docs.files.getMetadata(DOC)?.flashcards ?? [];
        const withoutFirst = (n) => sidecarCards().slice(n);

        before(async () => {
            ({ runWithAccount } = await import('../../src/api/requestContext.js'));
            budget = (await import('../../src/api/access/resources/cardRemovalBudget.js')).default;

            await docs.createFolder('BudgetTest', TEST_ROOT);
            await docs.importFile('deck.md', BUDGET_ROOT, '# Deck', {
                globalHash: genHash(),
                flashcards: Array.from({ length: 30 }, (_, i) => ({
                    globalHash: genHash(),
                    cardType: 'basic',
                    vanillaData: { frontText: `q${i}`, backText: `a${i}` },
                })),
            });
            cards = sidecarCards();
            assert.equal(cards.length, 30, 'precondition: 30 cards on disk');
        });

        it('lets a collaborator remove a few cards', async () => {
            budget.reset();
            await runWithAccount(collaborator, () =>
                docs.updateMetadata(DOC, { ...docs.files.getMetadata(DOC), flashcards: withoutFirst(3) }));
            assert.equal(sidecarCards().length, 27);
        });

        it('refuses a single write that would clear the document, and writes nothing', async () => {
            budget.reset();
            const before = sidecarCards().length;

            await assert.rejects(
                () => runWithAccount(collaborator, () =>
                    docs.updateMetadata(DOC, { ...docs.files.getMetadata(DOC), flashcards: [] })),
                (err) => {
                    assert.equal(err.status, 429);
                    assert.equal(err.code, 'removal_budget');
                    return true;
                },
            );

            assert.equal(sidecarCards().length, before, 'the sidecar must be untouched');
            const inDb = await flashcardRows.getByDocument(
                (await documentRows.getByPath(DOC)).id, 'owner');
            assert.equal(inDb.length, before, 'the index must be untouched');
        });

        it('exhausts the hourly allowance across several small writes', async () => {
            budget.reset();
            for (let i = 0; i < 4; i++) {
                await runWithAccount(collaborator, () =>
                    docs.updateMetadata(DOC, { ...docs.files.getMetadata(DOC), flashcards: withoutFirst(5) }));
            }
            await assert.rejects(
                () => runWithAccount(collaborator, () =>
                    docs.updateMetadata(DOC, { ...docs.files.getMetadata(DOC), flashcards: withoutFirst(1) })),
                (err) => err.status === 429,
            );
        });

        it('never charges an admin, so the desktop Author is unaffected', async () => {
            budget.reset();
            const before = sidecarCards().length;
            assert.ok(before > 0, 'precondition: cards remain');

            await runWithAccount(admin, () =>
                docs.updateMetadata(DOC, { ...docs.files.getMetadata(DOC), flashcards: [] }));
            assert.equal(sidecarCards().length, 0, 'an admin may clear a document');
        });

        it('keeps globalHash and createdBy as the server assigned them', async () => {
            budget.reset();
            const real = docs.files.getMetadata(DOC);
            await runWithAccount(collaborator, () => docs.updateMetadata(DOC, {
                ...real,
                globalHash: 'forged-hash',
                createdBy: 'somebody else',
                tags: ['annotated'],
            }));

            const after = docs.files.getMetadata(DOC);
            assert.equal(after.globalHash, real.globalHash, 'globalHash is immutable once assigned');
            assert.equal(after.createdBy, real.createdBy, 'createdBy mirrors disk, absent included');
            assert.notEqual(after.createdBy, 'somebody else');
            assert.deepEqual(after.tags, ['annotated'], 'the legitimate part of the write still lands');
        });
    });
});
