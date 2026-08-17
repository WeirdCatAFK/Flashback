// Migration 004 — FSRS scheduler
//
// Adds FSRS-6 per-card state to Flashcards, a per-review state snapshot + the
// real 1–4 rating to ReviewLogs, and the FsrsParameters table that holds the
// vault's active weight vector. Purely additive — existing Leitner/SM-2 data is
// untouched, and vaults only populate these columns once a user opts into FSRS.
//
// Safe to re-run: every column add is guarded by a PRAGMA table_info check and
// the table uses CREATE TABLE IF NOT EXISTS.

export const version = 4;
export const description = 'FSRS scheduler: card state columns, review snapshot, FsrsParameters';

export async function shouldRun(db) {
    const cols = (await db.prepare("PRAGMA table_info('Flashcards')").all()).map(c => c.name);
    const hasTable = await db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='FsrsParameters'"
    ).get();
    return !cols.includes('fsrs_stability') || !hasTable;
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

    // ── Flashcards: FSRS per-card state ───────────────────────────────────────
    await addColumns('Flashcards', [
        ['fsrs_stability', 'fsrs_stability FLOAT'],
        ['fsrs_difficulty', 'fsrs_difficulty FLOAT'],
        ['fsrs_due', 'fsrs_due TIMESTAMP'],
        ['fsrs_state', 'fsrs_state INTEGER NOT NULL DEFAULT 0'],
        ['fsrs_reps', 'fsrs_reps INTEGER NOT NULL DEFAULT 0'],
        ['fsrs_lapses', 'fsrs_lapses INTEGER NOT NULL DEFAULT 0'],
    ]);

    // ── ReviewLogs: real rating + post-review FSRS snapshot ───────────────────
    await addColumns('ReviewLogs', [
        ['rating', 'rating INTEGER'],
        ['fsrs_stability', 'fsrs_stability FLOAT'],
        ['fsrs_difficulty', 'fsrs_difficulty FLOAT'],
        ['fsrs_due', 'fsrs_due TIMESTAMP'],
        ['fsrs_state', 'fsrs_state INTEGER'],
    ]);

    // ── FsrsParameters: active weight vector for the vault ────────────────────
    await db.exec(`CREATE TABLE IF NOT EXISTS FsrsParameters (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        weights_json TEXT NOT NULL,
        optimized_at TIMESTAMP,
        review_count INTEGER
    )`);
}
