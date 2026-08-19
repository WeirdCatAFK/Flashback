// Migration 010 — Spaced-repetition progress becomes a property of a PERSON
//
// Until now a card's schedule lived on the card: Flashcards.level, sm2_reps, last_recall and
// the six fsrs_* columns, one set per card and therefore one set for the whole vault. That is
// exactly right for a single-user desktop app and unusable the moment two people study one
// vault — they would grade each other's cards.
//
// This migration moves those nine columns into CardProgress, one row per (card, person), and
// stamps an owner onto the four other tables that were implicitly single-user: ReviewLogs,
// CardHealth, CardFlags and FsrsParameters.
//
// THE OWNER SENTINEL
//
// The scope column holds an account id from the accounts store, or the literal 'owner'.
// 'owner' means the vault's Author, and it is deliberately not their account id. Accounts
// live in {baseDir}/accounts.db — a different file, outside every vault, so that a copied
// vault carries no access list. Writing the Author's uuid in here would orphan every row of
// owner progress the moment someone copied the vault folder to another install. The sentinel
// survives that copy and means "whoever owns these files here", which is the sense the
// `.flashback` sidecar has always carried.
//
// It also keeps this migration pure SQL. Backfilling to a literal needs no account lookup, so
// nothing about the accounts store has to be open, or even to exist, when the vault database
// is migrated — and openVault()'s boot order is untouched.
//
// THIS MIGRATION IS ONE-WAY.
//
// It drops columns that an older build still reads (f.level appears in getDueFlashcards,
// getStatistics and a dozen other statements), so an older build opening a migrated vault
// fails loudly. electron-updater only moves users forward, so CHANGELOG.md carries the
// downgrade warning — that file is the only thing that will tell someone who downgrades on
// purpose. Leaving the columns behind as dead weight was the alternative and is worse: a
// stale column that still reads turns "this query forgot to scope itself" from a hard error
// into one person silently studying another person's schedule.
//
// No canonical counterpart is needed (contrast migration 008, which required canonical update
// 001): the sidecar format does not change. The owner's progress is already stored there in
// exactly these fields, and the owner is precisely whose progress the sidecar holds.

export const version = 10;
export const description = 'Per-account SRS progress: CardProgress + account scope on logs, health, flags and FSRS weights';

const DOOMED_COLUMNS = [
    'level', 'sm2_reps', 'last_recall',
    'fsrs_stability', 'fsrs_difficulty', 'fsrs_due',
    'fsrs_state', 'fsrs_reps', 'fsrs_lapses',
];

async function columns(db, table) {
    return (await db.pragma(`table_info(${table})`)).map(c => c.name);
}

async function hasColumn(db, table, column) {
    return (await columns(db, table)).includes(column);
}

export async function shouldRun(db) {
    const table = await db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name = 'CardProgress'"
    ).get();
    // Either half being unfinished means the vault is mid-migration: the table can exist
    // while Flashcards still carries the columns (a crash between the two halves).
    return !table || await hasColumn(db, 'Flashcards', 'level');
}

export async function up(db) {
    // ---- 1. CardProgress ---------------------------------------------------------
    await db.exec(`CREATE TABLE IF NOT EXISTS CardProgress (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        flashcard_id    INTEGER NOT NULL REFERENCES Flashcards(id) ON DELETE CASCADE,
        account_id      TEXT NOT NULL DEFAULT 'owner',
        level           INTEGER,
        sm2_reps        INTEGER NOT NULL DEFAULT 0,
        last_recall     TIMESTAMP,
        fsrs_stability  FLOAT,
        fsrs_difficulty FLOAT,
        fsrs_due        TIMESTAMP,
        fsrs_state      INTEGER NOT NULL DEFAULT 0,
        fsrs_reps       INTEGER NOT NULL DEFAULT 0,
        fsrs_lapses     INTEGER NOT NULL DEFAULT 0,
        UNIQUE(flashcard_id, account_id)
    )`);
    await db.exec('CREATE INDEX IF NOT EXISTS idx_cardprogress_account ON CardProgress(account_id)');
    await db.exec('CREATE INDEX IF NOT EXISTS idx_cardprogress_last_recall ON CardProgress(last_recall)');

    // ---- 2. Backfill the owner's rows from Flashcards -----------------------------
    // Only cards that actually carry state. A card with nothing but defaults is a card
    // nobody has reviewed, and every read COALESCEs a missing row to exactly those
    // defaults — so skipping it is lossless, and it keeps the table shaped the way new
    // cards will shape it (a row appears on first review, not on creation).
    if (await hasColumn(db, 'Flashcards', 'level')) {
        await db.exec(`
            INSERT OR IGNORE INTO CardProgress
                (flashcard_id, account_id, level, sm2_reps, last_recall,
                 fsrs_stability, fsrs_difficulty, fsrs_due, fsrs_state, fsrs_reps, fsrs_lapses)
            SELECT id, 'owner', level, COALESCE(sm2_reps, 0), last_recall,
                   fsrs_stability, fsrs_difficulty, fsrs_due,
                   COALESCE(fsrs_state, 0), COALESCE(fsrs_reps, 0), COALESCE(fsrs_lapses, 0)
            FROM Flashcards
            WHERE COALESCE(level, 0) <> 0
               OR last_recall IS NOT NULL
               OR COALESCE(sm2_reps, 0) <> 0
               OR fsrs_stability IS NOT NULL
               OR fsrs_due IS NOT NULL
               OR COALESCE(fsrs_state, 0) <> 0
               OR COALESCE(fsrs_reps, 0) <> 0
               OR COALESCE(fsrs_lapses, 0) <> 0
        `);
    }

    // ---- 3. ReviewLogs gains an owner ---------------------------------------------
    if (!await hasColumn(db, 'ReviewLogs', 'account_id')) {
        await db.exec("ALTER TABLE ReviewLogs ADD COLUMN account_id TEXT NOT NULL DEFAULT 'owner'");
    }
    await db.exec('CREATE INDEX IF NOT EXISTS idx_reviewlogs_account ON ReviewLogs(account_id)');

    // ---- 4. FSRS weights become one row per account -------------------------------
    // The weights are a fitted model of one person's forgetting curve; sharing them across
    // accounts would schedule a reader against someone else's memory.
    if (!await hasColumn(db, 'FsrsParameters', 'account_id')) {
        await db.exec("ALTER TABLE FsrsParameters ADD COLUMN account_id TEXT NOT NULL DEFAULT 'owner'");
    }
    // The old setter deleted every row before inserting, so there is at most one — but a
    // unique index that failed to build would abort the whole migration, so make sure.
    await db.exec(`DELETE FROM FsrsParameters
                   WHERE id NOT IN (SELECT MAX(id) FROM FsrsParameters GROUP BY account_id)`);
    await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_fsrsparameters_account ON FsrsParameters(account_id)');

    // ---- 5. CardHealth and CardFlags: rebuilt, not altered -------------------------
    // Both need their UNIQUE constraint widened, and a UNIQUE declared inline in a CREATE
    // TABLE is backed by an sqlite_autoindex that DROP INDEX cannot touch. Vaults carry one
    // of two lineages here — migration 007's raw DDL (inline UNIQUE, autoindex) or
    // SchemaSQL's knex output (a named unique index) — so rebuilding is both the only option
    // that works for the first and the only one that leaves the two identical afterwards.
    // Nothing holds a foreign key pointing AT these tables, so dropping them is safe.
    await db.exec(`CREATE TABLE CardHealth_new (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        flashcard_id        INTEGER NOT NULL REFERENCES Flashcards(id) ON DELETE CASCADE,
        account_id          TEXT NOT NULL DEFAULT 'owner',
        epoch_at            TIMESTAMP,
        epoch_reason        TEXT,
        content_fingerprint TEXT,
        updated_at          TIMESTAMP,
        UNIQUE(flashcard_id, account_id)
    )`);
    await db.exec(`INSERT INTO CardHealth_new
        (id, flashcard_id, account_id, epoch_at, epoch_reason, content_fingerprint, updated_at)
        SELECT id, flashcard_id, 'owner', epoch_at, epoch_reason, content_fingerprint, updated_at
        FROM CardHealth`);
    await db.exec('DROP TABLE CardHealth');
    await db.exec('ALTER TABLE CardHealth_new RENAME TO CardHealth');
    await db.exec('CREATE INDEX IF NOT EXISTS idx_cardhealth_flashcard ON CardHealth(flashcard_id)');

    await db.exec(`CREATE TABLE CardFlags_new (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        flashcard_id       INTEGER NOT NULL REFERENCES Flashcards(id) ON DELETE CASCADE,
        account_id         TEXT NOT NULL DEFAULT 'owner',
        kind               TEXT NOT NULL,
        confidence         TEXT NOT NULL,
        score              FLOAT,
        evidence_json      TEXT,
        level_at_detection INTEGER,
        detected_at        TIMESTAMP,
        review_log_id      INTEGER,
        dismissed_at       TIMESTAMP,
        UNIQUE(flashcard_id, account_id, kind)
    )`);
    await db.exec(`INSERT INTO CardFlags_new
        (id, flashcard_id, account_id, kind, confidence, score, evidence_json,
         level_at_detection, detected_at, review_log_id, dismissed_at)
        SELECT id, flashcard_id, 'owner', kind, confidence, score, evidence_json,
               level_at_detection, detected_at, review_log_id, dismissed_at
        FROM CardFlags`);
    await db.exec('DROP TABLE CardFlags');
    await db.exec('ALTER TABLE CardFlags_new RENAME TO CardFlags');
    await db.exec('CREATE INDEX IF NOT EXISTS idx_cardflags_flashcard ON CardFlags(flashcard_id)');
    await db.exec('CREATE INDEX IF NOT EXISTS idx_cardflags_kind ON CardFlags(kind)');

    // ---- 6. Drop the nine columns off Flashcards ----------------------------------
    // SQLite refuses to drop a column that any index mentions, so the indexes go first.
    // Read them out of sqlite_master rather than naming them: which ones exist depends on
    // whether this vault's Flashcards table came from SchemaSQL or from migration 001.
    const indexes = await db.prepare(
        "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='Flashcards' AND sql IS NOT NULL"
    ).all();
    for (const idx of indexes) {
        if (DOOMED_COLUMNS.some(c => new RegExp(`\\b${c}\\b`).test(idx.sql))) {
            await db.exec(`DROP INDEX IF EXISTS "${idx.name}"`);
        }
    }

    const present = await columns(db, 'Flashcards');
    for (const column of DOOMED_COLUMNS) {
        if (present.includes(column)) {
            await db.exec(`ALTER TABLE Flashcards DROP COLUMN ${column}`);
        }
    }
}
