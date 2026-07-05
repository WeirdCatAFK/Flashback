import BetterSQLite from "better-sqlite3";
import path from "path";
import fs from "fs";
import { getDatabasePath } from "./config.js";

function getDatabase() {
    const dbPath = getDatabasePath();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new BetterSQLite(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    return db;
}

const db = getDatabase();
export default db;
