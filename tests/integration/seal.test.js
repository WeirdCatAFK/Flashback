import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import * as Documents from '../../src/api/access/modules/documents.js';
import * as Decks from '../../src/api/access/modules/decks.js';
import db from '../../src/api/access/primitives/database.js';
import validate from '../../src/api/config/validate.js';
import { sealTools, sealEmitter } from '../../src/api/seal/seal.js';
import { getWorkspacePath } from '../../src/api/access/primitives/config.js';
import { testDataDir } from '../support/testData.js';

process.env.USER_DATA_PATH = testDataDir('seal');
console.log('USER_DATA_PATH:', process.env.USER_DATA_PATH);

if (!await validate()) {
    console.error('Validation failed.');
    process.exit(1);
}

const TEST_ROOT = 'SealTests';
const workspace = getWorkspacePath();

const LOG_DEPTH = 500;

describe('Seal Integration Tests', () => {

    before(async () => {
        try { if (await Documents.exists(TEST_ROOT, true, true)) await Documents.remove(TEST_ROOT, true); } catch {}
        await sealTools.init();
        await Documents.createFolder(TEST_ROOT);
    });

    after(async () => {
        db.close();
        await new Promise(resolve => setTimeout(resolve, 50));
        try {
            fs.rmSync(testDataDir('seal'), { recursive: true, force: true });
        } catch (e) {
            console.warn('Teardown warning (safe to ignore): Failed to delete data directory:', e.message);
        }
    });

    describe('Event Emitter Commits', () => {
        const fileName = 'Notes.md';
        const filePath = path.join(TEST_ROOT, fileName);
        const fcHash = crypto.randomUUID();

        it('createFile fires a create commit', async () => {
            const before = (await sealTools.log(LOG_DEPTH)).length;
            await Documents.createFile(fileName, TEST_ROOT);
            const commits = await sealTools.log(LOG_DEPTH);
            assert.equal(commits.length, before + 1, 'Should add one commit');
            assert.ok(commits[0].commit.message.startsWith('create:'), 'Commit message should start with create:');
            assert.ok(commits[0].commit.message.includes('.flashback'), 'Commit message should reference the sidecar');
        });

        it('updateFile fires an edit commit', async () => {
            const before = (await sealTools.log(LOG_DEPTH)).length;
            await Documents.updateFile(filePath, '# Notes', {
                globalHash: crypto.randomUUID(),
                flashcards: [{ globalHash: fcHash, vanillaData: { frontText: 'Q', backText: 'A' } }]
            });
            await sealEmitter.flushEdits();
            const commits = await sealTools.log(LOG_DEPTH);
            assert.equal(commits.length, before + 1, 'Should add one commit');
            assert.ok(commits[0].commit.message.startsWith('edit:'), 'Commit message should start with edit:');
        });

        it('rename fires a move commit with old and new paths', async () => {
            const before = (await sealTools.log(LOG_DEPTH)).length;
            await Documents.rename(filePath, 'Notes_v2.md', false);
            const commits = await sealTools.log(LOG_DEPTH);
            assert.equal(commits.length, before + 1, 'Should add one commit');
            assert.ok(commits[0].commit.message.startsWith('move:'), 'Commit message should start with move:');
            assert.ok(commits[0].commit.message.includes('->'), 'Move commit should include arrow separator');
            await Documents.rename(path.join(TEST_ROOT, 'Notes_v2.md'), fileName, false);
        });

        it('submitReview fires no commit at all — a schedule is not in the workspace', async () => {
            const before = (await sealTools.log(LOG_DEPTH)).length;
            await Documents.submitReview(filePath, fcHash, 5, 2.5, 3);
            await sealEmitter.flushEdits();
            assert.equal((await sealTools.log(LOG_DEPTH)).length, before,
                'grading writes no file, so there is nothing to seal');
        });

        it('delete fires a delete commit', async () => {
            const tempFile = 'Temp.md';
            await Documents.createFile(tempFile, TEST_ROOT);
            const before = (await sealTools.log(LOG_DEPTH)).length;
            await Documents.remove(path.join(TEST_ROOT, tempFile), false);
            const commits = await sealTools.log(LOG_DEPTH);
            assert.equal(commits.length, before + 1, 'Should add one commit');
            assert.ok(commits[0].commit.message.startsWith('delete:'), 'Commit message should start with delete:');
        });
    });

    describe('Log', () => {
        it('returns commits in reverse chronological order', async () => {
            const commits = await sealTools.log(LOG_DEPTH);
            assert.ok(commits.length >= 2, 'Should have at least two commits from prior tests');
            for (let i = 0; i < commits.length - 1; i++) {
                assert.ok(
                    commits[i].commit.author.timestamp >= commits[i + 1].commit.author.timestamp,
                    'Each commit should be newer than or equal to the next'
                );
            }
        });

        it('respects the limit parameter', async () => {
            const commits = await sealTools.log(2);
            assert.ok(commits.length <= 2, 'Should return at most 2 commits');
        });

        it('pages backwards with a cursor without repeating the boundary commit', async () => {
            const straight = await sealTools.log(6);
            if (straight.length < 4) return;

            const firstPage = await sealTools.log(2);
            const secondPage = await sealTools.log(2, firstPage[firstPage.length - 1].oid);

            assert.equal(secondPage.length, 2, 'Second page should be full');
            const seen = new Set(firstPage.map(c => c.oid));
            for (const c of secondPage) {
                assert.ok(!seen.has(c.oid), 'Cursor page must not repeat a commit already returned');
            }
            assert.deepEqual(
                [...firstPage, ...secondPage].map(c => c.oid),
                straight.slice(0, 4).map(c => c.oid),
                'Two cursor pages should equal the same slice of an unpaged log'
            );
        });

        it('returns an empty page once history runs out', async () => {
            const all = await sealTools.log(200);
            const oldest = all[all.length - 1];
            const page = await sealTools.log(5, oldest.oid);
            assert.equal(page.length, 0, 'There is nothing older than the root commit');
        });

        it('stats.content separates metadata-only commits from content edits', async () => {
            const name = 'Stats.md';
            const rel = path.join(TEST_ROOT, name);
            const cardHash = crypto.randomUUID();

            await Documents.createFile(name, TEST_ROOT);
            await Documents.updateFile(rel, '# Body', {
                globalHash: crypto.randomUUID(),
                flashcards: [{ globalHash: cardHash, vanillaData: { frontText: 'Q', backText: 'A' } }],
            });
            await sealEmitter.flushEdits();

            const contentCommit = (await sealTools.log(1))[0];
            assert.ok(contentCommit.stats.content > 0, 'Writing the document body should count as content');

            await Documents.updateMetadata(rel, {
                globalHash: crypto.randomUUID(),
                tags: ['metadata-only'],
                flashcards: [{ globalHash: cardHash, vanillaData: { frontText: 'Q', backText: 'A' } }],
            });
            await sealEmitter.flushEdits();

            const metaCommit = (await sealTools.log(1))[0];
            const touched = metaCommit.stats.added + metaCommit.stats.modified + metaCommit.stats.deleted;
            assert.ok(touched > 0, 'The commit should still report changed paths');
            assert.equal(metaCommit.stats.content, 0, 'A review touches only the sidecar');
        });

        it('create and edit commits reference a .flashback sidecar path', async () => {
            const commits = await sealTools.log(LOG_DEPTH);
            const nonMoveCommits = commits.filter(c => !c.commit.message.startsWith('move:'));
            for (const c of nonMoveCommits) {
                assert.ok(
                    c.commit.message.includes('.flashback'),
                    `Commit "${c.commit.message.trim()}" should reference a .flashback path`
                );
            }
        });
    });

    describe('Rollback', () => {
        const rollbackFile = 'RollbackTest.md';
        const rollbackPath = path.join(TEST_ROOT, rollbackFile);
        const sidecarAbsPath = path.join(workspace, rollbackPath + '.flashback');
        const fcHash = crypto.randomUUID();
        let snapshotRef;

        before(async () => {
            await Documents.createFile(rollbackFile, TEST_ROOT);
            await Documents.updateFile(rollbackPath, '# v1', {
                globalHash: crypto.randomUUID(),
                flashcards: [{ globalHash: fcHash, vanillaData: { frontText: 'v1 question', backText: 'v1 answer' } }]
            });
            await sealEmitter.flushEdits();
            snapshotRef = (await sealTools.log(LOG_DEPTH))[0].oid;

            await Documents.updateFile(rollbackPath, '# v2', {
                globalHash: crypto.randomUUID(),
                flashcards: [{ globalHash: fcHash, vanillaData: { frontText: 'v2 question', backText: 'v2 answer' } }]
            });
            await Documents.submitReview(rollbackPath, fcHash, 5, 2.5, 7);
            await sealEmitter.flushEdits();
        });

        it('restores the canonical layer (sidecar) to the snapshot state', async () => {
            await sealTools.rollback(snapshotRef);

            const sidecar = JSON.parse(fs.readFileSync(sidecarAbsPath, 'utf-8'));
            assert.equal(
                sidecar.flashcards[0].vanillaData.frontText,
                'v1 question',
                'Sidecar should be at v1 state after rollback'
            );
        });

        it('leaves the schedule alone, because a rollback cannot reach it', async () => {
            const fc = await db.prepare(`
                SELECT p.level FROM CardProgress p
                JOIN Flashcards f ON f.global_hash = p.card_hash
                WHERE f.global_hash = ? AND p.account_id = 'owner'
            `).get(fcHash);
            assert.equal(fc.level, 7, 'the graded level survives the rollback untouched');

            const sidecar = JSON.parse(fs.readFileSync(sidecarAbsPath, 'utf-8'));
            const sidecarLevel = sidecar.flashcards[0]?.level ?? 0;
            assert.notEqual(fc.level, sidecarLevel,
                'and the rolled-back sidecar disagrees with it, which is now permanent rather than pending a reconcile');
        });
    });

    describe('Inspect', () => {
        it('returns empty result when workspace matches HEAD', async () => {
            const result = await sealTools.inspect();
            assert.deepEqual(result, { added: [], modified: [], deleted: [] }, 'Clean workspace should produce empty inspect result');
        });

        it('detects an out-of-band added sidecar', async () => {
            const sidecarAbs = path.join(workspace, TEST_ROOT, 'oob_added.md.flashback');
            fs.writeFileSync(sidecarAbs, JSON.stringify({ globalHash: crypto.randomUUID() }));

            const result = await sealTools.inspect();
            assert.ok(result.added.some(p => p.endsWith('oob_added.md.flashback')), 'Should report the untracked sidecar as added');

            fs.unlinkSync(sidecarAbs);
        });

        it('detects an out-of-band modified sidecar', async () => {
            const sidecarAbs = path.join(workspace, TEST_ROOT, 'Notes.md.flashback');
            const original = fs.readFileSync(sidecarAbs, 'utf-8');
            const patched = { ...JSON.parse(original), _oob: true };
            fs.writeFileSync(sidecarAbs, JSON.stringify(patched));

            const result = await sealTools.inspect();
            assert.ok(result.modified.some(p => p.endsWith('Notes.md.flashback')), 'Should report the edited sidecar as modified');

            fs.writeFileSync(sidecarAbs, original);
        });

        it('detects an out-of-band deleted sidecar', async () => {
            const deletionFile = 'DeletionDetect.md';
            await Documents.createFile(deletionFile, TEST_ROOT);
            const sidecarAbs = path.join(workspace, TEST_ROOT, deletionFile + '.flashback');

            fs.unlinkSync(sidecarAbs);

            const result = await sealTools.inspect();
            assert.ok(result.deleted.some(p => p.endsWith(deletionFile + '.flashback')), 'Should report the missing sidecar as deleted');
        });
    });

    describe('Deck writes are versioned', () => {

        it('createDeck fires a create commit referencing the _decks path', async () => {
            const before = (await sealTools.log(LOG_DEPTH)).length;
            const hash = await Decks.createDeck('SealDeck', 'versioned deck');
            const commits = await sealTools.log(LOG_DEPTH);
            assert.equal(commits.length, before + 1, 'Should add one commit');
            assert.ok(commits[0].commit.message.startsWith('create:'), 'Commit message should start with create:');
            assert.ok(commits[0].commit.message.includes(`_decks/${hash}.json`), 'Commit should reference the deck JSON path');
        });

        it('createStandaloneCard fires an edit commit on the system deck file', async () => {
            const before = (await sealTools.log(LOG_DEPTH)).length;
            await Decks.createStandaloneCard({ frontText: 'seal-q', backText: 'seal-a' });
            await sealEmitter.flushEdits();
            const commits = await sealTools.log(LOG_DEPTH);
            assert.equal(commits.length, before + 1, 'Should add one commit after flush');
            assert.ok(commits[0].commit.message.startsWith('edit:'), 'Commit message should start with edit:');
            assert.ok(commits[0].commit.message.includes('_decks/'), 'Commit should reference a deck JSON path');
        });

        it('authoring five cards produces five edit commits, one per card', async () => {
            const before = (await sealTools.log(LOG_DEPTH)).length;
            for (let i = 0; i < 5; i++) {
                await Decks.createStandaloneCard({ frontText: `batch-q${i}`, backText: `batch-a${i}` });
            }
            await sealEmitter.flushEdits();
            const commits = await sealTools.log(LOG_DEPTH);
            assert.equal(commits.length, before + 5, 'Each authored card should be its own commit');
            assert.ok(commits[0].commit.message.startsWith('edit:'), 'Commit message should start with edit:');
        });

        it('deleteDeck fires a delete commit', async () => {
            const hash = await Decks.createDeck('DeleteMe', '');
            const before = (await sealTools.log(LOG_DEPTH)).length;
            await Decks.deleteDeck(hash);
            const commits = await sealTools.log(LOG_DEPTH);
            assert.equal(commits.length, before + 1, 'Should add one commit');
            assert.ok(commits[0].commit.message.startsWith('delete:'), 'Commit message should start with delete:');
            assert.ok(commits[0].commit.message.includes(`_decks/${hash}.json`), 'Commit should reference the deck JSON path');
        });
    });
});
