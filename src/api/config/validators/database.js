// validators/database.js
import db from "./../../access/database.js";
import SchemaSQL from '../init/SchemaSQL.js';

// List of required tables
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

function tableExists(name) {
  const stmt = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name = ?"
  );
  const row = stmt.get(name);
  return !!row;
}

function rebuildDatabase() {
  console.warn("Rebuilding database from schema...");
  db.exec(SchemaSQL);
}

function validateDatabase() {
  try {
    // quick integrity check
    const integrity = db.prepare("PRAGMA integrity_check").get();
    if (integrity.integrity_check !== "ok") {
      console.error("DB integrity check failed");
      rebuildDatabase();
      return false;
    }

    // check required tables
    for (const table of requiredTables) {
      if (!tableExists(table)) {
        console.error(`Missing table: ${table}`);
        rebuildDatabase();
        return false;
      }
    }

    return true; // DB operational
  } catch (err) {
    console.error("Validation error:", err);
    rebuildDatabase();
    return false;
  }
}

export default validateDatabase;
