import { listAccountProgress } from '../../access/primitives/accounts.js';
import { getVaultId } from '../../access/primitives/vault.js';

export const version = 15;
export const description = 'CardProgress: move to the progress store and absorb accounts.db AccountProgress';

const CARRIED = [
    'level', 'sm2_reps', 'last_recall',
    'fsrs_stability', 'fsrs_difficulty', 'fsrs_due',
    'fsrs_state', 'fsrs_reps', 'fsrs_lapses',
];

async function mainHasTable(db, name) {
    return !!await db.prepare(
        "SELECT name FROM main.sqlite_master WHERE type='table' AND name = ?",
    ).get(name);
}

export async function shouldRun(db) {
    return await mainHasTable(db, 'CardProgress');
}

export async function up(db) {
    if (!await mainHasTable(db, 'CardProgress')) return;

    const oldCols = (await db.pragma('main.table_info(CardProgress)')).map((c) => c.name);
    const carried = CARRIED.filter((c) => oldCols.includes(c));

    await db.exec(`
        INSERT OR IGNORE INTO progress.CardProgress (account_id, card_hash, ${carried.join(', ')})
        SELECT cp.account_id, f.global_hash, ${carried.map((c) => `cp.${c}`).join(', ')}
        FROM main.CardProgress cp
        JOIN main.Flashcards f ON f.id = cp.flashcard_id
    `);

    await absorbAccountProgress(db);

    await db.exec('DROP TABLE main.CardProgress');
}

async function absorbAccountProgress(db) {
    let snapshots = [];
    try {
        snapshots = await listAccountProgress(getVaultId());
    } catch {
        return;
    }

    const insert = db.prepare(`
        INSERT OR IGNORE INTO progress.CardProgress
            (account_id, card_hash, ${CARRIED.join(', ')}, updated_at)
        VALUES (?, ?, ${CARRIED.map(() => '?').join(', ')}, ?)
    `);

    const seedEase = db.prepare(`
        INSERT INTO progress.ReviewLogs (card_hash, account_id, timestamp, outcome, ease_factor, level)
        SELECT ?, ?, datetime('now'), NULL, ?, ?
        WHERE NOT EXISTS (
            SELECT 1 FROM progress.ReviewLogs WHERE card_hash = ? AND account_id = ?
        )
    `);

    for (const snap of snapshots) {
        await insert.run(
            snap.account_id, snap.card_hash,
            ...CARRIED.map((c) => snap[c] ?? null),
            snap.updated_at ?? new Date().toISOString(),
        );

        if (snap.ease_factor != null) {
            await seedEase.run(
                snap.card_hash, snap.account_id, snap.ease_factor, snap.level ?? 0,
                snap.card_hash, snap.account_id,
            );
        }
    }
}
