// Migration 015 — CardProgress moves to the progress store, and AccountProgress collapses into it
//
// The last and largest of the moves, and the one that ends the split this whole refactor exists
// to remove. Until now a card's schedule had TWO canonical homes: the owner's in the `.flashback`
// sidecar (mirrored into `main.CardProgress`), and everyone else's in `accounts.db`'s
// `AccountProgress`. Every review therefore wrote two stores over two connections, and
// `srs.js#_mirrorProgress` did the second write from inside the first one's transaction — which
// is not atomic, and which a plain `throw` was enough to desynchronise.
//
// Afterwards there is one home, `progress.CardProgress`, keyed `(account_id, card_hash)`, with
// the owner under the `'owner'` sentinel exactly as every other scoped table already stores them.
//
// THERE IS NOTHING TO HARVEST FROM THE SIDECARS.
//
// `documents.js#_syncDocumentFlashcards` has always max-merged a sidecar's `level`/`sm2Reps` into
// the database on every index, so `main.CardProgress` is already >= the sidecar for the owner.
// Copying that table therefore carries every owner row with it. The sidecar fields are left
// exactly where they are — see MIGRATIONS.md and DATAMODEL.md: this refactor moves by copy and
// stops reading the old place, rather than deleting anything a downgrade would miss.
//
// THE ACCOUNTS HALF ONLY READS.
//
// `accounts.db` is a different connection, so that half cannot be one statement. It reads
// `AccountProgress` and writes into this migration's transaction, which means a rollback leaves
// nothing half-done and a re-run simply re-reads; `INSERT OR IGNORE` makes it idempotent. The
// rows are deliberately NOT deleted from `accounts.db`. Nothing reads them afterwards, and
// leaving them is what keeps this migration reversible.
//
// `getVaultId()` resolves through `ensureManifest()`, which is idempotent and creates
// `vault.json` when absent — so calling it here merely creates the manifest a moment before
// `openVault()` would have.
//
// `ease_factor` has no column in `CardProgress` and never did: SM-2's ease is read back out of
// the newest review log. Those logs are durable now (migration 013), so the normal path needs
// nothing. The synthetic row below is the fallback for a reader whose logs were lost to a
// rebuild before this migration ran, where `AccountProgress.ease_factor` was the only copy left
// — the same recovery `doctor._restoreAccountProgress` used to perform, done once instead of on
// every rebuild.

import { listAccountProgress } from '../../access/primitives/accounts.js';
import { getVaultId } from '../../access/primitives/vault.js';

export const version = 15;
export const description = 'CardProgress: move to the progress store and absorb accounts.db AccountProgress';

const CARRIED = [
    'level', 'sm2_reps', 'last_recall',
    'fsrs_stability', 'fsrs_difficulty', 'fsrs_due',
    'fsrs_state', 'fsrs_reps', 'fsrs_lapses',
];

/**
 * Whether a table is still in `main` specifically.
 *
 * See MIGRATIONS.md § Moving a table to another schema: `PRAGMA table_info` would answer "yes"
 * for a copy that has already moved, which is the opposite of what a move needs to know.
 *
 * @param {object} db
 * @param {string} name
 * @returns {Promise<boolean>}
 */
async function mainHasTable(db, name) {
    return !!await db.prepare(
        "SELECT name FROM main.sqlite_master WHERE type='table' AND name = ?",
    ).get(name);
}

/**
 * @param {object} db
 * @returns {Promise<boolean>}
 */
export async function shouldRun(db) {
    return await mainHasTable(db, 'CardProgress');
}

/** @param {object} db */
export async function up(db) {
    if (!await mainHasTable(db, 'CardProgress')) return;

    const oldCols = (await db.pragma('main.table_info(CardProgress)')).map((c) => c.name);
    const carried = CARRIED.filter((c) => oldCols.includes(c));

    // Rows whose card is missing from the index are dropped by the join rather than carried
    // over. They were already unreachable: the old ON DELETE CASCADE removed a card's progress
    // with the card, so a surviving orphan means the two had already diverged.
    await db.exec(`
        INSERT OR IGNORE INTO progress.CardProgress (account_id, card_hash, ${carried.join(', ')})
        SELECT cp.account_id, f.global_hash, ${carried.map((c) => `cp.${c}`).join(', ')}
        FROM main.CardProgress cp
        JOIN main.Flashcards f ON f.id = cp.flashcard_id
    `);

    await absorbAccountProgress(db);

    await db.exec('DROP TABLE main.CardProgress');
}

/**
 * Copies every non-owner schedule out of `accounts.db` and into the progress store.
 *
 * @param {object} db
 */
async function absorbAccountProgress(db) {
    let snapshots = [];
    try {
        snapshots = await listAccountProgress(getVaultId());
    } catch {
        // No accounts store, or none for this vault: a desktop install that never had readers.
        return;
    }

    const insert = db.prepare(`
        INSERT OR IGNORE INTO progress.CardProgress
            (account_id, card_hash, ${CARRIED.join(', ')}, updated_at)
        VALUES (?, ?, ${CARRIED.map(() => '?').join(', ')}, ?)
    `);

    const seedEase = db.prepare(`
        INSERT INTO progress.ReviewLogs (card_hash, account_id, timestamp, outcome, ease_factor, level)
        SELECT ?, ?, datetime('now'), NULL, ?, ?
        WHERE NOT EXISTS (
            SELECT 1 FROM progress.ReviewLogs WHERE card_hash = ? AND account_id = ?
        )
    `);

    for (const snap of snapshots) {
        await insert.run(
            snap.account_id, snap.card_hash,
            ...CARRIED.map((c) => snap[c] ?? null),
            snap.updated_at ?? new Date().toISOString(),
        );

        if (snap.ease_factor != null) {
            await seedEase.run(
                snap.card_hash, snap.account_id, snap.ease_factor, snap.level ?? 0,
                snap.card_hash, snap.account_id,
            );
        }
    }
}
