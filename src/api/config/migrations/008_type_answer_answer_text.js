// Migration 008 — type_answer: split the compared answer out of backText
//
// A type_answer card used to keep its expected answer in `backText`, which is also the
// text its back face renders. That conflation left nowhere to put a mnemonic or an
// explanation: anything added to the back changed what the reviewer's typing was compared
// against. `answerText` is now the compared value and `backText` becomes free prose shown
// after checking.
//
// This is the DERIVED half of the change. The canonical half — rewriting the same split
// into the `.flashback` sidecars and `_decks/*.json` files — cannot run here: it does file
// IO and a Seal commit, neither of which belongs inside the runner's transaction. It is
// canonical update 001 (config/updates/001_type_answer_split.js), run by UpdateRunner at
// startup, and lands on exactly the same end state as the backfill below, so the two layers
// agree either way.
//
// The backfill mirrors the canonical rule: answerText := backText, backText := NULL
// (an empty notes field), for every type_answer card that predates the split. Cards then
// render and grade exactly as they did before.

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

    // The canonical layer's own version ledger. Created here rather than by the update
    // runner so the runner can assume it exists, exactly as MigrationRunner assumes
    // SchemaVersion does.
    await db.exec(`CREATE TABLE IF NOT EXISTS CanonicalVersion (
        version     INTEGER PRIMARY KEY,
        applied_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        description TEXT
    )`);

    // Idempotent: a card whose answerText is already set is left alone, so re-running
    // can never push a migrated answer back into the notes field.
    await db.prepare(`
        UPDATE FlashcardContent
           SET answerText = backText,
               backText   = NULL
         WHERE answerText IS NULL
           AND id IN (SELECT content_id FROM Flashcards WHERE card_type = 'type_answer')
    `).run();
}
