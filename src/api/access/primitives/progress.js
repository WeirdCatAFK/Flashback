export const SCHEMA_NAME = "progress";

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

export const REPAIRS = Object.freeze([]);
