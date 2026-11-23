export const version = 13;
export const description = 'ReviewLogs: move to the progress store, re-keyed by card_hash';

const CARRIED = [
    'account_id', 'timestamp', 'outcome', 'ease_factor', 'level', 'algorithm', 'rating',
    'fsrs_stability', 'fsrs_difficulty', 'fsrs_due', 'fsrs_state',
    'session_id', 'session_position', 'prev_distance', 'nearest_sibling_lag',
];

export async function shouldRun(db) {
    const row = await db.prepare(
        "SELECT name FROM main.sqlite_master WHERE type='table' AND name='ReviewLogs'",
    ).get();
    return !!row;
}

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
