// Migration 001 — Pre-beta schema changes
//
// Covers all additive changes made during pre-beta development that were not
// present in the original SchemaSQL.js baseline. Register this migration in
// MigrationRunner.js before the first beta release so that any database
// created during development is upgraded automatically.
//
// Safe to run against any database state: every operation uses IF NOT EXISTS /
// existence checks so there is no risk of double-applying.

export const version = 1;
export const description = 'Pre-beta schema changes: card columns, Highlights, indexes, Deck nodes';

export function up(db) {

    // ── Flashcards: new columns ───────────────────────────────────────────────

    const flashcardCols = db.prepare("PRAGMA table_info('Flashcards')").all().map(c => c.name);

    if (!flashcardCols.includes('card_type')) {
        db.prepare(
            "ALTER TABLE Flashcards ADD COLUMN card_type TEXT NOT NULL DEFAULT 'basic'"
        ).run();
    }

    if (!flashcardCols.includes('sm2_reps')) {
        db.prepare(
            "ALTER TABLE Flashcards ADD COLUMN sm2_reps INTEGER NOT NULL DEFAULT 0"
        ).run();
    }

    // ── Highlights table ──────────────────────────────────────────────────────

    db.exec(`CREATE TABLE IF NOT EXISTS Highlights (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id INTEGER REFERENCES Documents(id) ON DELETE CASCADE,
        global_hash TEXT NOT NULL UNIQUE,
        type        TEXT NOT NULL DEFAULT 'text_offset',
        start       REAL,
        end         REAL,
        page        INTEGER,
        bbox        TEXT,
        color       TEXT NOT NULL DEFAULT 'amber',
        note        TEXT,
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_highlights_global_hash ON Highlights(global_hash)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_highlights_document_id ON Highlights(document_id)');

    // ── Performance indexes ───────────────────────────────────────────────────

    const indexes = [
        'CREATE INDEX IF NOT EXISTS idx_folders_parent_id ON Folders(parent_id)',
        'CREATE INDEX IF NOT EXISTS idx_folders_absolute_path ON Folders(absolute_path)',
        'CREATE INDEX IF NOT EXISTS idx_documents_folder_id ON Documents(folder_id)',
        'CREATE INDEX IF NOT EXISTS idx_documents_absolute_path ON Documents(absolute_path)',
        'CREATE INDEX IF NOT EXISTS idx_flashcards_document_id ON Flashcards(document_id)',
        'CREATE INDEX IF NOT EXISTS idx_media_absolute_path ON Media(absolute_path)',
    ];
    for (const ddl of indexes) {
        db.exec(ddl);
    }

    // ── Deck nodes ────────────────────────────────────────────────────────────

    // Add 'Deck' node type if missing
    db.prepare(`
        INSERT INTO NodeTypes (name)
        SELECT 'Deck' WHERE NOT EXISTS (SELECT 1 FROM NodeTypes WHERE name = 'Deck')
    `).run();

    // Add 'deck' connection type if missing
    db.prepare(`
        INSERT INTO ConnectionTypes (name, is_directed)
        SELECT 'deck', 0 WHERE NOT EXISTS (SELECT 1 FROM ConnectionTypes WHERE name = 'deck')
    `).run();

    // Add node_id column to Decks if missing
    const deckCols = db.prepare("PRAGMA table_info('Decks')").all().map(c => c.name);
    if (!deckCols.includes('node_id')) {
        db.prepare("ALTER TABLE Decks ADD COLUMN node_id INTEGER REFERENCES Nodes(id)").run();
    }

    // Add delete trigger for deck nodes if missing
    db.exec(`
        CREATE TRIGGER IF NOT EXISTS delete_deck_node
        AFTER DELETE ON Decks
        BEGIN
            DELETE FROM Nodes WHERE id = OLD.node_id;
        END
    `);

    // Backfill: create a Node row for every existing deck that lacks one
    const deckNodeTypeId = db.prepare("SELECT id FROM NodeTypes WHERE name = 'Deck'").get()?.id;
    const deckConnTypeId = db.prepare("SELECT id FROM ConnectionTypes WHERE name = 'deck'").get()?.id;

    if (deckNodeTypeId) {
        const insertNode = db.prepare("INSERT INTO Nodes (type_id) VALUES (?)");
        const updateDeck = db.prepare("UPDATE Decks SET node_id = ? WHERE id = ?");

        for (const deck of db.prepare("SELECT id FROM Decks WHERE node_id IS NULL").all()) {
            const { lastInsertRowid } = insertNode.run(deckNodeTypeId);
            updateDeck.run(lastInsertRowid, deck.id);
        }
    }

    // Backfill: create deck↔flashcard Connections for existing deck entries
    if (deckConnTypeId) {
        const insertConn = db.prepare(
            "INSERT INTO Connections (origin_id, destiny_id, type_id) VALUES (?, ?, ?)"
        );
        const entries = db.prepare(`
            SELECT d.node_id AS deck_node_id, f.node_id AS card_node_id
            FROM DeckEntries de
            JOIN Decks d ON de.deck_id = d.id
            JOIN Flashcards f ON f.global_hash = de.card_hash
            WHERE d.node_id IS NOT NULL
              AND f.node_id IS NOT NULL
              AND NOT EXISTS (
                  SELECT 1 FROM Connections
                  WHERE origin_id = d.node_id
                    AND destiny_id = f.node_id
                    AND type_id = ?
              )
        `).all(deckConnTypeId);

        for (const e of entries) {
            insertConn.run(e.deck_node_id, e.card_node_id, deckConnTypeId);
        }
    }
}
