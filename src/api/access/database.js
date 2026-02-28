import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

function getDatabase() {
    const dataPath = process.env.USER_DATA_PATH || "data";

    if (!fs.existsSync(dataPath)) {
        fs.mkdirSync(dataPath, { recursive: true });
    }

    const db = new Database(path.join(dataPath, "dreams.db"));
    db.pragma("journal_mode = WAL");
    return db;
}

const db = getDatabase();
export default db;
