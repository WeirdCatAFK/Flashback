// Migration 006 — Record which scheduler produced each review
//
// The active SRS algorithm is a browser preference (localStorage `fb-srs-algorithm`),
// so the API process has never known it. Anything server-side that needs it — the Stats
// view when queried without a param, and every MCP tool, which has no localStorage at
// all — fell back to a hardcoded 'leitner' and then reported that back as if it were a
// fact about the vault. A user reviewing with FSRS was told they use Leitner.
//
// ReviewLogs already carried a partial trace (only FSRS writes `rating`), but Leitner
// and SM-2 are indistinguishable there: the Trainer computes and posts an `ease_factor`
// for both. Recording the algorithm per review makes the answer exact and keeps the
// review log honest about how each schedule was actually produced.
//
// No backfill: pre-existing rows keep NULL, and srs.detectAlgorithm() falls back to the
// `rating`-based heuristic for them, which is exactly as much as those rows can tell us.

export const version = 6;
export const description = 'ReviewLogs.algorithm: record the scheduler each review was graded with';

export async function up(db) {
    const cols = (await db.prepare("PRAGMA table_info('ReviewLogs')").all()).map(c => c.name);
    if (!cols.includes('algorithm')) {
        await db.prepare('ALTER TABLE ReviewLogs ADD COLUMN algorithm TEXT').run();
    }
}
