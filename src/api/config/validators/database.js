// validators/database.js
import db from "./../../access/database.js";
import SchemaSQL from '../defaults/SchemaSQL.js';
import { connectionTypes, nodeTypes, pedagogicalCategories } from '../defaults/DefaultData.js';

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
];

/**
 * Checks if a table with the given name exists in the database.
 * @param {string} name The name of the table to check.
 * @returns {boolean} True if the table exists, false otherwise.
 */
function tableExists(name) {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name = ?"
  ).get(name);
  return !!row;
}

/**
 * Rebuilds the database schema and populates default data in a single transaction.
 * @returns {boolean} True if the database was rebuilt and initialized successfully.
 */
const rebuildDatabase = db.transaction(() => {
  console.warn("Rebuilding database from schema...");
  try {
    db.exec(SchemaSQL);

    const insertConnectionType = db.prepare('INSERT OR IGNORE INTO ConnectionTypes (name, is_directed) VALUES (?, ?)');
    for (const ct of connectionTypes) {
      insertConnectionType.run(ct.name, ct.is_directed);
    }

    const insertNodeType = db.prepare('INSERT OR IGNORE INTO NodeTypes (name) VALUES (?)');
    for (const nt of nodeTypes) {
      insertNodeType.run(nt);
    }

    const insertCategory = db.prepare('INSERT OR IGNORE INTO PedagogicalCategories (name, priority, description) VALUES (?, ?, ?)');
    for (const cat of pedagogicalCategories) {
      insertCategory.run(cat.name, cat.priority, cat.description);
    }

    console.log("Database schema and default data initialized successfully.");
    return true;
  } catch (err) {
    console.error("Critical error during database rebuild:", err);
    throw err; // Transaction will rollback automatically
  }
});

/**
 * Validates the database by performing a quick integrity check and
 * checking for the presence of all required tables. If any
 * errors are found, the database is rebuilt from the schema and
 * default data is inserted.
 * @returns {boolean} True if the database is valid or was successfully repaired.
 */
function validateDatabase() {
  try {
    const integrity = db.prepare("PRAGMA integrity_check").get();
    if (integrity.integrity_check !== "ok") {
      console.error("DB integrity check failed:", integrity.integrity_check);
      return rebuildDatabase();
    }

    for (const table of requiredTables) {
      if (!tableExists(table)) {
        console.warn(`Database missing required table: ${table}. Attempting repair...`);
        return rebuildDatabase();
      }
    }

    return true;
  } catch (err) {
    console.error("Database validation failed, attempting rebuild:", err.message);
    try {
      return rebuildDatabase();
    } catch (rebuildErr) {
      return false;
    }
  }
}

export default validateDatabase;

