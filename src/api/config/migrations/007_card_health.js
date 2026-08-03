// Migration 007 — Card health: failure-signature classification
//
// Flashback classifies cards by how they behave under review and flags the ones worth
// acting on. Two cards can have an identical pass rate and need opposite treatment:
// a "mouthful" is badly built and should be split, a "probe" is hard because it forces
// the reviewer to confront a wrong assumption and should be kept. Telling them apart
// needs the derivative (does each relearn cycle end at a longer interval?), not the level.
//
// Two tables, both DERIVED — they hold no user intent that isn't recomputable from
// ReviewLogs plus the card's own content, so they are deliberately absent from the
// canonical `.flashback` sidecars. Writing a flag canonically would mean a Seal commit
// on every failed review, and a Vault Doctor rebuild would have to reconcile a judgement
// rather than a fact.
//
//   CardHealth — one row per evaluated card, holding the *analysis watermark*. A flag is
//   a live judgement, not a permanent scar: once the user addresses a card (edits it, or
//   reviews it back up to strength) the analysis restarts from that moment, so history
//   from before the fix is never evidence against the card that replaced it.
//
//   CardFlags  — the currently-raised flags. UNIQUE(flashcard_id, kind) because a card
//   either currently reads as a mouthful or it doesn't; re-raising refreshes the row's
//   evidence rather than accumulating duplicates. `dismissed_at` keeps a row the user has
//   already ruled on suppressed instead of deleting it, so it doesn't re-announce itself
//   on every subsequent failure.
//
// Both cascade from Flashcards, so deleting a card takes its health state with it and
// `wipeDerivedContent` (Vault Doctor rebuild) clears them for free.
//
// No backfill. Flags are earned from review behaviour; an existing vault starts with none
// and raises its first at the next failing review that clears the confidence gates.

export const version = 7;
export const description = 'Card health: CardHealth watermark + CardFlags failure signatures';

export function shouldRun(db) {
    const has = (name) => db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name = ?"
    ).get(name);
    return !has('CardHealth') || !has('CardFlags');
}

export function up(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS CardHealth (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        flashcard_id        INTEGER NOT NULL UNIQUE REFERENCES Flashcards(id) ON DELETE CASCADE,
        epoch_at            TIMESTAMP,
        epoch_reason        TEXT,
        content_fingerprint TEXT,
        updated_at          TIMESTAMP
    )`);

    db.exec(`CREATE TABLE IF NOT EXISTS CardFlags (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        flashcard_id       INTEGER NOT NULL REFERENCES Flashcards(id) ON DELETE CASCADE,
        kind               TEXT NOT NULL,
        confidence         TEXT NOT NULL,
        score              FLOAT,
        evidence_json      TEXT,
        level_at_detection INTEGER,
        detected_at        TIMESTAMP,
        review_log_id      INTEGER,
        dismissed_at       TIMESTAMP,
        UNIQUE(flashcard_id, kind)
    )`);

    db.exec(`CREATE INDEX IF NOT EXISTS idx_cardhealth_flashcard ON CardHealth(flashcard_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_cardflags_flashcard ON CardFlags(flashcard_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_cardflags_kind ON CardFlags(kind)`);
}
