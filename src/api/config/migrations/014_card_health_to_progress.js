// Migration 014 — move CardHealth, CardFlags and FsrsParameters into the progress store
//
// The same move migration 013 made for ReviewLogs, for the three remaining tables that are
// derived from behaviour rather than from the canonical files. None of them can be rebuilt
// from a `.flashback` sidecar: a health verdict is computed from one person's interval
// trajectory, a flag from their failures, and a weight vector is fitted from their whole
// review history. Keeping them in the database we describe as disposable is what made that
// description untrue.
//
// Re-keyed from `flashcard_id` to `card_hash` for the reason 013 gives: a Doctor rebuild
// reassigns every row id in the vault database, and only `globalHash` survives it. Once these
// rows live in a file the rebuild does not touch, an id key would be orphaned by the first
// rebuild after this migration — silently, since an orphaned join returns nothing rather than
// an error.
//
// `CardFlags.review_log_id` keeps pointing at a real row: migration 013 carried ReviewLogs' ids
// across unchanged rather than renumbering them.
//
// `FsrsParameters` is the simple case — keyed by account alone, no card reference, and no
// foreign key of any kind — so it is a straight copy.
//
// Unlike 013, these three are ALSO removed from `SchemaSQL.js`. 013 had to leave ReviewLogs
// there because migration 009 runs an unguarded `CREATE INDEX ... ON ReviewLogs`, which targets
// `main` and would fail on a table that was never created. Every statement that touches these
// three now sits behind a `tableExists` guard (007's up(), 004's FsrsParameters block) or a
// `mainHasTable` guard (010's four in-place rewrites), so nothing recreates them. The drops
// below still run whenever a copy is found, so a database that somehow acquires one heals
// itself on the next launch.

export const version = 14;
export const description = 'CardHealth, CardFlags and FsrsParameters: move to the progress store, re-keyed by card_hash';

const MOVED = ['CardHealth', 'CardFlags', 'FsrsParameters'];

/** Columns copied verbatim, per table. `id` is dropped and the key column is handled separately. */
const CARRIED = {
    CardHealth: ['account_id', 'epoch_at', 'epoch_reason', 'content_fingerprint', 'updated_at'],
    CardFlags: [
        'account_id', 'kind', 'confidence', 'score', 'evidence_json',
        'level_at_detection', 'detected_at', 'review_log_id', 'dismissed_at',
    ],
    FsrsParameters: ['account_id', 'weights_json', 'optimized_at', 'review_count'],
};

/**
 * Whether a table is still in `main` specifically.
 *
 * `PRAGMA table_info` would answer "yes" for a copy that has already moved, which is the
 * opposite of what a move needs to know. See MIGRATIONS.md § Moving a table to another schema.
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
    for (const table of MOVED) {
        if (await mainHasTable(db, table)) return true;
    }
    return false;
}

/** @param {object} db */
export async function up(db) {
    for (const table of MOVED) {
        if (!await mainHasTable(db, table)) continue;

        const oldCols = (await db.pragma(`main.table_info(${table})`)).map((c) => c.name);
        const carried = CARRIED[table].filter((c) => oldCols.includes(c));

        if (table === 'FsrsParameters') {
            await db.exec(`
                INSERT OR IGNORE INTO progress.FsrsParameters (${carried.join(', ')})
                SELECT ${carried.join(', ')} FROM main.FsrsParameters
            `);
        } else {
            // Rows whose card is missing from the index are dropped by the join rather than
            // carried over. They were already unreachable: the old ON DELETE CASCADE removed
            // them with the card, so a surviving orphan means the two had already diverged.
            await db.exec(`
                INSERT OR IGNORE INTO progress.${table} (card_hash, ${carried.join(', ')})
                SELECT f.global_hash, ${carried.map((c) => `t.${c}`).join(', ')}
                FROM main.${table} t
                JOIN main.Flashcards f ON f.id = t.flashcard_id
            `);
        }

        await db.exec(`DROP TABLE main.${table}`);
    }
}
