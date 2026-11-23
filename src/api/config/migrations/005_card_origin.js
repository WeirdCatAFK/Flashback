export const version = 5;
export const description = 'Flashcard provenance: ensure Flashcards.origin column exists';

export async function up(db) {
    const cols = (await db.prepare("PRAGMA table_info('Flashcards')").all()).map(c => c.name);
    if (!cols.includes('origin')) {
        await db.prepare('ALTER TABLE Flashcards ADD COLUMN origin TEXT').run();
    }
}
