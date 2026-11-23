export const version = 17;
export const description = 'Flashcards.highlight_hash: the highlight a card was made from';

export async function up(db) {
    const cols = (await db.prepare("PRAGMA table_info('Flashcards')").all()).map((c) => c.name);
    if (!cols.includes('highlight_hash')) {
        await db.prepare('ALTER TABLE Flashcards ADD COLUMN highlight_hash TEXT').run();
    }
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_flashcards_highlight_hash ON Flashcards(highlight_hash)').run();
}
