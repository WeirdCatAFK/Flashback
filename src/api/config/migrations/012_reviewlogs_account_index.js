// Migration 012 — replace ReviewLogs' account index with one the planner can use well
//
// Migration 010 added `account_id` to ReviewLogs and indexed it on its own. That index is
// worse than useless: a vault has one account per person and most have exactly one, so every
// row matches, and the index cannot narrow anything. SQLite's planner does not know that
// without ANALYZE — it sees an equality match on an indexed column, takes it, and abandons
// the join order it would otherwise have chosen.
//
// The cost was not theoretical. The diary's per-deck rollup (`getDayByDeck`) joins ReviewLogs
// to Flashcards to DeckEntries to Decks. Before the scope column it ran in ~24ms; after, the
// planner drove the join from DeckEntries and re-searched ReviewLogs by account for every
// row, taking ~500ms. A day's summary went from ~120ms to ~4s, and "rebuild the diary from
// history" — one summary per active day, in a single request — went from about two seconds
// to minutes, which reads as a hang and gets killed before it finishes.
//
// The fix is a composite (account_id, flashcard_id). Its leftmost column still answers every
// "this account's rows" lookup the single-column index answered, and the second column turns
// the join above into a direct seek: the same query drops to ~2ms, faster than it ever was.
//
// The single-column index is dropped by shape rather than by name, because the two ways a
// vault can arrive here named it differently — `reviewlogs_account_id_index` from knex in
// SchemaSQL.js, `idx_reviewlogs_account` from migration 010.

export const version = 12;
export const description = 'ReviewLogs: composite (account_id, flashcard_id) index instead of account_id alone';

const COMPOSITE = 'idx_reviewlogs_account_card';

// Every index on ReviewLogs whose only column is account_id, whatever it is called.
async function soleAccountIndexes(db) {
    const indexes = await db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='ReviewLogs' AND sql IS NOT NULL",
    ).all();
    const found = [];
    for (const { name } of indexes) {
        const cols = (await db.pragma(`index_info(${JSON.stringify(name)})`)).map(c => c.name);
        if (cols.length === 1 && cols[0] === 'account_id') found.push(name);
    }
    return found;
}

export async function shouldRun(db) {
    const hasReviewLogs = await db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='ReviewLogs'",
    ).get();
    if (!hasReviewLogs) return false;
    const cols = (await db.pragma('table_info(ReviewLogs)')).map(c => c.name);
    if (!cols.includes('account_id')) return false; // pre-010 vault; 010 runs first and creates both

    const composite = await db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name=?",
    ).get(COMPOSITE);
    return !composite || (await soleAccountIndexes(db)).length > 0;
}

export async function up(db) {
    const cols = (await db.pragma('table_info(ReviewLogs)')).map(c => c.name);
    if (!cols.includes('account_id')) return;

    await db.exec(`CREATE INDEX IF NOT EXISTS ${COMPOSITE} ON ReviewLogs(account_id, flashcard_id)`);
    for (const name of await soleAccountIndexes(db)) {
        await db.exec(`DROP INDEX IF EXISTS "${name}"`);
    }
}
