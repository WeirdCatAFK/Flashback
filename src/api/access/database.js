import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const dataPath = process.env.USER_DATA_PATH || "data";

if (!fs.existsSync(dataPath)) {
    fs.mkdirSync(dataPath, { recursive: true });
}

const db = new Database(path.join(dataPath, "brain.db"));

db.pragma("journal_mode = WAL");

export default db;
