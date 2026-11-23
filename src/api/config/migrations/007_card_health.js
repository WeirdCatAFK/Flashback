export const version = 7;
export const description = 'Card health: CardHealth watermark + CardFlags failure signatures';

async function tableExists(db, name) {
    return (await db.pragma(`table_info(${name})`)).length > 0;
}

export async function shouldRun(db) {
    return !await tableExists(db, 'CardHealth') || !await tableExists(db, 'CardFlags');
}

export async function up(db) {
    if (!await tableExists(db, 'CardHealth')) {
        await db.exec(`CREATE TABLE IF NOT EXISTS CardHealth (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            flashcard_id        INTEGER NOT NULL UNIQUE REFERENCES Flashcards(id) ON DELETE CASCADE,
            epoch_at            TIMESTAMP,
            epoch_reason        TEXT,
            content_fingerprint TEXT,
            updated_at          TIMESTAMP
        )`);
        await db.exec(`CREATE INDEX IF NOT EXISTS idx_cardhealth_flashcard ON CardHealth(flashcard_id)`);
    }

    if (!await tableExists(db, 'CardFlags')) {
        await db.exec(`CREATE TABLE IF NOT EXISTS CardFlags (
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
        await db.exec(`CREATE INDEX IF NOT EXISTS idx_cardflags_flashcard ON CardFlags(flashcard_id)`);
        await db.exec(`CREATE INDEX IF NOT EXISTS idx_cardflags_kind ON CardFlags(kind)`);
    }
}
