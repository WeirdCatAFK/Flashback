// Migration 002 — Inter-document links
//
// Adds the DocumentLinks queue table and the "link" ConnectionType.
// Safe to run on any existing database: uses IF NOT EXISTS / OR IGNORE guards.

export const version = 2;
export const description = 'Inter-document links: DocumentLinks queue table + link ConnectionType';

export function up(db) {

    // ── DocumentLinks queue ───────────────────────────────────────────────────

    db.exec(`
        CREATE TABLE IF NOT EXISTS DocumentLinks (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            source_hash TEXT NOT NULL,
            target_hash TEXT NOT NULL,
            anchor_text TEXT,
            UNIQUE(source_hash, target_hash)
        )
    `);

    db.exec(`CREATE INDEX IF NOT EXISTS idx_doclinks_source ON DocumentLinks(source_hash)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_doclinks_target ON DocumentLinks(target_hash)`);

    // ── "link" ConnectionType ─────────────────────────────────────────────────

    db.prepare(
        `INSERT OR IGNORE INTO ConnectionTypes (name, is_directed) VALUES ('link', 1)`
    ).run();
}
