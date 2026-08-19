// Migration 011 — remove the SRS columns migration 004 could put back
//
// Migration 010 dropped nine columns off Flashcards. Migration 004's shouldRun() guard asked
// "does Flashcards have fsrs_stability?" and, once 010 had answered no, reported itself
// pending on every subsequent boot and re-added all six fsrs_* columns — empty, unread, and
// exactly the stale-column trap 010 exists to avoid. Migration 001 had the same shape for
// sm2_reps on any rebuilt database, where its SchemaVersion row is absent.
//
// Both guards are fixed at the source, so no vault can acquire these columns again. This
// migration is the repair for the ones that already did: a vault migrated by an affected
// build and launched a second time is carrying them right now, and nothing else would ever
// take them away. It moves no data — the columns it drops are ones 010 already emptied into
// CardProgress, and a resurrected column is created empty by definition.
//
// shouldRun() makes it self-healing rather than once-only: it fires whenever a doomed column
// is found on Flashcards while CardProgress exists, no matter how it got there.

export const version = 11;
export const description = 'Drop the Flashcards SRS columns migration 004 could re-add after 010';

const DOOMED_COLUMNS = [
    'level', 'sm2_reps', 'last_recall',
    'fsrs_stability', 'fsrs_difficulty', 'fsrs_due',
    'fsrs_state', 'fsrs_reps', 'fsrs_lapses',
];

async function columns(db, table) {
    return (await db.pragma(`table_info(${table})`)).map(c => c.name);
}

async function resurrected(db) {
    const migrated = await db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='CardProgress'"
    ).get();
    // Without CardProgress the vault has not reached 010 yet, and these columns are the real
    // ones holding real progress. Dropping them there would delete every schedule in the
    // vault, so the check is deliberately conjunctive.
    if (!migrated) return [];
    const present = await columns(db, 'Flashcards');
    return DOOMED_COLUMNS.filter(c => present.includes(c));
}

export async function shouldRun(db) {
    return (await resurrected(db)).length > 0;
}

export async function up(db) {
    const doomed = await resurrected(db);
    if (doomed.length === 0) return;

    // SQLite refuses to drop a column any index mentions. 004 creates no index on these, but
    // a vault whose Flashcards came from migration 001 carries flashcards_last_recall_index,
    // so read the indexes out rather than assuming.
    const indexes = await db.prepare(
        "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='Flashcards' AND sql IS NOT NULL"
    ).all();
    for (const idx of indexes) {
        if (doomed.some(c => new RegExp(`\b${c}\b`).test(idx.sql))) {
            await db.exec(`DROP INDEX IF EXISTS "${idx.name}"`);
        }
    }

    for (const column of doomed) {
        await db.exec(`ALTER TABLE Flashcards DROP COLUMN ${column}`);
    }
}
