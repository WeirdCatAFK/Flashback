export const version = 11;
export const description = 'Drop the Flashcards SRS columns migration 004 could re-add after 010';

const DOOMED_COLUMNS = [
    'level', 'sm2_reps', 'last_recall',
    'fsrs_stability', 'fsrs_difficulty', 'fsrs_due',
    'fsrs_state', 'fsrs_reps', 'fsrs_lapses',
];

async function tableExists(db, name) {
    return (await db.pragma(`table_info(${name})`)).length > 0;
}

async function columns(db, table) {
    return (await db.pragma(`table_info(${table})`)).map(c => c.name);
}

async function resurrected(db) {
    const migrated = await tableExists(db, 'CardProgress');
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

    const indexes = await db.prepare(
        "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='Flashcards' AND sql IS NOT NULL"
    ).all();
    for (const idx of indexes) {
        if (doomed.some(c => new RegExp(`\\b${c}\\b`).test(idx.sql))) {
            await db.exec(`DROP INDEX IF EXISTS "${idx.name}"`);
        }
    }

    for (const column of doomed) {
        await db.exec(`ALTER TABLE Flashcards DROP COLUMN ${column}`);
    }
}
