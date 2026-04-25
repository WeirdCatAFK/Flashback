import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import Documents from '../src/api/access/documents.js';
import db from '../src/api/access/database.js';
import validate from '../src/api/config/validate.js';
import { sealTools } from '../src/api/seal/seal.js';
import { getWorkspacePath } from '../src/api/access/config.js';

process.env.USER_DATA_PATH = path.join(process.cwd(), 'data');
console.log('USER_DATA_PATH:', process.env.USER_DATA_PATH);

if (!validate()) {
    console.error('Validation failed.');
    process.exit(1);
}

const docs = new Documents();
const TEST_ROOT = 'SealTests';
const workspace = getWorkspacePath();

describe('Seal Integration Tests', () => {

    before(async () => {
        try { if (docs.exists(TEST_ROOT, true, true)) await docs.delete(TEST_ROOT, true); } catch (e) {}
        await sealTools.init();
        await docs.createFolder(TEST_ROOT);
    });

    after(() => {
        db.close();
        fs.rmSync(path.join(process.cwd(), 'data'), { recursive: true, force: true });
    });

    // --- 1. EVENT EMITTER COMMITS ---
    describe('Event Emitter Commits', () => {
        const fileName = 'Notes.md';
        const filePath = path.join(TEST_ROOT, fileName);
        const fcHash = crypto.randomUUID();

        it('createFile fires a create commit', async () => {
            const before = (await sealTools.log()).length;
            await docs.createFile(fileName, TEST_ROOT);
            const commits = await sealTools.log();
            assert.equal(commits.length, before + 1, 'Should add one commit');
            assert.ok(commits[0].commit.message.startsWith('create:'), 'Commit message should start with create:');
            assert.ok(commits[0].commit.message.includes('.flashback'), 'Commit message should reference the sidecar');
        });

        it('updateFile fires an edit commit', async () => {
            const before = (await sealTools.log()).length;
            await docs.updateFile(filePath, '# Notes', {
                globalHash: crypto.randomUUID(),
                flashcards: [{ globalHash: fcHash, vanillaData: { frontText: 'Q', backText: 'A' } }]
            });
            const commits = await sealTools.log();
            assert.equal(commits.length, before + 1, 'Should add one commit');
            assert.ok(commits[0].commit.message.startsWith('edit:'), 'Commit message should start with edit:');
        });

        it('rename fires a move commit with old and new paths', async () => {
            const before = (await sealTools.log()).length;
            await docs.rename(filePath, 'Notes_v2.md', false);
            const commits = await sealTools.log();
            assert.equal(commits.length, before + 1, 'Should add one commit');
            assert.ok(commits[0].commit.message.startsWith('move:'), 'Commit message should start with move:');
            assert.ok(commits[0].commit.message.includes('->'), 'Move commit should include arrow separator');
            await docs.rename(path.join(TEST_ROOT, 'Notes_v2.md'), fileName, false);
        });

        it('submitReview fires an edit commit with the sidecar path', async () => {
            const before = (await sealTools.log()).length;
            await docs.submitReview(filePath, fcHash, 5, 2.5, 3);
            const commits = await sealTools.log();
            assert.equal(commits.length, before + 1, 'Should add one commit');
            assert.ok(commits[0].commit.message.startsWith('edit:'), 'Commit message should start with edit:');
        });

        it('delete fires a delete commit', async () => {
            const tempFile = 'Temp.md';
            await docs.createFile(tempFile, TEST_ROOT);
            const before = (await sealTools.log()).length;
            await docs.delete(path.join(TEST_ROOT, tempFile), false);
            const commits = await sealTools.log();
            assert.equal(commits.length, before + 1, 'Should add one commit');
            assert.ok(commits[0].commit.message.startsWith('delete:'), 'Commit message should start with delete:');
        });
    });

    // --- 2. LOG ---
    describe('Log', () => {
        it('returns commits in reverse chronological order', async () => {
            const commits = await sealTools.log();
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

        it('create and edit commits reference a .flashback sidecar path', async () => {
            const commits = await sealTools.log();
            const nonMoveCommits = commits.filter(c => !c.commit.message.startsWith('move:'));
            for (const c of nonMoveCommits) {
                assert.ok(
                    c.commit.message.includes('.flashback'),
                    `Commit "${c.commit.message.trim()}" should reference a .flashback path`
                );
            }
        });
    });

    // --- 3. ROLLBACK ---
    describe('Rollback', () => {
        const rollbackFile = 'RollbackTest.md';
        const rollbackPath = path.join(TEST_ROOT, rollbackFile);
        const sidecarAbsPath = path.join(workspace, rollbackPath + '.flashback');
        const fcHash = crypto.randomUUID();
        let snapshotRef;

        before(async () => {
            await docs.createFile(rollbackFile, TEST_ROOT);
            // v1 — this will be the snapshot target
            await docs.updateFile(rollbackPath, '# v1', {
                globalHash: crypto.randomUUID(),
                flashcards: [{ globalHash: fcHash, vanillaData: { frontText: 'v1 question', backText: 'v1 answer' } }]
            });
            snapshotRef = (await sealTools.log())[0].oid;

            // v2 + review to advance SRS
            await docs.updateFile(rollbackPath, '# v2', {
                globalHash: crypto.randomUUID(),
                flashcards: [{ globalHash: fcHash, vanillaData: { frontText: 'v2 question', backText: 'v2 answer' } }]
            });
            await docs.submitReview(rollbackPath, fcHash, 5, 2.5, 7);
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

        it('keepSrsProgress=true preserves DB SRS level, leaving it ahead of the rolled-back sidecar', async () => {
            // DB was snapshotted at level=7 before rollback and re-applied after checkout.
            // The rolled-back sidecar does not carry a level field (it was omitted on creation).
            // This proves the DB is intentionally diverged from the canonical layer until reconcile runs.
            const fc = db.prepare('SELECT level FROM Flashcards WHERE global_hash = ?').get(fcHash);
            assert.equal(fc.level, 7, 'DB SRS level should be the pre-rollback value, not reset');

            const sidecar = JSON.parse(fs.readFileSync(sidecarAbsPath, 'utf-8'));
            const sidecarLevel = sidecar.flashcards[0]?.level ?? 0;
            assert.notEqual(fc.level, sidecarLevel, 'DB level should differ from sidecar level, confirming SRS was preserved');
        });
    });

    // --- 4. INSPECT ---
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
            await docs.createFile(deletionFile, TEST_ROOT);
            const sidecarAbs = path.join(workspace, TEST_ROOT, deletionFile + '.flashback');

            fs.unlinkSync(sidecarAbs);

            const result = await sealTools.inspect();
            assert.ok(result.deleted.some(p => p.endsWith(deletionFile + '.flashback')), 'Should report the missing sidecar as deleted');
        });
    });
});
