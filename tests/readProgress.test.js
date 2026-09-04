/**
 * Read progress: where each person has read to, and how far through a folder they are.
 *
 * The properties pinned here are the ones that make the feature real rather than nominal:
 *
 *   1. **Privacy.** Two people reading one document hold independent positions, and the
 *      Author's resolve to the OWNER_SCOPE sentinel rather than to their account id.
 *   2. **Reading is not editing.** Recording a position writes no sidecar and produces no Seal
 *      commit — for the owner too, which is where this departs from per-user SRS.
 *   3. **The furthest mark.** `auto` advances it and never regresses it; `manual` may move it
 *      backwards, because an explicit correction has to be obeyable.
 *   4. **Identity, not location.** Positions are keyed by globalHash, so they survive a rename
 *      and do not follow a copy (which regenerates identities).
 *   5. **Durability.** A Doctor rebuild wipes the derived database; read progress is not
 *      derived and must come through untouched.
 *   6. **Rollups.** Unread documents stay in the denominator, an unknown denominator never
 *      counts as finished, and two people get different rollups over one folder.
 *
 * Scope is normally resolved from the request context, so these tests enter one explicitly
 * with `runWithAccount` — the same thing `auth/authenticate.js` does per request.
 *
 * Run: node --test tests/readProgress.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import process from 'process';

const ROOT = path.join(process.cwd(), 'data_test_readprogress');
process.env.USER_DATA_PATH = ROOT;

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

// Imports are hoisted above the assignment above unless they are dynamic, and every one of
// these resolves its paths from USER_DATA_PATH at import time.
const { default: validate } = await import('../src/api/config/validate.js');
if (!await validate()) {
    console.error('Validation failed.');
    process.exit(1);
}

const { default: Documents } = await import('../src/api/access/orchestration/documents.js');
const { default: Doctor } = await import('../src/api/access/orchestration/doctor.js');
const { default: readProgress, FINISHED_PCT } = await import('../src/api/access/orchestration/readProgress.js');
const { default: query } = await import('../src/api/access/resources/query.js');
const { default: db } = await import('../src/api/access/primitives/database.js');
const accounts = await import('../src/api/access/primitives/accounts.js');
const { getVaultId, ensureManifest } = await import('../src/api/access/primitives/vault.js');
const { sealTools } = await import('../src/api/seal/seal.js');
const { getWorkspacePath } = await import('../src/api/access/primitives/config.js');
const { runWithAccount, OWNER_SCOPE } = await import('../src/api/requestContext.js');
const { ROLES } = await import('../src/shared/roles.js');

const docs = new Documents();
const doctor = new Doctor();
const FOLDER = 'ReadProgressTest';
const bookRel = path.join(FOLDER, 'book.md');

const asAccount = (account, fn) => runWithAccount(account, fn);

describe('Read progress', () => {
    let author, rita;

    before(async () => {
        ensureManifest();
        await sealTools.init();

        author = await accounts.ensureLocalAuthor();
        rita = await accounts.createAccount({
            name: 'Rita', email: `rita+${Date.now()}@example.com`, role: ROLES.READER,
        });

        const abs = path.join(getWorkspacePath(), FOLDER);
        if (fs.existsSync(abs)) fs.rmSync(abs, { recursive: true, force: true });
        await docs.createFolder(FOLDER);

        // Four documents, so a rollup has something to average over.
        for (const name of ['book.md', 'second.md', 'third.md', 'fourth.md']) {
            await docs.importFile(name, FOLDER, Buffer.from(`# ${name}`), {
                globalHash: crypto.randomUUID(),
            });
        }
    });

    after(async () => {
        db.close();
        accounts.closeAccounts();
        await new Promise(r => setTimeout(r, 50));
        try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* windows file locks */ }
    });

    // --- 1. Privacy --------------------------------------------------------------

    describe('two people, one document', () => {
        it('reads as null before anyone opens it', async () => {
            assert.equal(await readProgress.get(bookRel), null,
                'a missing row means never started, not "at zero"');
        });

        it('keeps each person on their own position', async () => {
            await readProgress.set(bookRel, { unit: 'page', position: { page: 40 }, total: 100 });
            await asAccount(rita, () => readProgress.set(
                bookRel, { unit: 'page', position: { page: 7 }, total: 100 },
            ));

            assert.equal((await readProgress.get(bookRel)).position.page, 40, "the author's page");
            const hers = await asAccount(rita, () => readProgress.get(bookRel));
            assert.equal(hers.position.page, 7, 'hers, in the same document');
        });

        it('files the author under the owner sentinel, not their account id', async () => {
            const owner = await accounts.getReadProgress(
                getVaultId(), OWNER_SCOPE, (await query.getDocumentByPath(bookRel)).global_hash,
            );
            assert.ok(owner, 'the author resolves to OWNER_SCOPE');
            assert.equal(JSON.parse(owner.pos).page, 40);

            const byId = await accounts.getReadProgress(
                getVaultId(), author.id, (await query.getDocumentByPath(bookRel)).global_hash,
            );
            assert.equal(byId, undefined, 'and never to their uuid, which a copied vault would orphan');
        });
    });

    // --- 2. Reading is not editing -----------------------------------------------

    describe('what a position costs the vault', () => {
        it('writes no sidecar and seals nothing — for the owner too', async () => {
            const sidecarBefore = JSON.stringify(docs.files.getMetadata(bookRel));
            const logBefore = await sealTools.log();

            await readProgress.set(bookRel, { unit: 'page', position: { page: 55 }, total: 100 });
            await asAccount(rita, () => readProgress.set(
                bookRel, { unit: 'page', position: { page: 9 }, total: 100 },
            ));

            assert.equal(JSON.stringify(docs.files.getMetadata(bookRel)), sidecarBefore,
                'the canonical file is untouched');
            assert.equal((await sealTools.log()).length, logBefore.length,
                'reading is not editing — no commit, whoever is reading');
        });
    });

    // --- 3. The furthest mark ------------------------------------------------------

    describe('the furthest mark', () => {
        it('advances when you move forward', async () => {
            const p = await readProgress.set(bookRel, { unit: 'page', position: { page: 80 }, total: 100 });
            assert.equal(p.furthest.page, 80);
            assert.equal(p.position.page, 80);
        });

        it('does not regress when you scroll back to check something', async () => {
            const p = await readProgress.set(bookRel, { unit: 'page', position: { page: 12 }, total: 100 });
            assert.equal(p.position.page, 12, 'where you are now');
            assert.equal(p.furthest.page, 80, 'but you have still read to 80');
        });

        it('lets a manual correction move it backwards', async () => {
            const p = await readProgress.set(
                bookRel, { unit: 'page', position: { page: 20 }, total: 100, mode: 'manual' },
            );
            assert.equal(p.furthest.page, 20, '"I actually only got to page 20" has to be obeyable');
        });

        it('derives a percent when the caller sends none', async () => {
            const p = await readProgress.set(
                bookRel, { unit: 'page', position: { page: 50 }, total: 100, mode: 'manual' },
            );
            assert.equal(p.percent, 0.5);
        });

        it('marks finished at the threshold, not only at exactly the end', async () => {
            const p = await readProgress.set(
                bookRel, { unit: 'page', position: { page: 97 }, total: 100, mode: 'manual' },
            );
            assert.ok(p.furthestPercent >= FINISHED_PCT);
            assert.equal(p.finished, true, 'back matter should not keep a read book at 99%');
        });

        it('refuses a unit it cannot address', async () => {
            await assert.rejects(
                () => readProgress.set(bookRel, { unit: 'furlong', position: { page: 1 } }),
                (err) => err.status === 400,
            );
        });
    });

    // --- 4. Identity, not location -------------------------------------------------

    describe('identity', () => {
        it('survives a rename, because it is keyed by globalHash', async () => {
            const renamed = path.join(FOLDER, 'renamed.md');
            await docs.rename(bookRel, 'renamed.md');

            const p = await readProgress.get(renamed);
            assert.ok(p, 'the position followed the document');
            assert.equal(p.furthest.page, 97);

            await docs.rename(renamed, 'book.md');
        });

        it('does not follow a copy, which starts unread', async () => {
            const copyRel = path.join(FOLDER, 'book-copy.md');
            await docs.copy(bookRel, copyRel, false);
            assert.equal(await readProgress.get(copyRel), null,
                'a copy regenerates identities, so it is a different document');
            await docs.delete(copyRel, false);
        });
    });

    // --- 5. Durability -------------------------------------------------------------

    describe('a Doctor rebuild', () => {
        it('leaves read progress intact, because none of it is derived', async () => {
            const before = await readProgress.get(bookRel);
            await doctor.rebuildIndex();

            const after = await readProgress.get(bookRel);
            assert.deepEqual(after.furthest, before.furthest,
                'nothing to restore, because nothing was projected');
            assert.equal(after.percent, before.percent);
        });
    });

    // --- 6. Rollups ----------------------------------------------------------------

    describe('folder rollup', () => {
        it('keeps unread documents in the denominator', async () => {
            const r = await readProgress.rollup(FOLDER);
            assert.equal(r.total, 4, 'every document in the subtree');
            assert.equal(r.finished, 1, 'book.md, at 97%');
            assert.equal(r.unread, 3, 'the three nobody has opened');
            assert.ok(r.percent > 0 && r.percent < 1,
                'unread counts as zero rather than dropping out of the average');
        });

        it('never counts a document with no denominator as finished', async () => {
            const rel = path.join(FOLDER, 'second.md');
            await readProgress.set(rel, { unit: 'chars', position: { offset: 400 } });

            const p = await readProgress.get(rel);
            assert.equal(p.percent, null, 'no total, so no percent');

            const r = await readProgress.rollup(FOLDER);
            assert.equal(r.finished, 1, 'still just book.md');
            assert.equal(r.inProgress, 1, 'second.md counts as started');
            assert.equal(r.total, 4, 'and stays in the total');
        });

        it('gives two people different rollups over one folder', async () => {
            const mine = await readProgress.rollup(FOLDER);
            const hers = await asAccount(rita, () => readProgress.rollup(FOLDER));
            assert.equal(hers.finished, 0, 'she has finished nothing');
            assert.notEqual(hers.percent, mine.percent);
            assert.equal(hers.total, mine.total, 'over the same set of documents');
        });

        it('labels a folder that is a subscription target', async () => {
            await query.upsertSubscription({
                magazineId: 'nature', issueId: '2026-09', version: 1, targetPath: FOLDER,
            });
            const r = await readProgress.folderRollup(FOLDER);
            assert.equal(r.subscription?.magazineId, 'nature',
                '"12 of 47 issues" rather than "12 of 47 documents"');

            const plain = await readProgress.folderRollup('');
            assert.equal(plain.subscription, undefined, 'an ordinary folder rolls up unlabelled');
        });
    });

    // --- 6b. Coverage ---------------------------------------------------------------

    describe('read but not carded', () => {
        it('counts everything read as a gap when there are no cards at all', async () => {
            const cov = await readProgress.coverage(bookRel);
            assert.equal(cov.readTo, 97);
            assert.equal(cov.cards, 0);
            assert.deepEqual(cov.gap, { from: 0, to: 97 },
                '"nothing carded yet" is not the same answer as "nothing left to card"');
            assert.equal(cov.gapKnown, true);
        });

        it('measures the gap from the deepest carded position', async () => {
            const rel = path.join(FOLDER, 'carded.md');
            await docs.importFile('carded.md', FOLDER, Buffer.from('# Carded'), {
                globalHash: crypto.randomUUID(),
                flashcards: [
                    {
                        globalHash: crypto.randomUUID(),
                        vanillaData: {
                            frontText: 'Q', backText: 'A',
                            location: { type: 'pdf_location', data: { page: 44 } },
                        },
                    },
                ],
            });
            await readProgress.set(rel, { unit: 'page', position: { page: 120 }, total: 200 });

            const cov = await readProgress.coverage(rel);
            assert.equal(cov.readTo, 120);
            assert.equal(cov.cardedTo, 44);
            assert.deepEqual(cov.gap, { from: 44, to: 120 }, 'read to 120, last card from 44');
            assert.equal(cov.gapKnown, true);
        });

        it('says it cannot tell rather than reporting no gap, when cards have no orderable anchor', async () => {
            const rel = path.join(FOLDER, 'unanchored.md');
            await docs.importFile('unanchored.md', FOLDER, Buffer.from('# Unanchored'), {
                globalHash: crypto.randomUUID(),
                flashcards: [
                    { globalHash: crypto.randomUUID(), vanillaData: { frontText: 'Q', backText: 'A' } },
                ],
            });
            await readProgress.set(rel, { unit: 'page', position: { page: 30 }, total: 60 });

            const cov = await readProgress.coverage(rel);
            assert.equal(cov.cardedTo, null);
            assert.equal(cov.gap, null);
            assert.equal(cov.gapKnown, false, 'unknown must not read as "fully carded"');
        });
    });

    // --- 7. Listing ----------------------------------------------------------------

    describe('what am I in the middle of', () => {
        it('lists started documents and excludes finished ones', async () => {
            const list = await readProgress.listInProgress();
            const paths = list.map(r => r.path);
            assert.ok(paths.includes(path.join(FOLDER, 'second.md')), 'started');
            assert.ok(!paths.includes(bookRel), 'book.md is finished, so not "in progress"');
        });

        it('clears a position on request', async () => {
            const rel = path.join(FOLDER, 'second.md');
            await readProgress.clear(rel);
            assert.equal(await readProgress.get(rel), null);
        });
    });
});
