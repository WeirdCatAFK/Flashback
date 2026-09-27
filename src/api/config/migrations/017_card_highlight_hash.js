// Migration 017 — Flashcards.highlight_hash: which highlight a card was made from
//
// A card anchored to a highlight has always said so in its sidecar, as
// `vanillaData.location = { type: 'highlight', id }`, but the index kept only the location's
// type (`FlashcardReference.type`), never the id. So nothing but a walk over every sidecar could
// answer "which highlight is this card from?" or "which cards point at a highlight that has
// since been deleted?" — and those became everyday questions once cards made through the MCP
// server had to come from a highlight.
//
// Derived-only, like 009: the sidecar already carries the id, so there is no canonical half and
// nothing for an older build to misread — it never selects the column.
//
// The backfill cannot happen here. The ids live in the sidecars, and a migration gets a database
// handle inside a transaction, not files. `Highlights.backfillCardAnchors()` fills existing rows
// from their sidecars when the vault opens, touching only cards whose reference says they are
// highlight-anchored; every card written from then on carries the id from `insertFlashcard` and
// `updateFlashcard`, and a Vault Doctor rebuild re-derives it with the rest.

export const version = 17;
export const description = 'Flashcards.highlight_hash: the highlight a card was made from';

/** Adds the column when it is missing. */
export async function up(db) {
    const cols = (await db.prepare("PRAGMA table_info('Flashcards')").all()).map((c) => c.name);
    if (!cols.includes('highlight_hash')) {
        await db.prepare('ALTER TABLE Flashcards ADD COLUMN highlight_hash TEXT').run();
    }
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_flashcards_highlight_hash ON Flashcards(highlight_hash)').run();
}
