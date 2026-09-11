/**
 * The PROGRESS store — every person's behavioural record for one vault.
 *
 * The third of the three data classes, and the one the app had no home for. The canonical
 * `.flashback` files are what the user wrote; the vault database is what we computed from
 * them and can compute again; this is what people *did*, which nothing can recompute. It
 * lives at `{vault}/progress.db`, a sibling of `workspace/` — inside the vault so it travels
 * with a copied folder, outside the workspace so Seal never versions it. Recording a review
 * is not editing a document, and a scroll position is not a commit.
 *
 * ## Why this is not a third adapter instance
 *
 * `accounts.js` and `database.js` are two instances of `sqliteAdapter.js` and must stay that
 * way — see that factory's header. This store is deliberately NOT a third one. It is
 * ATTACHed to the vault connection as the schema `progress`, so the five tables below join
 * against `Flashcards` in single statements and every write lands on ONE queue inside the
 * caller's existing transaction. That is what removes `srs.js`'s cross-store mirror: a JS
 * throw now rolls back the vault write and the progress write together.
 *
 * It buys serialization and joins, NOT crash atomicity. In WAL mode SQLite commits each
 * attached file separately — atomic per file, not across the set — so a host crash mid-COMMIT
 * can land one and not the other. The safety argument is the direction of the dependency, not
 * a guarantee: the review path READS `main` and WRITES `progress`, so the only reachable skew
 * is "progress landed, the index did not", which the Doctor repairs. Do not write "atomic"
 * here; someone will build on it.
 *
 * ## Two rules this schema cannot state in SQL
 *
 * Keyed by `card_hash` — a card's `globalHash` — and never by `flashcard_id`, for the reason
 * `accounts.js` already gives about `AccountProgress`: a Doctor rebuild reassigns every row id
 * in the vault database and only the hash survives it. After the sidecars stop carrying
 * progress there is no second copy to re-derive from, so an id key would silently zero
 * everyone's history on the next rebuild. The id↔hash mapping stays where it belongs, in the
 * disposable store, as `Flashcards.global_hash`.
 *
 * And no `REFERENCES` clause appears below, deliberately. Foreign keys may not cross a schema
 * boundary: `REFERENCES Flashcards(id)` written here resolves against `progress.Flashcards`,
 * which does not exist. SQLite resolves parent tables lazily, so such a constraint is accepted
 * at CREATE and then fails on every INSERT with `no such table: progress.Flashcards` — a
 * landmine rather than an error. Card deletion cascades by hand instead; see
 * `query.deleteFlashcard`, which must purge for a user-initiated delete and must NOT purge for
 * sidecar reconciliation.
 *
 * Every statement is schema-qualified. An unqualified `CREATE TABLE` here would silently
 * create the table in `main`, and an empty table in `main` SHADOWS the real one for every
 * unqualified read — no error, just wrong answers.
 */

/** Schema name the vault connection attaches this store under. */
export const SCHEMA_NAME = "progress";

/**
 * Tables that must exist ONLY in this store. `validators/database.js` asserts `main` holds
 * none of them: an empty shadow in `main` wins every unqualified lookup, silently.
 */
export const PROGRESS_TABLES = Object.freeze([
    "CardProgress",
    "ReviewLogs",
    "CardHealth",
    "CardFlags",
    "FsrsParameters",
    "ReadProgress",
]);

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS progress.CardProgress (
    account_id      TEXT NOT NULL DEFAULT 'owner',
    card_hash       TEXT NOT NULL,
    level           INTEGER,
    sm2_reps        INTEGER NOT NULL DEFAULT 0,
    last_recall     TEXT,
    fsrs_stability  REAL,
    fsrs_difficulty REAL,
    fsrs_due        TEXT,
    fsrs_state      INTEGER NOT NULL DEFAULT 0,
    fsrs_reps       INTEGER NOT NULL DEFAULT 0,
    fsrs_lapses     INTEGER NOT NULL DEFAULT 0,
    updated_at      TEXT,
    PRIMARY KEY (account_id, card_hash)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS progress.idx_cardprogress_last_recall ON CardProgress(last_recall);
CREATE INDEX IF NOT EXISTS progress.idx_cardprogress_due ON CardProgress(account_id, fsrs_due);

CREATE TABLE IF NOT EXISTS progress.ReviewLogs (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id           TEXT NOT NULL DEFAULT 'owner',
    card_hash            TEXT NOT NULL,
    timestamp            TEXT,
    outcome              INTEGER,
    ease_factor          REAL,
    level                INTEGER,
    algorithm            TEXT,
    rating               INTEGER,
    fsrs_stability       REAL,
    fsrs_difficulty      REAL,
    fsrs_due             TEXT,
    fsrs_state           INTEGER,
    session_id           TEXT,
    session_position     INTEGER,
    prev_distance        INTEGER,
    nearest_sibling_lag  INTEGER
);
CREATE INDEX IF NOT EXISTS progress.idx_reviewlogs_account_card ON ReviewLogs(account_id, card_hash);
CREATE INDEX IF NOT EXISTS progress.idx_reviewlogs_timestamp ON ReviewLogs(timestamp);
CREATE INDEX IF NOT EXISTS progress.idx_reviewlogs_session ON ReviewLogs(session_id);

CREATE TABLE IF NOT EXISTS progress.CardHealth (
    account_id          TEXT NOT NULL DEFAULT 'owner',
    card_hash           TEXT NOT NULL,
    epoch_at            TEXT,
    epoch_reason        TEXT,
    content_fingerprint TEXT,
    updated_at          TEXT,
    PRIMARY KEY (account_id, card_hash)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS progress.CardFlags (
    account_id         TEXT NOT NULL DEFAULT 'owner',
    card_hash          TEXT NOT NULL,
    kind               TEXT NOT NULL,
    confidence         TEXT NOT NULL,
    score              REAL,
    evidence_json      TEXT,
    level_at_detection INTEGER,
    detected_at        TEXT,
    review_log_id      INTEGER,
    dismissed_at       TEXT,
    PRIMARY KEY (account_id, card_hash, kind)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS progress.idx_cardflags_kind ON CardFlags(kind);

CREATE TABLE IF NOT EXISTS progress.FsrsParameters (
    account_id    TEXT NOT NULL,
    weights_json  TEXT NOT NULL,
    optimized_at  TEXT,
    review_count  INTEGER,
    PRIMARY KEY (account_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS progress.ReadProgress (
    account_id  TEXT NOT NULL,
    doc_hash    TEXT NOT NULL,
    unit        TEXT NOT NULL,
    total       REAL,
    pos         TEXT NOT NULL,
    pos_pct     REAL,
    far         TEXT NOT NULL,
    far_pct     REAL,
    body_etag   TEXT,
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (account_id, doc_hash)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS progress.idx_readprogress_account ON ReadProgress(account_id, updated_at);

CREATE TABLE IF NOT EXISTS progress.ProgressSchemaVersion (
    version     INTEGER PRIMARY KEY,
    applied_at  TEXT NOT NULL
);
`;

/**
 * Repairs recorded against `ProgressSchemaVersion`, applied in order after `SCHEMA`.
 *
 * The counterpart of `accounts.js`'s `REPAIRS`, and separate from both `SchemaVersion` (the
 * vault database's migrations) and `AccountsSchemaVersion`: one version counter must not mean
 * two things. `CREATE TABLE IF NOT EXISTS` can add a table or a column but cannot correct rows
 * that are already wrong, which is what this is for.
 *
 * @type {ReadonlyArray<{version: number, sql: string}>}
 */
export const REPAIRS = Object.freeze([]);
