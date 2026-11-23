export const version = 6;
export const description = 'ReviewLogs.algorithm: record the scheduler each review was graded with';

export async function up(db) {
    const cols = (await db.prepare("PRAGMA table_info('ReviewLogs')").all()).map(c => c.name);
    if (!cols.includes('algorithm')) {
        await db.prepare('ALTER TABLE ReviewLogs ADD COLUMN algorithm TEXT').run();
    }
}
