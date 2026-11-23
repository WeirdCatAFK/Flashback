export const version = 4;
export const description = 'FSRS scheduler: card state columns, review snapshot, FsrsParameters';

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

    if (!await tableExists(db, 'FsrsParameters')) {
        await db.exec(`CREATE TABLE IF NOT EXISTS FsrsParameters (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            weights_json TEXT NOT NULL,
            optimized_at TIMESTAMP,
            review_count INTEGER
        )`);
    }
}
