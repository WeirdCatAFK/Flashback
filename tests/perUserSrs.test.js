/**
 * Per-user spaced repetition: two people studying one vault must not grade each other's cards.
 *
 * The properties being pinned here are the ones that make the split real rather than nominal:
 *
 *   1. **Divergence.** The same card carries a different schedule for each person, and one
 *      person's reviews never move another's due list.
 *   2. **Two canonical homes.** The owner's progress goes into the `.flashback` sidecar and is
 *      sealed; everyone else's goes into `accounts.db` and produces no commit at all. A reader
 *      studying is not a reader editing.
 *   3. **Durability.** A Vault Doctor rebuild wipes the derived database. The owner's schedule
 *      comes back from the sidecars, everyone else's from AccountProgress — and the Doctor
 *      never writes to the accounts store while doing it.
 *   4. **The owner sentinel survives a vault copy.** This is the reason 'owner' is a literal
 *      and not the Author's account id: point the same vault at a fresh install whose accounts
 *      store has never heard of it, and the owner's progress is still theirs.
 *
 * Scope is normally resolved from the request context, so these tests enter one explicitly with
 * `runWithAccount` — the same thing `auth/authenticate.js` does per request.
 *
 * Run: node --test tests/perUserSrs.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import process from 'process';

const ROOT = path.join(process.cwd(), 'data_test_peruser');
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
const { default: SRS } = await import('../src/api/access/orchestration/srs.js');
const { default: diary } = await import('../src/api/access/orchestration/diary.js');
const { default: cardHealth } = await import('../src/api/access/orchestration/cardHealth.js');
const { default: query } = await import('../src/api/access/resources/query.js');
const { default: db } = await import('../src/api/access/primitives/database.js');
const accounts = await import('../src/api/access/primitives/accounts.js');
const { getVaultId, ensureManifest } = await import('../src/api/access/primitives/vault.js');
const { sealTools } = await import('../src/api/seal/seal.js');
const { getWorkspacePath, getVaultPath } = await import('../src/api/access/primitives/config.js');
const { runWithAccount, OWNER_SCOPE } = await import('../src/api/requestContext.js');
const { ROLES } = await import('../src/shared/roles.js');
const { default: runMigrations } = await import('../src/api/config/MigrationRunner.js');

const docs = new Documents();
const doctor = new Doctor();
const WORKSPACE_ROOT = 'PerUser';
const docRel = path.join(WORKSPACE_ROOT, 'shared.md');

/** Runs `fn` as an ordinary (non-owner) account, the way the auth middleware would. */
const asAccount = (account, fn) => runWithAccount(account, fn);
/** Runs `fn` as the Author — resolves to OWNER_SCOPE because of the role, not the id. */
const asAuthor = (author, fn) => runWithAccount(author, fn);

const ownerLevel = async (hash) => (await query.getFlashcardSrsStateByHash(hash, OWNER_SCOPE))?.level ?? 0;
const sidecarCard = (hash) => docs.files.getMetadata(docRel).flashcards.find(c => c.globalHash === hash);

describe('Per-user SRS', () => {
    let author, rita, cardA, cardB;

    before(async () => {
        ensureManifest();
        await sealTools.init();

        author = await accounts.ensureLocalAuthor();
        rita = await accounts.createAccount({
            name: 'Rita', email: `rita+${Date.now()}@example.com`, role: ROLES.READER,
        });

        const abs = path.join(getWorkspacePath(), WORKSPACE_ROOT);
        if (fs.existsSync(abs)) fs.rmSync(abs, { recursive: true, force: true });
        await docs.createFolder(WORKSPACE_ROOT);

        cardA = crypto.randomUUID();
        cardB = crypto.randomUUID();
        await docs.importFile('shared.md', WORKSPACE_ROOT, Buffer.from('# Shared'), {
            globalHash: crypto.randomUUID(),
            flashcards: [
                { globalHash: cardA, level: 0, vanillaData: { frontText: 'Qa', backText: 'Aa' } },
                { globalHash: cardB, level: 0, vanillaData: { frontText: 'Qb', backText: 'Ab' } },
            ],
        });
    });

    after(async () => {
        db.close();
        accounts.closeAccounts();
        await new Promise(r => setTimeout(r, 50));
        try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* windows file locks */ }
    });

    // --- 1. Divergence -----------------------------------------------------------

    describe('two people, one card', () => {
        it('keeps each person on their own schedule', async () => {
            await asAuthor(author, () => docs.submitReview(docRel, cardA, 1, 2.5, 4));
            await asAccount(rita, () => docs.submitReview(docRel, cardA, 1, 2.5, 1));

            assert.equal(await ownerLevel(cardA), 4, "the author's own grade");
            const ritaState = await query.getFlashcardSrsStateByHash(cardA, rita.id);
            assert.equal(ritaState.level, 1, "the reader's own grade, on the same card");
        });

        it('gives a card nobody has reviewed the same shape as one with no row', async () => {
            // A missing CardProgress row and a zeroed one must be indistinguishable, because
            // that equivalence is what lets a review create the row lazily.
            assert.equal(await ownerLevel(cardB), 0);
            assert.equal(await query.getCardProgress(
                (await query.getFlashcardByHash(cardB)).id, rita.id,
            ), null, 'no row for a card this reader has never seen');
        });

        it('does not let one person\'s review move another\'s due list', async () => {
            // cardB is new to both. The reader studies it; the author must still be offered it.
            await asAccount(rita, () => docs.submitReview(docRel, cardB, 1, 2.5, 3));

            const isNew = (result, hash) => result.new.some(c => c.global_hash === hash);
            const ownerDue = await asAuthor(author, () => SRS.getDue({ algorithm: 'leitner', maxNew: 50 }));
            const ritaDue = await asAccount(rita, () => SRS.getDue({ algorithm: 'leitner', maxNew: 50 }));

            assert.ok(isNew(ownerDue, cardB), 'still unseen material for the author');
            assert.ok(!isNew(ritaDue, cardB), 'and no longer new for the reader who studied it');
        });

        it('counts only your own reviews in your own statistics', async () => {
            // Two reviews by the reader so far (cardA, then cardB); one by the author.
            const mine = await asAccount(rita, () => SRS.getStatistics({ algorithm: 'leitner' }));
            const theirs = await asAuthor(author, () => SRS.getStatistics({ algorithm: 'leitner' }));
            assert.equal(mine.totals.reviews, 2);
            assert.equal(theirs.totals.reviews, 1);
        });
    });

    // --- 2. Two canonical homes --------------------------------------------------

    describe('where each person\'s progress is canonical', () => {
        it('writes the author\'s schedule into the sidecar', async () => {
            assert.equal(sidecarCard(cardA).level, 4);
        });

        it('leaves the sidecar untouched by a reader, and seals nothing', async () => {
            const before = await sealTools.log();
            await asAccount(rita, () => docs.submitReview(docRel, cardA, 1, 2.5, 2));

            assert.equal(sidecarCard(cardA).level, 4, "still the author's number");
            const after = await sealTools.log();
            assert.equal(after.length, before.length,
                'a reader studying is not a reader editing — no commit');
        });

        it('records the reader\'s schedule in the accounts store instead', async () => {
            const snap = await accounts.getAccountProgress(getVaultId(), rita.id, cardA);
            assert.ok(snap, 'a durable snapshot exists');
            assert.equal(snap.level, 2, 'and it is current');
        });

        it('keeps no durable accounts-store copy of the author\'s own progress', async () => {
            // Two canonical copies is how two canonical copies drift. The author has one:
            // the sidecar.
            const all = await accounts.listAccountProgress(getVaultId());
            assert.ok(all.every(r => r.account_id !== OWNER_SCOPE && r.account_id !== author.id));
        });
    });

    // --- 3. Durability across a rebuild ------------------------------------------

    describe('a Vault Doctor rebuild', () => {
        it('restores the author from the sidecars and everyone else from the accounts store', async () => {
            const beforeSnapshots = (await accounts.listAccountProgress(getVaultId())).length;

            await asAuthor(author, () => doctor.rebuildIndex());

            assert.equal(await ownerLevel(cardA), 4, "author's schedule back from the sidecar");
            const ritaState = await query.getFlashcardSrsStateByHash(cardA, rita.id);
            assert.equal(ritaState.level, 2, "reader's schedule re-projected from AccountProgress");

            assert.equal((await accounts.listAccountProgress(getVaultId())).length, beforeSnapshots,
                'the Doctor reads the accounts store and never writes to it');
        });

        it('re-seeds the reader\'s SM-2 ease, which review logs no longer carry', async () => {
            // Ease lives in the latest ReviewLogs row, and a rebuild destroys review logs for
            // everybody. Without the synthetic row a reader's SM-2 schedule would silently
            // snap back to the 2.5 default.
            const state = await query.getFlashcardSrsStateByHash(cardA, rita.id);
            assert.equal(state.ease_factor, 2.5);
        });
    });

    // --- 4. Per-account derived analysis -----------------------------------------

    describe('everything derived from a review is per-account too', () => {
        it('fits FSRS weights per person, not per vault', async () => {
            await query.setFsrsWeights(JSON.stringify([0.1, 0.2, 0.3]), 42, rita.id);

            assert.deepEqual((await query.getFsrsWeights(rita.id)).weights, [0.1, 0.2, 0.3]);
            assert.equal(await query.getFsrsWeights(OWNER_SCOPE), null,
                "the author is still on the published defaults");
        });

        it('raises a health flag against one person\'s evidence only', async () => {
            const cardId = (await query.getFlashcardByHash(cardA)).id;
            await query.upsertCardFlag({
                flashcardId: cardId, kind: 'mouthful', confidence: 'high',
                score: 0.9, evidence: {}, levelAtDetection: 2, reviewLogId: null,
            }, rita.id);

            assert.equal((await cardHealth.getFlags(cardA, rita.id)).length, 1);
            assert.equal((await cardHealth.getFlags(cardA, OWNER_SCOPE)).length, 0);
        });

        it('clears every account\'s flags when the card itself is rewritten', async () => {
            // An edit is the one thing that is not per-person: the flags describe text that no
            // longer exists, so nobody should go on being warned about it.
            const cardId = (await query.getFlashcardByHash(cardA)).id;
            await query.upsertCardFlag({
                flashcardId: cardId, kind: 'mouthful', confidence: 'high',
                score: 0.9, evidence: {}, levelAtDetection: 4, reviewLogId: null,
            }, OWNER_SCOPE);

            await cardHealth.onCardEdited(cardA);

            assert.equal((await cardHealth.getFlags(cardA, rita.id)).length, 0);
            assert.equal((await cardHealth.getFlags(cardA, OWNER_SCOPE)).length, 0);
        });

        it('files a reader\'s diary under their own account, leaving the owner\'s in place', async () => {
            // The rebuild above wiped ReviewLogs, and a summary is derived from them — so give
            // each person a review to summarise.
            await asAuthor(author, () => docs.submitReview(docRel, cardA, 1, 2.5, 5));
            await asAccount(rita, () => docs.submitReview(docRel, cardA, 1, 2.5, 3));

            const today = new Date();
            const pad = (n) => String(n).padStart(2, '0');
            const day = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;

            await asAccount(rita, () => diary.generateSummary(day));
            await asAuthor(author, () => diary.generateSummary(day));

            const root = path.join(getVaultPath(), 'diary');
            assert.ok(fs.existsSync(path.join(root, 'summaries', `summary-${day}.json`)),
                'the owner keeps the unprefixed layout, so no existing file ever moves');
            assert.ok(fs.existsSync(path.join(root, 'accounts', rita.id, 'summaries', `summary-${day}.json`)),
                'everyone else gets their own subtree');

            const ritaSummary = JSON.parse(fs.readFileSync(
                path.join(root, 'accounts', rita.id, 'summaries', `summary-${day}.json`), 'utf-8'));
            assert.ok(ritaSummary.totals.reviews > 0, "and it counts the reader's own reviews");
        });
    });

    // --- 5. The sentinel ---------------------------------------------------------

    describe('the owner sentinel', () => {
        it('is a literal, never the Author\'s account id', async () => {
            const rows = await db.prepare(
                "SELECT DISTINCT account_id FROM CardProgress ORDER BY account_id",
            ).all();
            const ids = rows.map(r => r.account_id);
            assert.ok(ids.includes(OWNER_SCOPE));
            assert.ok(!ids.includes(author.id),
                "the author's uuid must never reach the vault database — it does not travel with the folder");
        });

        it('survives the vault being opened by an install that has never seen these accounts', async () => {
            // Simulating a copied vault: the vault database is the same file, but the accounts
            // store belongs to a different install and knows nothing about this Author. If the
            // owner's rows were keyed by uuid they would all be orphans now.
            const strangerAuthorId = crypto.randomUUID();
            assert.notEqual(strangerAuthorId, author.id);

            // Read the level rather than hardcoding one: earlier sections have moved it, and
            // what is being asserted here is which KEY finds it, not what it says.
            const stillMine = await query.getFlashcardSrsStateByHash(cardA, OWNER_SCOPE);
            assert.ok(stillMine.level > 0,
                'owner progress resolves through the sentinel, not through any account id');
            assert.equal(sidecarCard(cardA).level, stillMine.level,
                'and it is the same number the sidecar carries, which is what travels with a copy');

            const orphaned = await query.getFlashcardSrsStateByHash(cardA, strangerAuthorId);
            assert.equal(orphaned.level, 0,
                'and an unknown account simply reads as never-having-studied');
        });
    });

    describe('the columns migration 010 dropped', () => {
        // Regression. Migration 004's guard asked Flashcards whether it still had
        // fsrs_stability; once 010 had dropped it the answer was no forever, so 004 reported
        // itself pending on every boot and put all six columns back — empty, unread, and
        // precisely the stale-column trap 010 exists to remove. Migration 001 had the same
        // shape for sm2_reps on any rebuilt database. The failure was invisible to a test that
        // migrates once, which is why this one migrates twice.
        const DOOMED = [
            'level', 'sm2_reps', 'last_recall',
            'fsrs_stability', 'fsrs_difficulty', 'fsrs_due',
            'fsrs_state', 'fsrs_reps', 'fsrs_lapses',
        ];
        const present = async () => {
            const cols = (await db.pragma('table_info(Flashcards)')).map(c => c.name);
            return DOOMED.filter(c => cols.includes(c));
        };

        it('are absent after the first migration run', async () => {
            assert.deepEqual(await present(), []);
        });

        it('are still absent after the runner runs again, as it does on every launch', async () => {
            await runMigrations(db);
            assert.deepEqual(await present(), [],
                'a migration re-added a column 010 dropped: progress would be split across two homes');

            await runMigrations(db);
            assert.deepEqual(await present(), []);
        });
    });

    describe('the index behind the account filter', () => {
        // Regression, found on a real vault. Migration 010 indexed ReviewLogs.account_id on
        // its own. Every row of a one-person vault matches it, so it narrows nothing — but
        // SQLite sees an equality match on an indexed column, takes it, and abandons the join
        // order it would otherwise pick. getDayByDeck went from 24ms to 500ms, a day's diary
        // summary from 120ms to 4s, and "rebuild from history" from ~2s to minutes.
        //
        // Asserted as a schema shape rather than a duration: a timing test on this would be
        // flaky, and the shape is the actual rule — account_id must never be the whole of an
        // index on a table this size.
        const indexColumns = async (table) => {
            const out = {};
            for (const idx of await db.pragma(`index_list(${table})`)) {
                out[idx.name] = (await db.pragma(`index_info(${JSON.stringify(idx.name)})`))
                    .map(c => c.name);
            }
            return out;
        };

        it('is composite, because account_id alone matches every row', async () => {
            const indexes = await indexColumns('ReviewLogs');
            const soleAccount = Object.entries(indexes)
                .filter(([, cols]) => cols.length === 1 && cols[0] === 'account_id')
                .map(([name]) => name);
            assert.deepEqual(soleAccount, [],
                'an index on account_id alone lures the planner off a good join order');

            const composite = Object.values(indexes)
                .some(cols => cols[0] === 'account_id' && cols.length > 1);
            assert.ok(composite,
                'account-scoped reads still need an index led by account_id');
        });
    });

    // --- 5. What a reader's review does NOT touch ---------------------------------

    describe('a reader\'s review leaves the owner\'s document alone', () => {
        // `presence` is a STORED, sidecar-mirrored number about the document — the owner's
        // claim about how well this material is known, not a per-viewer score. So a reader's
        // grade must not move it, and `documents.submitReview` returns before
        // propagatePresence for exactly that reason.
        //
        // Worth being exact about what this does and does not catch. It passed BEFORE
        // propagatePresence was skipped for readers too, because that call recomputed an
        // owner-scoped average the reader had not moved and wrote back the value it had
        // just read. So this pins the invariant; it does not guard the saving. The saving —
        // a second store-wide transaction plus ~3 queries per folder level on the hottest
        // path a multi-user vault has — is guarded by `scripts/bench-reviews.js`, which is
        // where a regression in it would actually show up.
        const snapshot = async () => ({
            documents: await db.prepare('SELECT id, presence FROM Documents ORDER BY id').all(),
            folders: await db.prepare('SELECT id, presence FROM Folders ORDER BY id').all(),
        });

        it('does not move Documents.presence or any ancestor folder', async () => {
            // Give presence a non-trivial value to move away from first.
            await asAuthor(author, () => docs.submitReview(docRel, cardA, 1, 2.5, 5));
            const before = await snapshot();

            await asAccount(rita, () => docs.submitReview(docRel, cardA, 1, 2.5, 1));
            await asAccount(rita, () => docs.submitReview(docRel, cardB, 1, 2.5, 5));

            assert.deepEqual(await snapshot(), before,
                "a reader's grade rewrote a number that belongs to the owner's document");
        });

        it('still records the reader\'s own progress while doing so', async () => {
            // The guard above must not have been achieved by skipping the review itself.
            const state = await query.getFlashcardSrsStateByHash(cardB, rita.id);
            assert.equal(state.level, 5);
        });

        it('does not read the sidecar on the reader\'s path', async () => {
            // The sidecar is read only to be mutated, which a reader never does. Proven by
            // removing it: the owner's review needs the file and fails without it, a
            // reader's does not. This is the property, not the timing — a future refactor
            // that reintroduces the read would still pass every other test in this file.
            const abs = docs.files.safePath(docRel) + '.flashback';
            const saved = fs.readFileSync(abs);
            fs.rmSync(abs);
            try {
                await asAccount(rita, () => docs.submitReview(docRel, cardA, 1, 2.5, 4));
                assert.equal(
                    (await query.getFlashcardSrsStateByHash(cardA, rita.id)).level, 4,
                    'the reader\'s review should not depend on the sidecar at all',
                );
                await assert.rejects(
                    () => asAuthor(author, () => docs.submitReview(docRel, cardA, 1, 2.5, 4)),
                    'the owner\'s review DOES need the sidecar, and must still say so',
                );
            } finally {
                fs.writeFileSync(abs, saved);
            }
        });
    });
});
