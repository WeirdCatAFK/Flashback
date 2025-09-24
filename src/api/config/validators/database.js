// validators/database.js
import db from "./../../access/database.js";
import SchemaSQL from '../init/SchemaSQL.js';

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
  try {
    db.exec(SchemaSQL);
  } catch (err) {
    console.error("Error rebuilding database:", err);
    return false;
  }
  console.log("Inserting default data...");
  try {
    // I know It's not the cleanest way to do this, but it works
    db.prepare('INSERT INTO ConnectionTypes (name, is_directed) VALUES ( ?, ? )').run("disconection", "false");
    db.prepare('INSERT INTO ConnectionTypes (name, is_directed) VALUES ( ?, ? )').run("inherited", "true");

    db.prepare('INSERT INTO NodeTypes (name) VALUES ( ? )').run("Flashcard");
    db.prepare('INSERT INTO NodeTypes (name) VALUES ( ? )').run("Folder");
    db.prepare('INSERT INTO NodeTypes (name) VALUES ( ? )').run("Document");
    db.prepare('INSERT INTO NodeTypes (name) VALUES ( ? )').run("Tag");
  } catch (err) {
    console.error("Error inserting default data:", err);
    return false;
  }
  console.log("Default data inserted.");
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

    return true;
  } catch (err) {
    console.error("Validation error:", err);
    rebuildDatabase();
    return false;
  }
}

export default validateDatabase;
