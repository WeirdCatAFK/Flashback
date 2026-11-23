export const version = 8;
export const description = 'type_answer: FlashcardContent.answerText + CanonicalVersion table';

export async function shouldRun(db) {
    const hasTable = await db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name = 'CanonicalVersion'"
    ).get();
    const cols = (await db.prepare("PRAGMA table_info('FlashcardContent')").all()).map(c => c.name);
    return !hasTable || !cols.includes('answerText');
}

export async function up(db) {
    const cols = (await db.prepare("PRAGMA table_info('FlashcardContent')").all()).map(c => c.name);
    if (!cols.includes('answerText')) {
        await db.prepare('ALTER TABLE FlashcardContent ADD COLUMN answerText TEXT').run();
    }

    await db.exec(`CREATE TABLE IF NOT EXISTS CanonicalVersion (
        version     INTEGER PRIMARY KEY,
        applied_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        description TEXT
    )`);

    await db.prepare(`
        UPDATE FlashcardContent
           SET answerText = backText,
               backText   = NULL
         WHERE answerText IS NULL
           AND id IN (SELECT content_id FROM Flashcards WHERE card_type = 'type_answer')
    `).run();
}
