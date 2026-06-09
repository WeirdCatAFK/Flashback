// validators/database.js
import db from "./../../access/database.js";
import SchemaSQL from "../defaults/SchemaSQL.js";
import {
  connectionTypes,
  nodeTypes,
  pedagogicalCategories,
} from "../defaults/DefaultData.js";

const requiredTables = [
  "Flashcards",
  "FlashcardContent",
  "FlashcardReference",
  "Documents",
  "Folders",
  "PedagogicalCategories",
  "Tags",
  "Connections",
  "Nodes",
  "Media",
  "NodeTypes",
  "ConnectionTypes",
  "InheritedTags",
  "ReviewLogs",
  "Decks",
  "DeckEntries",
];

/**
 * Checks if a table with the given name exists in the database.
 * @param {string} name The name of the table to check.
 * @returns {boolean} True if the table exists, false otherwise.
 */
function tableExists(name) {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(name);
  return !!row;
}

/**
 * Performs the core database schema and default data initialization.
 * This function should NOT start its own transaction.
 */
function performRebuild() {
  try {
    // Remove manual transaction control from schema if present to avoid nested transactions
    const cleanSchema = SchemaSQL.replace(/BEGIN TRANSACTION;|COMMIT;/g, "");
    db.exec(cleanSchema);

    const insertConnectionType = db.prepare(
      "INSERT OR IGNORE INTO ConnectionTypes (name, is_directed) VALUES (?, ?)",
    );
    for (const ct of connectionTypes) {
      insertConnectionType.run(ct.name, ct.is_directed);
    }

    const insertNodeType = db.prepare(
      "INSERT OR IGNORE INTO NodeTypes (name) VALUES (?)",
    );
    for (const nt of nodeTypes) {
      insertNodeType.run(nt);
    }

    const insertCategory = db.prepare(
      "INSERT OR IGNORE INTO PedagogicalCategories (name, priority, description) VALUES (?, ?, ?)",
    );
    for (const cat of pedagogicalCategories) {
      insertCategory.run(cat.name, cat.priority, cat.description);
    }

    console.log("Database schema and default data initialized successfully.");
    return true;
  } catch (err) {
    console.error("Critical error during database rebuild:", err);
    throw err;
  }
}

/**
 * Rebuilds the database schema and populates default data in a single transaction.
 * @returns {boolean} True if the database was rebuilt and initialized successfully.
 */
const rebuildDatabase = db.transaction(() => {
  return performRebuild();
});

/**
 * Validates the database by performing a quick integrity check and
 * checking for the presence of all required tables. If any
 * errors are found, the database is rebuilt from the schema and
 * default data is inserted.
 * @returns {boolean} True if the database is valid or was successfully repaired.
 */
function validateDatabase() {
  const handleRebuild = () => {
    // @ts-ignore — inTransaction is a valid better-sqlite3 property, missing from bundled types
    if (db.inTransaction) {
      return performRebuild();
    }
    return rebuildDatabase();
  };

  try {
    const integrity = db.prepare("PRAGMA integrity_check").get();
    if (integrity.integrity_check !== "ok") {
      console.error("DB integrity check failed:", integrity.integrity_check);
      return handleRebuild();
    }

    for (const table of requiredTables) {
      if (!tableExists(table)) {
        return handleRebuild();
      }
    }

    return true;
  } catch (err) {
    console.error(
      "Database validation failed, attempting rebuild:",
      err.message,
    );
    try {
      return handleRebuild();
    } catch (rebuildErr) {
      return false;
    }
  }
}

function migrateColumns() {
  try {
    const cols = db.prepare("PRAGMA table_info('Flashcards')").all();
    if (!cols.find((c) => c.name === "card_type")) {
      db.prepare(
        "ALTER TABLE Flashcards ADD COLUMN card_type TEXT NOT NULL DEFAULT 'basic'",
      ).run();
      console.log("Migration: added Flashcards.card_type column");
    }
    if (!cols.find((c) => c.name === "sm2_reps")) {
      db.prepare(
        "ALTER TABLE Flashcards ADD COLUMN sm2_reps INTEGER NOT NULL DEFAULT 0",
      ).run();
      console.log("Migration: added Flashcards.sm2_reps column");
    }
  } catch (err) {
    console.warn("Column migration failed (non-fatal):", err.message);
  }

  const indexes = [
    "CREATE INDEX IF NOT EXISTS idx_folders_parent_id ON Folders(parent_id)",
    "CREATE INDEX IF NOT EXISTS idx_folders_absolute_path ON Folders(absolute_path)",
    "CREATE INDEX IF NOT EXISTS idx_documents_folder_id ON Documents(folder_id)",
    "CREATE INDEX IF NOT EXISTS idx_documents_absolute_path ON Documents(absolute_path)",
    "CREATE INDEX IF NOT EXISTS idx_flashcards_document_id ON Flashcards(document_id)",
    "CREATE INDEX IF NOT EXISTS idx_media_absolute_path ON Media(absolute_path)",
  ];
  for (const ddl of indexes) {
    try { db.exec(ddl); } catch (e) { console.warn("Index migration failed (non-fatal):", e.message); }
  }
}

function validateDatabaseWithMigrations() {
  const ok = validateDatabase();
  if (ok) migrateColumns();
  return ok;
}

export default validateDatabaseWithMigrations;
