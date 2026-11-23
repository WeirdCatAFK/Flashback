export const version = 14;
export const description = 'CardHealth, CardFlags and FsrsParameters: move to the progress store, re-keyed by card_hash';

const MOVED = ['CardHealth', 'CardFlags', 'FsrsParameters'];

const CARRIED = {
    CardHealth: ['account_id', 'epoch_at', 'epoch_reason', 'content_fingerprint', 'updated_at'],
    CardFlags: [
        'account_id', 'kind', 'confidence', 'score', 'evidence_json',
        'level_at_detection', 'detected_at', 'review_log_id', 'dismissed_at',
    ],
    FsrsParameters: ['account_id', 'weights_json', 'optimized_at', 'review_count'],
};

async function mainHasTable(db, name) {
    return !!await db.prepare(
        "SELECT name FROM main.sqlite_master WHERE type='table' AND name = ?",
    ).get(name);
}

export async function shouldRun(db) {
    for (const table of MOVED) {
        if (await mainHasTable(db, table)) return true;
    }
    return false;
}

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
