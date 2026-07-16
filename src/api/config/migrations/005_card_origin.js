// Migration 005 — Flashcard provenance marker
//
// The `origin` column on Flashcards has been part of the SchemaSQL.js baseline
// since the Knex rewrite, but it was never written by any code path. It now
// marks card provenance: 'ai' = created by an AI assistant through the MCP
// server, NULL = human-made (UI, imports). This migration is defensive — it
// guarantees the column exists on any database that predates the Knex baseline.
// No backfill is needed: every pre-existing card is human-made, which NULL
// already encodes.

export const version = 5;
export const description = 'Flashcard provenance: ensure Flashcards.origin column exists';

export function up(db) {
    const cols = db.prepare("PRAGMA table_info('Flashcards')").all().map(c => c.name);
    if (!cols.includes('origin')) {
        db.prepare('ALTER TABLE Flashcards ADD COLUMN origin TEXT').run();
    }
}
