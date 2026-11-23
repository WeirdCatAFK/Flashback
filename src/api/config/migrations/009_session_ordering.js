export const version = 9;
export const description = 'ReviewLogs: session ordering telemetry (session_id, position, distances)';

const COLUMNS = [
    ['session_id', 'TEXT'],
    ['session_position', 'INTEGER'],
    ['prev_distance', 'INTEGER'],
    ['nearest_sibling_lag', 'INTEGER'],
];

async function existingColumns(db) {
    return (await db.prepare("PRAGMA table_info('ReviewLogs')").all()).map(c => c.name);
}

export async function shouldRun(db) {
    const cols = await existingColumns(db);
    return COLUMNS.some(([name]) => !cols.includes(name));
}

export async function up(db) {
    const cols = await existingColumns(db);
    for (const [name, type] of COLUMNS) {
        if (!cols.includes(name)) {
            await db.prepare(`ALTER TABLE ReviewLogs ADD COLUMN ${name} ${type}`).run();
        }
    }

    await db.exec('CREATE INDEX IF NOT EXISTS idx_reviewlogs_session ON ReviewLogs (session_id)');
}
