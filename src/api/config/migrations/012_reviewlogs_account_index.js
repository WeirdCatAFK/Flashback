export const version = 12;
export const description = 'ReviewLogs: composite (account_id, flashcard_id) index instead of account_id alone';

const COMPOSITE = 'idx_reviewlogs_account_card';

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
    if (!cols.includes('account_id')) return false;

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
