// Migration 013 — move ReviewLogs out of the derived database and into the progress store
//
// `ReviewLogs` has always been the clearest contradiction in the schema: it lives in the
// database we describe as derived and rebuildable, and nothing can rebuild it. The Doctor
// says so in its own header — a rebuild "Loses ReviewLogs history" — which is another way of
// saying the vault database was never actually disposable. This moves the ledger to
// `{vault}/progress.db` (see `access/primitives/progress.js`), where losing it would require
// losing a file nobody is invited to delete.
//
// The re-key from `flashcard_id` to `card_hash` is the point of the exercise, not a detail.
// A Doctor rebuild reassigns every row id in the vault database, so an id-keyed ledger in a
// durable file would be orphaned by the first rebuild after this migration — silently, since
// an orphaned join simply returns nothing. Only `globalHash` survives a rebuild, which is the
// same reasoning `accounts.js` already applies to `AccountProgress`.
//
// Row ids are carried across unchanged. `getLatestEaseFactors`, `getLatestReviewLog` and the
// session-order queries all resolve "most recent" with `MAX(id)` or `ORDER BY id`, so
// renumbering here would reorder history.
//
// Rows whose flashcard is missing from the index are dropped by the join rather than carried
// over. They were already unreachable: the old `ON DELETE CASCADE` removed a card's logs with
// the card, so a surviving orphan means the index and the ledger had already diverged.
//
// Runs after 004/006/009/012, which add the columns copied below, so by the time this runs
// `main.ReviewLogs` is at its final shape. On a fresh vault there is no `main.ReviewLogs` at
// all — `SchemaSQL.js` no longer creates it — so `shouldRun` returns false and the table is
// simply born in the progress store.

export const version = 13;
export const description = 'ReviewLogs: move to the progress store, re-keyed by card_hash';

/** Columns copied verbatim. `id` and the key column are handled separately. */
const CARRIED = [
    'account_id', 'timestamp', 'outcome', 'ease_factor', 'level', 'algorithm', 'rating',
    'fsrs_stability', 'fsrs_difficulty', 'fsrs_due', 'fsrs_state',
    'session_id', 'session_position', 'prev_distance', 'nearest_sibling_lag',
];

/**
 * @param {object} db
 * @returns {Promise<boolean>} whether a `ReviewLogs` table still sits in the vault database.
 */
export async function shouldRun(db) {
    const row = await db.prepare(
        "SELECT name FROM main.sqlite_master WHERE type='table' AND name='ReviewLogs'",
    ).get();
    return !!row;
}

/** @param {object} db */
export async function up(db) {
    if (!await shouldRun(db)) return;

    const oldCols = (await db.pragma('main.table_info(ReviewLogs)')).map((c) => c.name);
    const carried = CARRIED.filter((c) => oldCols.includes(c));

    const columnList = ['id', 'card_hash', ...carried].join(', ');
    const selectList = ['rl.id', 'f.global_hash', ...carried.map((c) => `rl.${c}`)].join(', ');

    await db.exec(`
        INSERT OR IGNORE INTO progress.ReviewLogs (${columnList})
        SELECT ${selectList}
        FROM main.ReviewLogs rl
        JOIN main.Flashcards f ON f.id = rl.flashcard_id
    `);

    await db.exec('DROP TABLE main.ReviewLogs');
}
