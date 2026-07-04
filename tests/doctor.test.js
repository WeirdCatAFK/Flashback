import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

process.env.USER_DATA_PATH = path.join(process.cwd(), 'data_test_doctor');
console.log('USER_DATA_PATH:', process.env.USER_DATA_PATH);

const { default: validate } = await import('../src/api/config/validate.js');
if (!validate()) {
    console.error('Validation failed.');
    process.exit(1);
}

const { default: Documents } = await import('../src/api/access/documents.js');
const { default: Doctor } = await import('../src/api/access/doctor.js');
const { default: Decks } = await import('../src/api/access/decks.js');
const { default: query } = await import('../src/api/access/query.js');
const { default: db } = await import('../src/api/access/database.js');
const { sealTools, sealEmitter } = await import('../src/api/seal/seal.js');
const { getWorkspacePath } = await import('../src/api/access/config.js');

const docs = new Documents();
const doctor = new Doctor();
const decks = new Decks();
const workspace = getWorkspacePath();
const TEST_ROOT = 'DoctorTests';

const abs = (...p) => path.join(workspace, ...p);
const readSidecar = (relPath) => JSON.parse(fs.readFileSync(abs(relPath + '.flashback'), 'utf-8'));
const writeSidecar = (relPath, data) => fs.writeFileSync(abs(relPath + '.flashback'), JSON.stringify(data, null, 2));

describe('Vault Doctor', () => {

    before(async () => {
        try { if (docs.exists(TEST_ROOT, true, true)) await docs.delete(TEST_ROOT, true); } catch (e) { /* clean slate */ }
        await sealTools.init();
        await docs.createFolder(TEST_ROOT);
    });

    after(async () => {
        db.close();
        await new Promise(resolve => setTimeout(resolve, 50));
        try {
            fs.rmSync(process.env.USER_DATA_PATH, { recursive: true, force: true });
        } catch (e) {
            console.warn('Teardown warning (safe to ignore):', e.message);
        }
    });

    // --- 1. CLEAN VAULT ---
    describe('checkIndex on a clean vault', () => {
        it('reports integrity ok and no issues', async () => {
            const report = await doctor.checkIndex();
            assert.equal(report.db.integrity, 'ok');
            assert.deepEqual(report.documents.missingInDb, []);
            assert.deepEqual(report.documents.orphanedInDb, []);
            assert.deepEqual(report.documents.modified, []);
            assert.deepEqual(report.documents.hashConflicts, []);
            assert.deepEqual(report.folders.missingInDb, []);
            assert.deepEqual(report.folders.orphanedInDb, []);
            assert.deepEqual(report.media.missingOnDisk, []);
            assert.deepEqual(report.media.unregistered, []);
        });
    });

    // --- 2. ADDED OUT-OF-BAND ---
    describe('out-of-band added document', () => {
        const rel = path.join(TEST_ROOT, 'OobFolder', 'Added.md');
        const cardHash = crypto.randomUUID();

        before(() => {
            // A document + sidecar dropped onto disk with no Flashback involvement,
            // inside a plain directory that has no sidecar either (ghost dir).
            fs.mkdirSync(abs(TEST_ROOT, 'OobFolder'), { recursive: true });
            fs.writeFileSync(abs(rel), '# Added out of band');
            writeSidecar(rel, {
                globalHash: crypto.randomUUID(),
                tags: ['oob-tag'],
                flashcards: [{ globalHash: cardHash, level: 3, vanillaData: { frontText: 'Q', backText: 'A' } }],
            });
        });

        it('checkIndex reports the document and ghost folder as missing from the index', async () => {
            const report = await doctor.checkIndex();
            assert.ok(report.documents.missingInDb.some(p => p.includes('Added.md')));
            assert.ok(report.folders.missingInDb.some(p => p.includes('OobFolder')));
            assert.ok(report.folders.ghostDirs.some(p => p.includes('OobFolder')));
        });

        it('syncIndex indexes it with cards, tags, and parent folder, and seals one reconcile commit', async () => {
            const logBefore = (await sealTools.log()).length;
            const result = await doctor.syncIndex();

            assert.ok(result.actions.documentsIndexed >= 1, 'document should be indexed');
            assert.ok(result.actions.foldersIndexed >= 1, 'ghost folder should be indexed');

            const doc = query.getDocumentByPath(rel);
            assert.ok(doc, 'Documents row exists');
            const cards = query.getFlashcardsByDocument(doc.id);
            assert.equal(cards.length, 1);
            assert.equal(cards[0].global_hash, cardHash);
            assert.equal(cards[0].level, 3, 'sidecar level adopted');
            assert.ok(query.getDirectTagNames(doc.node_id).includes('oob-tag'));
            assert.ok(query.getFolderByPath(path.join(TEST_ROOT, 'OobFolder')), 'ghost folder registered');

            assert.ok(result.sealedOid, 'drift was sealed');
            const log = await sealTools.log();
            assert.equal(log.length, logBefore + 1, 'exactly one new commit');
            assert.ok(log[0].commit.message.startsWith('reconcile:'), `got: ${log[0].commit.message}`);

            const drift = await sealTools.inspect();
            assert.deepEqual(drift, { added: [], modified: [], deleted: [] }, 'workspace clean after sealing');
        });
    });

    // --- 3. MODIFIED OUT-OF-BAND (SRS max-merge) ---
    describe('out-of-band modified document', () => {
        const rel = path.join(TEST_ROOT, 'Modified.md');
        const keepHash = crypto.randomUUID();
        const regressHash = crypto.randomUUID();
        const newHash = crypto.randomUUID();

        before(async () => {
            await docs.createFile('Modified.md', TEST_ROOT);
            await docs.updateFile(rel, '# Modified', {
                globalHash: crypto.randomUUID(),
                flashcards: [
                    { globalHash: keepHash, level: 1, vanillaData: { frontText: 'keep', backText: 'a' } },
                    { globalHash: regressHash, level: 5, vanillaData: { frontText: 'regress', backText: 'b' } },
                ],
            });
            await sealEmitter.flushEdits();

            // Out-of-band: raise one level, lower another, add a card.
            const sidecar = readSidecar(rel);
            sidecar.flashcards[0].level = 4;   // raised — should be adopted
            sidecar.flashcards[1].level = 1;   // lowered — must NOT regress the DB
            sidecar.flashcards.push({ globalHash: newHash, level: 0, vanillaData: { frontText: 'new', backText: 'c' } });
            writeSidecar(rel, sidecar);
        });

        it('checkIndex flags it as modified with reasons', async () => {
            const report = await doctor.checkIndex();
            const entry = report.documents.modified.find(m => m.relPath.includes('Modified.md'));
            assert.ok(entry, 'document flagged as modified');
            assert.ok(entry.reasons.includes('cardSetChanged'));
            assert.ok(entry.reasons.includes('levelAhead'));
        });

        it('syncIndex adopts raised levels, never regresses, and adds the new card', async () => {
            const result = await doctor.syncIndex();
            assert.ok(result.actions.documentsReindexed >= 1);

            const doc = query.getDocumentByPath(rel);
            const byHash = new Map(query.getFlashcardsByDocument(doc.id).map(c => [c.global_hash, c]));
            assert.equal(byHash.size, 3, 'new card was added');
            assert.equal(byHash.get(keepHash).level, 4, 'raised level adopted');
            assert.equal(byHash.get(regressHash).level, 5, 'lowered level did not regress');
            assert.ok(byHash.has(newHash));
        });
    });

    // --- 4/5. DELETED OUT-OF-BAND ---
    describe('out-of-band deletions', () => {
        const fileRel = path.join(TEST_ROOT, 'Doomed.md');
        const folderRel = path.join(TEST_ROOT, 'DoomedFolder');
        const nestedRel = path.join(folderRel, 'Nested.md');

        before(async () => {
            await docs.createFile('Doomed.md', TEST_ROOT);
            await docs.createFolder('DoomedFolder', TEST_ROOT);
            await docs.importFile('Nested.md', folderRel, '# nested', {
                globalHash: crypto.randomUUID(),
                flashcards: [{ globalHash: crypto.randomUUID(), vanillaData: { frontText: 'q', backText: 'a' } }],
            });
            await sealEmitter.flushEdits();

            // Delete both out-of-band (raw fs, no Flashback involvement).
            fs.unlinkSync(abs(fileRel));
            fs.unlinkSync(abs(fileRel + '.flashback'));
            fs.rmSync(abs(folderRel), { recursive: true, force: true });
        });

        it('checkIndex reports the orphaned rows', async () => {
            const report = await doctor.checkIndex();
            assert.ok(report.documents.orphanedInDb.some(p => p.includes('Doomed.md')));
            assert.ok(report.folders.orphanedInDb.some(p => p.includes('DoomedFolder')));
        });

        it('syncIndex removes the rows (folder cascade included) and seals the deletions', async () => {
            const nestedDocId = query.getDocumentByPath(nestedRel)?.id;
            assert.ok(nestedDocId, 'nested doc indexed before sync');

            const result = await doctor.syncIndex();
            assert.ok(result.actions.documentsRemoved >= 1 || result.actions.foldersRemoved >= 1);

            assert.equal(query.getDocumentByPath(fileRel), undefined);
            assert.equal(query.getFolderByPath(folderRel), undefined);
            assert.equal(query.getDocumentByPath(nestedRel), undefined, 'nested doc cascaded');
            assert.equal(query.getFlashcardsByDocument(nestedDocId).length, 0, 'nested cards cascaded');

            assert.ok(result.sealedOid, 'deletions were sealed');
            const drift = await sealTools.inspect();
            assert.deepEqual(drift.deleted, [], 'no unsealed deletions remain');
        });
    });

    // --- 6. POST-ROLLBACK (the inspect() blind spot) ---
    describe('post-rollback reconciliation', () => {
        const rel = path.join(TEST_ROOT, 'Rollback.md');
        const v1Hash = crypto.randomUUID();
        const v2Hash = crypto.randomUUID();
        let snapshotRef;

        before(async () => {
            await docs.createFile('Rollback.md', TEST_ROOT);
            await docs.updateFile(rel, '# v1', {
                globalHash: crypto.randomUUID(),
                flashcards: [{ globalHash: v1Hash, vanillaData: { frontText: 'v1', backText: 'a' } }],
            });
            await sealEmitter.flushEdits();
            snapshotRef = (await sealTools.log())[0].oid;

            const sidecar = readSidecar(rel);
            await docs.updateFile(rel, '# v2', {
                ...sidecar,
                flashcards: [...sidecar.flashcards, { globalHash: v2Hash, vanillaData: { frontText: 'v2', backText: 'b' } }],
            });
            await sealEmitter.flushEdits();
            await sealTools.rollback(snapshotRef);
        });

        it('inspect() is blind but checkIndex sees the divergence', async () => {
            const drift = await sealTools.inspect();
            assert.deepEqual(drift, { added: [], modified: [], deleted: [] }, 'HEAD == workdir after rollback');

            const report = await doctor.checkIndex();
            const entry = report.documents.modified.find(m => m.relPath.includes('Rollback.md'));
            assert.ok(entry, 'checkIndex detects the DB is ahead of the rolled-back sidecar');
            assert.ok(entry.reasons.includes('cardSetChanged'));
        });

        it('syncIndex fixes the index without creating any commit', async () => {
            const logBefore = (await sealTools.log()).length;
            const result = await doctor.syncIndex();

            const doc = query.getDocumentByPath(rel);
            const cards = query.getFlashcardsByDocument(doc.id);
            assert.equal(cards.length, 1, 'v2 card removed from index');
            assert.equal(cards[0].global_hash, v1Hash);

            assert.equal(result.sealedOid, null, 'no drift, so nothing sealed');
            assert.equal((await sealTools.log()).length, logBefore, 'no new commit');
        });
    });

    // --- 7. MEDIA, BOTH DIRECTIONS ---
    describe('media reconciliation', () => {
        const mediaDirRel = path.join(TEST_ROOT, 'media');
        const fileRel = path.join(mediaDirRel, 'loose.png');

        before(() => {
            fs.mkdirSync(abs(mediaDirRel), { recursive: true });
            fs.writeFileSync(abs(fileRel), Buffer.from('fake-png-bytes'));
        });

        it('syncIndex registers an unregistered media file with its sha256', async () => {
            const report = await doctor.checkIndex();
            assert.ok(report.media.unregistered.some(p => p.includes('loose.png')));

            const result = await doctor.syncIndex();
            assert.ok(result.actions.mediaRegistered >= 1);

            const expected = crypto.createHash('sha256').update(Buffer.from('fake-png-bytes')).digest('hex');
            assert.ok(query.getMediaByHash(expected), 'row exists with correct hash');
        });

        it('syncIndex drops the row once the file disappears', async () => {
            fs.unlinkSync(abs(fileRel));
            const report = await doctor.checkIndex();
            assert.ok(report.media.missingOnDisk.some(p => p.includes('loose.png')));

            const result = await doctor.syncIndex();
            assert.ok(result.actions.mediaRowsRemoved >= 1);
            const expected = crypto.createHash('sha256').update(Buffer.from('fake-png-bytes')).digest('hex');
            assert.equal(query.getMediaByHash(expected), undefined);
        });
    });

    // --- 8. DECKS ---
    describe('deck reconciliation', () => {
        it('reimports a deck whose DB row vanished (file wins)', async () => {
            const hash = await decks.createDeck('LostRow', 'db row will vanish');
            query.deleteDeck(query.getDeckByHash(hash).id);
            assert.equal(query.getDeckByHash(hash), undefined);

            const report = await doctor.checkIndex();
            assert.ok(report.decks.fileWithoutDb.includes(hash));

            await doctor.syncIndex();
            assert.ok(query.getDeckByHash(hash), 'deck row restored from file');
            assert.equal(query.getDeckByHash(hash).name, 'LostRow');
        });

        it('self-heals a deck file that vanished (DB is next-best truth)', async () => {
            const hash = await decks.createDeck('LostFile', 'json will vanish');
            const filePath = path.join(workspace, '_decks', `${hash}.json`);
            fs.unlinkSync(filePath);

            const report = await doctor.checkIndex();
            assert.ok(report.decks.dbWithoutFile.includes(hash));

            await doctor.syncIndex();
            assert.ok(fs.existsSync(filePath), 'deck file rebuilt');
            assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf-8')).name, 'LostFile');
        });

        it('resolves entry mismatches in the file\'s favor', async () => {
            const cardHash = await decks.createStandaloneCard({ frontText: 'standalone-q', backText: 'standalone-a' });
            const deckHash = await decks.createDeck('Mismatch', '');
            await decks.addEntry(deckHash, { cardHash });

            // Out-of-band: remove the entry from the file only.
            const filePath = path.join(workspace, '_decks', `${deckHash}.json`);
            const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            data.entries = [];
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

            const report = await doctor.checkIndex();
            const mm = report.decks.entryMismatches.find(m => m.deckHash === deckHash);
            assert.ok(mm && mm.missingInFile.includes(cardHash));

            await doctor.syncIndex();
            const deck = query.getDeckByHash(deckHash);
            assert.equal(query.getDeckEntries(deck.id).length, 0, 'DB entry removed to match file');
        });
    });

    // --- 9. HASH CONFLICT ---
    describe('globalHash conflicts', () => {
        const sharedHash = crypto.randomUUID();
        const relA = path.join(TEST_ROOT, 'ConflictA.md');
        const relB = path.join(TEST_ROOT, 'ConflictB.md');

        before(() => {
            for (const rel of [relA, relB]) {
                fs.writeFileSync(abs(rel), '# conflict');
                writeSidecar(rel, { globalHash: sharedHash });
            }
        });

        after(async () => {
            for (const rel of [relA, relB]) {
                fs.unlinkSync(abs(rel));
                fs.unlinkSync(abs(rel + '.flashback'));
            }
            await doctor.syncIndex();
        });

        it('reports the conflict, skips both files, and still completes', async () => {
            const result = await doctor.syncIndex();
            const conflict = result.skipped.hashConflicts.find(c => c.hash === sharedHash);
            assert.ok(conflict, 'conflict reported');
            assert.equal(conflict.paths.length, 2);
            assert.equal(query.getDocumentByPath(relA), undefined, 'conflicting file A not indexed');
            assert.equal(query.getDocumentByPath(relB), undefined, 'conflicting file B not indexed');
        });
    });

    // --- 10. CORRUPT SIDECAR ---
    describe('corrupt sidecars', () => {
        const rel = path.join(TEST_ROOT, 'Corrupt.md');

        before(() => {
            fs.writeFileSync(abs(rel), '# corrupt');
            fs.writeFileSync(abs(rel + '.flashback'), '{ not valid json');
        });

        after(async () => {
            fs.unlinkSync(abs(rel));
            fs.unlinkSync(abs(rel + '.flashback'));
            await doctor.syncIndex();
        });

        it('is reported and skipped without crashing', async () => {
            const report = await doctor.checkIndex();
            assert.ok(report.documents.corruptSidecars.some(p => p.includes('Corrupt.md')));

            const result = await doctor.syncIndex();
            assert.ok(result.skipped.corruptSidecars.some(p => p.includes('Corrupt.md')));
            assert.equal(query.getDocumentByPath(rel), undefined);
        });
    });

    // --- 11. IDEMPOTENCE ---
    describe('syncIndex idempotence', () => {
        it('a second run performs zero actions and seals nothing', async () => {
            await doctor.syncIndex();
            const second = await doctor.syncIndex();
            const a = second.actions;
            assert.equal(a.foldersIndexed + a.documentsIndexed + a.documentsReindexed
                + a.foldersRemoved + a.documentsRemoved
                + a.mediaRowsRemoved + a.mediaRegistered, 0, JSON.stringify(a));
            assert.equal(a.decks.decksImported + a.decks.deckFilesRebuilt
                + a.decks.entriesAdded + a.decks.entriesRemoved, 0);
            assert.equal(second.sealedOid, null);
        });
    });

    // --- 12. FULL REBUILD ---
    describe('rebuildIndex', () => {
        const folderRel = path.join(TEST_ROOT, 'RebuildZone');
        const docARel = path.join(folderRel, 'TargetDoc.md');
        const docBRel = path.join(folderRel, 'LinkSource.md');
        const cardHash = crypto.randomUUID();
        let targetHash;
        let standaloneHash;
        let deckHash;
        let snapshot;

        before(async () => {
            await sealEmitter.flushEdits();

            // Folder with a tag (inheritance), a doc with a leveled+eased card,
            // a second doc linking to the first, a highlight, a custom category,
            // a user deck, and a standalone card.
            query.insertCategory({ name: 'doctor-test-cat', priority: 2, description: 'test' });

            await docs.createFolder('RebuildZone', TEST_ROOT);
            await docs.updateMetadata(folderRel, { ...readFolderSidecar(folderRel), tags: ['inherited-tag'] }, true);

            await docs.importFile('TargetDoc.md', folderRel, '# target', {
                tags: ['direct-tag'],
                flashcards: [{
                    globalHash: cardHash, level: 6, easeFactor: 2.7, category: 'doctor-test-cat',
                    vanillaData: { frontText: 'rebuild-q', backText: 'rebuild-a' },
                }],
                highlights: [{ id: crypto.randomUUID(), type: 'text_offset', start: 0, end: 5, color: 'amber', note: '' }],
            });
            // createFile mints the sidecar's globalHash independently of any caller
            // input, and rebuildIndex re-indexes documents from their sidecars — so
            // the link must reference TargetDoc's sidecar hash to resolve post-rebuild.
            targetHash = readSidecar(docARel).globalHash;
            await docs.importFile('LinkSource.md', folderRel, `See [target](flashback://${targetHash})`, {});

            standaloneHash = await decks.createStandaloneCard({ frontText: 'standalone-rebuild', backText: 'sa', cardType: 'basic' });
            deckHash = await decks.createDeck('RebuildDeck', 'survives rebuilds');
            await decks.addEntry(deckHash, { cardHash });

            fs.mkdirSync(abs(folderRel, 'media'), { recursive: true });
            fs.writeFileSync(abs(folderRel, 'media', 'art.png'), Buffer.from('art-bytes'));
            await sealEmitter.flushEdits();
            await doctor.syncIndex(); // register media, settle everything

            snapshot = {
                documents: query.getAllDocuments().length,
                flashcards: query.getFlashcardCount(),
                decks: query.getAllDecks().length,
            };

            // Simulate a recovered-from-corruption DB: category rows lost too.
            const cat = query.getCategoryByName('doctor-test-cat');
            query.wipeDerivedContent();
            query.deleteCategory(cat.id);
            assert.equal(query.getFlashcardCount(), 0, 'index is empty before rebuild');
        });

        function readFolderSidecar(relPath) {
            return JSON.parse(fs.readFileSync(abs(relPath, '.flashback'), 'utf-8'));
        }

        it('restores documents, folders, cards, levels, and counts', async () => {
            const { summary, warnings } = await doctor.rebuildIndex();
            assert.deepEqual(warnings.filter(w => !w.includes('System deck')), [], `unexpected warnings: ${warnings}`);

            assert.equal(query.getAllDocuments().length, snapshot.documents, 'document count restored');
            assert.equal(query.getFlashcardCount(), snapshot.flashcards, 'flashcard count restored (incl. standalone)');
            assert.equal(query.getAllDecks().length, snapshot.decks, 'deck count restored');
            assert.ok(summary.documentsIndexed > 0);

            const card = db.prepare('SELECT level FROM Flashcards WHERE global_hash = ?').get(cardHash);
            assert.equal(card.level, 6, 'SRS level recovered from sidecar');
        });

        it('recreates the missing category and links the card to it', () => {
            const cat = query.getCategoryByName('doctor-test-cat');
            assert.ok(cat, 'category recreated');
            const row = db.prepare('SELECT category_id FROM Flashcards WHERE global_hash = ?').get(cardHash);
            assert.equal(row.category_id, cat.id);
        });

        it('recomputes tag inheritance', () => {
            const doc = query.getDocumentByPath(docARel);
            assert.ok(query.getDirectTagNames(doc.node_id).includes('direct-tag'));
            assert.ok(query.getInheritedTagNames(doc.node_id).includes('inherited-tag'));
        });

        it('restores highlights, links, media, and ease factors', () => {
            const doc = query.getDocumentByPath(docARel);
            assert.equal(query.getHighlightsByDocumentId(doc.id).length, 1, 'highlight restored');

            const { edges } = query.getGraphData();
            const source = query.getDocumentByPath(docBRel);
            assert.ok(
                edges.some(e => e.relation === 'link' && e.fromId === source.node_id && e.toId === doc.node_id),
                'flashback:// link edge restored'
            );

            const mediaHash = crypto.createHash('sha256').update(Buffer.from('art-bytes')).digest('hex');
            assert.ok(query.getMediaByHash(mediaHash), 'media re-registered');

            const eases = query.getLatestEaseFactors();
            assert.equal(eases.get(cardHash), 2.7, 'ease factor recovered via synthetic review log');
        });

        it('restores the standalone card from its inline snapshot and keeps one system deck', () => {
            const restored = query.getFlashcardByHash(standaloneHash);
            assert.ok(restored, 'standalone card restored');
            const content = db.prepare(`
                SELECT c.frontText FROM Flashcards f JOIN FlashcardContent c ON c.id = f.content_id
                WHERE f.global_hash = ?
            `).get(standaloneHash);
            assert.equal(content.frontText, 'standalone-rebuild');

            const systemCount = db.prepare('SELECT COUNT(*) as c FROM Decks WHERE is_system = 1').get().c;
            assert.equal(systemCount, 1, 'exactly one system deck');

            const deck = query.getDeckByHash(deckHash);
            assert.equal(query.getDeckEntries(deck.id).length, 1, 'user deck entries restored');
        });

        it('leaves a clean bill of health afterward', async () => {
            const report = await doctor.checkIndex();
            assert.deepEqual(report.documents.missingInDb, []);
            assert.deepEqual(report.documents.orphanedInDb, []);
            assert.deepEqual(report.documents.modified, []);
            assert.deepEqual(report.media.unregistered, []);
            assert.deepEqual(report.decks.fileWithoutDb, []);
            assert.deepEqual(report.decks.dbWithoutFile, []);
        });
    });
});
