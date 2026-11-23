export const version = 10;
export const description = 'Per-account SRS progress: CardProgress + account scope on logs, health, flags and FSRS weights';

const DOOMED_COLUMNS = [
    'level', 'sm2_reps', 'last_recall',
    'fsrs_stability', 'fsrs_difficulty', 'fsrs_due',
    'fsrs_state', 'fsrs_reps', 'fsrs_lapses',
];

async function tableExists(db, name) {
    return (await db.pragma(`table_info(${name})`)).length > 0;
}

async function mainHasTable(db, name) {
    return !!await db.prepare(
        "SELECT name FROM main.sqlite_master WHERE type='table' AND name = ?",
    ).get(name);
}

async function columns(db, table) {
    return (await db.pragma(`table_info(${table})`)).map(c => c.name);
}

async function hasColumn(db, table, column) {
    return (await columns(db, table)).includes(column);
}

export async function shouldRun(db) {
    const table = await tableExists(db, 'CardProgress');
    return !table || await hasColumn(db, 'Flashcards', 'level');
}

export async function up(db) {
    if (!await tableExists(db, 'CardProgress')) {
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
    }

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

    if (await mainHasTable(db, 'ReviewLogs')) {
        if (!await hasColumn(db, 'ReviewLogs', 'account_id')) {
            await db.exec("ALTER TABLE ReviewLogs ADD COLUMN account_id TEXT NOT NULL DEFAULT 'owner'");
        }
        await db.exec('CREATE INDEX IF NOT EXISTS idx_reviewlogs_account ON ReviewLogs(account_id)');
    }

    if (await mainHasTable(db, 'FsrsParameters')) {
        if (!await hasColumn(db, 'FsrsParameters', 'account_id')) {
            await db.exec("ALTER TABLE FsrsParameters ADD COLUMN account_id TEXT NOT NULL DEFAULT 'owner'");
        }
        await db.exec(`DELETE FROM FsrsParameters
                       WHERE id NOT IN (SELECT MAX(id) FROM FsrsParameters GROUP BY account_id)`);
        await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_fsrsparameters_account ON FsrsParameters(account_id)');
    }

    if (await mainHasTable(db, 'CardHealth')) {
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
    }

    if (await mainHasTable(db, 'CardFlags')) {
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
    }

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
