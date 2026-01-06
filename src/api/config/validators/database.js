// validators/database.js
import db from "./../../access/database.js";
import SchemaSQL from '../defaults/SchemaSQL.js';

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
  const stmt = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name = ?"
  );
  const row = stmt.get(name);
  return !!row;
}

/**
 * Rebuilds the database from the schema, then inserts default data.
 * @returns {boolean} True if the database was rebuilt and default data was inserted, false otherwise.
 */
function rebuildDatabase() {
  console.warn("Rebuilding database from schema...");
  try {
    db.exec(SchemaSQL);
  } catch (err) {
    console.error("Error rebuilding database:", err);
    return false;
  }
  console.log("Inserting default data...");
  try {
    db.prepare('INSERT INTO ConnectionTypes (name, is_directed) VALUES ( ?, ? )').run("connection", "false");
    db.prepare('INSERT INTO ConnectionTypes (name, is_directed) VALUES ( ?, ? )').run("disconection", "false");
    db.prepare('INSERT INTO ConnectionTypes (name, is_directed) VALUES ( ?, ? )').run("inheritance", "true");
    db.prepare('INSERT INTO ConnectionTypes (name, is_directed) VALUES ( ?, ? )').run("tagging", "false");
    db.prepare('INSERT INTO ConnectionTypes (name, is_directed) VALUES ( ?, ? )').run("reference", "true");

    db.prepare('INSERT INTO NodeTypes (name) VALUES ( ? )').run("Flashcard");
    db.prepare('INSERT INTO NodeTypes (name) VALUES ( ? )').run("Folder");
    db.prepare('INSERT INTO NodeTypes (name) VALUES ( ? )').run("Document");
    db.prepare('INSERT INTO NodeTypes (name) VALUES ( ? )').run("Tag");
    db.prepare('INSERT INTO NodeTypes (name) VALUES ( ? )').run("PedagogicalCategory");

    db.prepare('INSERT INTO PedagogicalCategories (name, priority, description) VALUES ( ?, ? , ?)').run("Definition", 0, "The definition of a word or concept");
    db.prepare('INSERT INTO PedagogicalCategories (name, priority, description) VALUES ( ?, ? , ?)').run("Terminology", 0, "The usage of a word");
    db.prepare('INSERT INTO PedagogicalCategories (name, priority, description) VALUES ( ?, ? , ?)').run("Symbol", 0, "The usage of symbols");

    db.prepare('INSERT INTO PedagogicalCategories (name, priority, description) VALUES ( ?, ? , ?)').run("Concept", 1, "An abstract idea");
    db.prepare('INSERT INTO PedagogicalCategories (name, priority, description) VALUES ( ?, ? , ?)').run("Example", 1, "Examples of usage");

    db.prepare('INSERT INTO PedagogicalCategories (name, priority, description) VALUES ( ?, ? , ?)').run("Exercise", 2, "Apply knowledge in a practical task or problem");
    db.prepare('INSERT INTO PedagogicalCategories (name, priority, description) VALUES ( ?, ? , ?)').run("Procedure", 2, "Execute a method or algorithm step by step");
  } catch (err) {
    console.error("Error inserting default data:", err);
    return false;
  }
  console.log("Default data inserted.");
}

/**
 * Validates the database by performing a quick integrity check and
 * checking for the presence of all required tables. If any
 * errors are found, the database is rebuilt from the schema and
 * default data is inserted.
 * @returns {boolean} True if the database is valid, false otherwise.
 */
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

    return true;
  } catch (err) {
    console.error("Validation error:", err);
    rebuildDatabase();
    return false;
  }
}

export default validateDatabase;
