// Migration 009 — Session ordering telemetry on ReviewLogs
//
// The trainer now sequences a session's due cards by approximate graph distance
// (access/orchestration/sequencer.js) instead of handing them over in creation order.
// Interleaving deliberately trades within-session accuracy for delayed retention, so
// pass rates are expected to DROP when it turns on. Without a record of how each card
// was presented, that dip is indistinguishable from a regression in the scheduler,
// the classifier, or the content itself — so the ordering context is logged from the
// first session rather than added once someone needs it.
//
// Four columns, all DERIVED and all nullable:
//
//   session_id          — groups the reviews of one trainer session. Generated per
//                         /api/srs/due response, echoed back by the client on each
//                         review. Indexed because nearest_sibling_lag is computed by
//                         reading this session's earlier rows back.
//   session_position    — 0-based index of this review within its session. Reflects
//                         what was ACTUALLY presented, so a card re-queued after a
//                         failed grade occupies two positions, not one.
//   prev_distance       — approximate graph distance (1–4) to the card presented
//                         immediately before. NULL for the first review of a session.
//   nearest_sibling_lag — items since the nearest confusable sibling (same document,
//                         shared tag, or same parent folder) appeared in this session.
//                         NULL when no sibling preceded it.
//
// All four are NULL on pre-migration rows and on reviews submitted outside a trainer
// session (the MCP server grades cards with no session context). Every reader must
// treat NULL as "not recorded", never as a zero distance — a card with no logged
// ordering is not a card that was shown next to its sibling.
//
// No backfill is possible: presentation order was never recorded, and inventing one
// would poison the very measurement these columns exist to make. Existing history
// stays NULL and is excluded from ordering analysis.
//
// ReviewLogs is derived-only — it lives in the database, never in the `.flashback`
// sidecars, and a Vault Doctor rebuild wipes it. So this is the whole change; there is
// no canonical counterpart the way migration 008 needed canonical update 001.

export const version = 9;
export const description = 'ReviewLogs: session ordering telemetry (session_id, position, distances)';

const COLUMNS = [
    ['session_id', 'TEXT'],
    ['session_position', 'INTEGER'],
    ['prev_distance', 'INTEGER'],
    ['nearest_sibling_lag', 'INTEGER'],
];

function existingColumns(db) {
    return db.prepare("PRAGMA table_info('ReviewLogs')").all().map(c => c.name);
}

export function shouldRun(db) {
    const cols = existingColumns(db);
    return COLUMNS.some(([name]) => !cols.includes(name));
}

export function up(db) {
    // Re-read inside up() rather than trusting shouldRun's view: the runner also calls
    // up() for a version that was recorded but whose artifacts went missing, and only
    // some of the four may be absent.
    const cols = existingColumns(db);
    for (const [name, type] of COLUMNS) {
        if (!cols.includes(name)) {
            db.prepare(`ALTER TABLE ReviewLogs ADD COLUMN ${name} ${type}`).run();
        }
    }

    db.exec('CREATE INDEX IF NOT EXISTS idx_reviewlogs_session ON ReviewLogs (session_id)');
}
