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

const asAccount = (account, fn) => runWithAccount(account, fn);
const asAuthor = (author, fn) => runWithAccount(author, fn);

const ownerLevel = async (hash) => (await query.getFlashcardSrsStateByHash(hash, OWNER_SCOPE))?.level ?? 0;
const sidecarCard = (hash) => docs.files.getMetadata(docRel).flashcards.find(c => c.globalHash === hash);

const DOOMED_AFTER_010 = [
    'level', 'sm2_reps', 'last_recall',
    'fsrs_stability', 'fsrs_difficulty', 'fsrs_due',
    'fsrs_state', 'fsrs_reps', 'fsrs_lapses',
];

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
        try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {  }
    });


    describe('two people, one card', () => {
        it('keeps each person on their own schedule', async () => {
            await asAuthor(author, () => docs.submitReview(docRel, cardA, 1, 2.5, 4));
            await asAccount(rita, () => docs.submitReview(docRel, cardA, 1, 2.5, 1));

            assert.equal(await ownerLevel(cardA), 4, "the author's own grade");
            const ritaState = await query.getFlashcardSrsStateByHash(cardA, rita.id);
            assert.equal(ritaState.level, 1, "the reader's own grade, on the same card");
        });

        it('gives a card nobody has reviewed the same shape as one with no row', async () => {
            assert.equal(await ownerLevel(cardB), 0);
            assert.equal(await query.getCardProgress(
                (await query.getFlashcardByHash(cardB)).id, rita.id,
            ), null, 'no row for a card this reader has never seen');
        });

        it('does not let one person\'s review move another\'s due list', async () => {
            await asAccount(rita, () => docs.submitReview(docRel, cardB, 1, 2.5, 3));

            const isNew = (result, hash) => result.new.some(c => c.global_hash === hash);
            const ownerDue = await asAuthor(author, () => SRS.getDue({ algorithm: 'leitner', maxNew: 50 }));
            const ritaDue = await asAccount(rita, () => SRS.getDue({ algorithm: 'leitner', maxNew: 50 }));

            assert.ok(isNew(ownerDue, cardB), 'still unseen material for the author');
            assert.ok(!isNew(ritaDue, cardB), 'and no longer new for the reader who studied it');
        });

        it('counts only your own reviews in your own statistics', async () => {
            const mine = await asAccount(rita, () => SRS.getStatistics({ algorithm: 'leitner' }));
            const theirs = await asAuthor(author, () => SRS.getStatistics({ algorithm: 'leitner' }));
            assert.equal(mine.totals.reviews, 2);
            assert.equal(theirs.totals.reviews, 1);
        });
    });


    describe('where each person\'s progress is canonical', () => {
        it('leaves the author\'s sidecar frozen — nobody writes progress to a file now', async () => {
            assert.equal(sidecarCard(cardA).level ?? 0, 0, 'the file did not move');
            assert.equal(await ownerLevel(cardA), 4, 'the schedule did');
        });

        it('seals nothing when anyone studies, reader or author', async () => {
            const before = await sealTools.log();
            await asAccount(rita, () => docs.submitReview(docRel, cardA, 1, 2.5, 2));
            await asAuthor(author, () => docs.submitReview(docRel, cardB, 1, 2.5, 1));

            const after = await sealTools.log();
            assert.equal(after.length, before.length,
                'studying is not editing — for either of them, no commit');
        });

        it('records the reader\'s schedule in the progress store, not the accounts store', async () => {
            const state = await query.getFlashcardSrsStateByHash(cardA, rita.id);
            assert.equal(state.level, 2, "the reader's own schedule is current");

            const snap = await accounts.getAccountProgress(getVaultId(), rita.id, cardA);
            assert.ok(!snap, 'nothing is mirrored into the accounts store any more');
        });

        it('keeps no accounts-store copy of anybody\'s progress', async () => {
            const all = await accounts.listAccountProgress(getVaultId());
            assert.deepEqual(all, []);
        });
    });


    describe('a Vault Doctor rebuild', () => {
        it('restores everyone, because the progress store is not what a rebuild wipes', async () => {
            const beforeSnapshots = (await accounts.listAccountProgress(getVaultId())).length;

            await asAuthor(author, () => doctor.rebuildIndex());

            assert.equal(await ownerLevel(cardA), 4, "author's schedule back from the sidecar");
            const ritaState = await query.getFlashcardSrsStateByHash(cardA, rita.id);
            assert.equal(ritaState.level, 2, "reader's schedule re-projected from AccountProgress");

            assert.equal((await accounts.listAccountProgress(getVaultId())).length, beforeSnapshots,
                'the Doctor reads the accounts store and never writes to it');
        });

        it('re-seeds the reader\'s SM-2 ease, which review logs no longer carry', async () => {
            const state = await query.getFlashcardSrsStateByHash(cardA, rita.id);
            assert.equal(state.ease_factor, 2.5);
        });
    });


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
            const strangerAuthorId = crypto.randomUUID();
            assert.notEqual(strangerAuthorId, author.id);

            const stillMine = await query.getFlashcardSrsStateByHash(cardA, OWNER_SCOPE);
            assert.ok(stillMine.level > 0,
                'owner progress resolves through the sentinel, not through any account id');
            assert.notEqual(sidecarCard(cardA).level ?? 0, stillMine.level,
                'the frozen file has drifted from the live schedule, as designed');

            const orphaned = await query.getFlashcardSrsStateByHash(cardA, strangerAuthorId);
            assert.equal(orphaned.level, 0,
                'and an unknown account simply reads as never-having-studied');
        });
    });

    describe('the columns migration 010 dropped', () => {
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


    describe('a reader\'s review leaves the owner\'s document alone', () => {
        const snapshot = async () => ({
            documents: await db.prepare('SELECT id, presence FROM Documents ORDER BY id').all(),
            folders: await db.prepare('SELECT id, presence FROM Folders ORDER BY id').all(),
        });

        it('does not move Documents.presence or any ancestor folder', async () => {
            await asAuthor(author, () => docs.submitReview(docRel, cardA, 1, 2.5, 5));
            const before = await snapshot();

            await asAccount(rita, () => docs.submitReview(docRel, cardA, 1, 2.5, 1));
            await asAccount(rita, () => docs.submitReview(docRel, cardB, 1, 2.5, 5));

            assert.deepEqual(await snapshot(), before,
                "a reader's grade rewrote a number that belongs to the owner's document");
        });

        it('still records the reader\'s own progress while doing so', async () => {
            const state = await query.getFlashcardSrsStateByHash(cardB, rita.id);
            assert.equal(state.level, 5);
        });

        it('does not read the sidecar on ANYONE\'s path', async () => {
            const abs = docs.files.safePath(docRel) + '.flashback';
            const saved = fs.readFileSync(abs);
            fs.rmSync(abs);
            try {
                await asAccount(rita, () => docs.submitReview(docRel, cardA, 1, 2.5, 4));
                assert.equal(
                    (await query.getFlashcardSrsStateByHash(cardA, rita.id)).level, 4,
                    'the reader\'s review does not depend on the sidecar',
                );
                await asAuthor(author, () => docs.submitReview(docRel, cardA, 1, 2.5, 6));
                assert.equal(
                    (await query.getFlashcardSrsStateByHash(cardA, OWNER_SCOPE)).level, 6,
                    'and neither does the author\'s',
                );
            } finally {
                fs.writeFileSync(abs, saved);
            }
        });
    });

    describe('migration guards after a table moves schema', () => {
        const MOVABLE = ['CardProgress', 'FsrsParameters', 'CardHealth', 'CardFlags', 'ReadProgress'];

        it('leaves a moved table in the progress store and rebuilds nothing in main', async () => {
            const os = await import('os');
            const { createSqliteAdapter } = await import('../src/api/access/primitives/sqliteAdapter.js');
            const { SCHEMA: PROGRESS_SCHEMA } = await import('../src/api/access/primitives/progress.js');
            const { default: SchemaSQL } = await import('../src/api/config/defaults/SchemaSQL.js');

            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-guards-'));
            const progressPath = path.join(dir, 'progress.db');
            const adapter = createSqliteAdapter({
                resolvePath: () => path.join(dir, 'vault.db'),
                onOpen: (rawDb) => {
                    rawDb.prepare('ATTACH DATABASE ? AS progress').run(progressPath);
                    rawDb.pragma('progress.journal_mode = WAL');
                    rawDb.exec(PROGRESS_SCHEMA);
                },
            });
            const scratch = adapter.db;

            try {
                await scratch.exec(SchemaSQL.replace(/BEGIN TRANSACTION;|COMMIT;/g, ''));

                for (const table of MOVABLE) {
                    await scratch.exec(`DROP TABLE IF EXISTS main.${table}`);
                }
                await scratch.exec(
                    "INSERT INTO progress.CardProgress (account_id, card_hash, level) VALUES ('owner', 'moved', 7)",
                );

                await runMigrations(scratch);
                await runMigrations(scratch);

                const inMain = [];
                for (const table of MOVABLE) {
                    const row = await scratch.prepare(
                        "SELECT name FROM main.sqlite_master WHERE type = 'table' AND name = ?",
                    ).get(table);
                    if (row) inMain.push(table);
                }
                assert.deepEqual(inMain, [],
                    'a migration rebuilt a moved table in main, which shadows the real one silently');

                const seen = await scratch.prepare(
                    "SELECT level FROM CardProgress WHERE card_hash = 'moved'",
                ).get();
                assert.equal(seen?.level, 7, 'an unqualified read must still reach the progress store');

                const cols = (await scratch.pragma('table_info(Flashcards)')).map(c => c.name);
                assert.deepEqual(DOOMED_AFTER_010.filter(c => cols.includes(c)), [],
                    'migration 004 resurrected the columns 010 dropped, with 011 unable to clean them');

                const indexes = (await scratch.prepare(
                    "SELECT name FROM main.sqlite_master WHERE type = 'index'",
                ).all()).map(r => r.name);
                assert.ok(!indexes.includes('idx_cardprogress_account'),
                    'migration 010 put back the sole-account index migration 012 exists to remove');
            } finally {
                adapter.closeDatabase();
                try { fs.rmSync(dir, { recursive: true, force: true }); } catch {  }
            }
        });
    });
});
