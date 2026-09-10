// validators/database.js
import db from "./../../access/primitives/database.js";
import SchemaSQL from "../defaults/SchemaSQL.js";
import {
  connectionTypes,
  nodeTypes,
  pedagogicalCategories,
} from "../defaults/DefaultData.js";
import runMigrations from "../MigrationRunner.js";

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
  "Decks",
  "DeckEntries",
];

/**
 * Checks if a table with the given name exists in the database.
 *
 * @param {string} name The name of the table to check.
 * @returns {boolean} True if the table exists, false otherwise.
 */
async function tableExists(name) {
  const row = await db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(name);
  return !!row;
}

/** Performs the core database schema and default data initialization. */
async function performRebuild() {
  try {
    const cleanSchema = SchemaSQL.replace(/BEGIN TRANSACTION;|COMMIT;/g, "");
    await db.exec(cleanSchema);

    const insertConnectionType = db.prepare(
      "INSERT OR IGNORE INTO ConnectionTypes (name, is_directed) VALUES (?, ?)",
    );
    for (const ct of connectionTypes) {
      await insertConnectionType.run(ct.name, ct.is_directed);
    }

    const insertNodeType = db.prepare(
      "INSERT OR IGNORE INTO NodeTypes (name) VALUES (?)",
    );
    for (const nt of nodeTypes) {
      await insertNodeType.run(nt);
    }

    const insertCategory = db.prepare(
      "INSERT OR IGNORE INTO PedagogicalCategories (name, priority, description) VALUES (?, ?, ?)",
    );
    for (const cat of pedagogicalCategories) {
      await insertCategory.run(cat.name, cat.priority, cat.description);
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
 *
 * @returns {boolean} True if the database was rebuilt and initialized successfully.
 */
async function rebuildDatabase() {
  return await db.transaction(async () => await performRebuild())();
}

/**
 * Validates the database by performing a quick integrity check and checking for the presence of all required tables.
 *
 * @returns {boolean} True if the database is valid or was successfully repaired.
 */
async function validateDatabase() {
  const handleRebuild = async () => {
    // @ts-ignore — inTransaction is a valid better-sqlite3 property, missing from bundled types
    if (db.inTransaction) {
      return await performRebuild();
    }
    return await rebuildDatabase();
  };

  try {
    const integrity = await db.prepare("PRAGMA integrity_check").get();
    if (integrity.integrity_check !== "ok") {
      console.error("DB integrity check failed:", integrity.integrity_check);
      return await handleRebuild();
    }

    for (const table of requiredTables) {
      if (!await tableExists(table)) {
        return await handleRebuild();
      }
    }

    return true;
  } catch (err) {
    console.error(
      "Database validation failed, attempting rebuild:",
      err.message,
    );
    try {
      return await handleRebuild();
    } catch (rebuildErr) {
      console.error("Database rebuild failed:", rebuildErr.message);
      return false;
    }
  }
}

async function validateDatabaseWithMigrations() {
  const ok = await validateDatabase();
  if (ok) {
    try {
      await runMigrations(db);
    } catch (err) {
      console.error('Migration runner failed:', err.message);
      throw err;
    }
  }
  return ok;
}

export default validateDatabaseWithMigrations;
