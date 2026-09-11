// Migration 004 — FSRS scheduler
//
// Adds FSRS-6 per-card state to Flashcards, a per-review state snapshot + the
// real 1–4 rating to ReviewLogs, and the FsrsParameters table that holds the
// vault's active weight vector. Purely additive — existing Leitner/SM-2 data is
// untouched, and vaults only populate these columns once a user opts into FSRS.
//
// Safe to re-run: every column add is guarded by a PRAGMA table_info check and
// the table uses CREATE TABLE IF NOT EXISTS.

export const version = 4;
export const description = 'FSRS scheduler: card state columns, review snapshot, FsrsParameters';

// Migration 010 moved the per-card FSRS state into CardProgress and dropped these six
// columns off Flashcards. After it has run their absence is the CORRECT state, not a
// missing artifact — so this guard must stop asking Flashcards about them, or it reports
// itself pending on every boot forever and re-adds exactly the columns 010 removed.
// (That is not hypothetical: it is what happened the first time a real vault was migrated.)
// The ReviewLogs snapshot columns and the FsrsParameters table are untouched by 010 and are
// still this migration's business.
/**
 * Whether a table exists in ANY attached schema, not just `main`.
 *
 * `PRAGMA table_info` resolves through every attached database; a plain `sqlite_master`
 * query reads `main` alone, which stopped being the whole database when the progress store
 * was attached. A table that has moved there is still present — just not in `main`, and a
 * guard that cannot tell "moved" from "absent" answers "still pending" forever.
 *
 * @param {object} db
 * @param {string} name
 * @returns {Promise<boolean>}
 */
async function tableExists(db, name) {
    return (await db.pragma(`table_info(${name})`)).length > 0;
}

async function supersededBy010(db) {
    return await tableExists(db, 'CardProgress');
}

export async function shouldRun(db) {
    const cols = (await db.prepare("PRAGMA table_info('Flashcards')").all()).map(c => c.name);
    const hasTable = await tableExists(db, 'FsrsParameters');
    const cardStateMissing = !await supersededBy010(db) && !cols.includes('fsrs_stability');
    return cardStateMissing || !hasTable;
}

export async function up(db) {
    const addColumns = async (tableName, additions) => {
        const existing = (await db.prepare(`PRAGMA table_info('${tableName}')`).all()).map(c => c.name);
        for (const [name, ddl] of additions) {
            if (!existing.includes(name)) {
                await db.prepare(`ALTER TABLE ${tableName} ADD COLUMN ${ddl}`).run();
            }
        }
    };

    // Guarded here as well as in shouldRun(): up() also runs when the SchemaVersion row for
    // this migration is absent, which is every rebuilt database — and a rebuilt database is
    // built from the modern SchemaSQL, where these columns are gone on purpose.
    if (!await supersededBy010(db)) await addColumns('Flashcards', [
        ['fsrs_stability', 'fsrs_stability FLOAT'],
        ['fsrs_difficulty', 'fsrs_difficulty FLOAT'],
        ['fsrs_due', 'fsrs_due TIMESTAMP'],
        ['fsrs_state', 'fsrs_state INTEGER NOT NULL DEFAULT 0'],
        ['fsrs_reps', 'fsrs_reps INTEGER NOT NULL DEFAULT 0'],
        ['fsrs_lapses', 'fsrs_lapses INTEGER NOT NULL DEFAULT 0'],
    ]);

    await addColumns('ReviewLogs', [
        ['rating', 'rating INTEGER'],
        ['fsrs_stability', 'fsrs_stability FLOAT'],
        ['fsrs_difficulty', 'fsrs_difficulty FLOAT'],
        ['fsrs_due', 'fsrs_due TIMESTAMP'],
        ['fsrs_state', 'fsrs_state INTEGER'],
    ]);

    // Guarded rather than left to `IF NOT EXISTS`: an unqualified CREATE targets `main`,
    // and its existence check cannot see a copy that has moved to the progress store — so it
    // would build an empty shadow that wins every unqualified read.
    if (!await tableExists(db, 'FsrsParameters')) {
        await db.exec(`CREATE TABLE IF NOT EXISTS FsrsParameters (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            weights_json TEXT NOT NULL,
            optimized_at TIMESTAMP,
            review_count INTEGER
        )`);
    }
}
