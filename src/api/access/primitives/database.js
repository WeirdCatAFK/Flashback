/** A stable adapter over a handle that a vault switch replaces. Never call db.prepare() at module scope. */
import fs from "fs";
import path from "path";
import { createSqliteAdapter } from "./sqliteAdapter.js";
import { getDatabasePath, getProgressDatabasePath } from "./config.js";
import { SCHEMA_NAME, SCHEMA, REPAIRS } from "./progress.js";

function applyProgressRepairs(raw) {
    const done = new Set(
        raw.prepare(`SELECT version FROM ${SCHEMA_NAME}.ProgressSchemaVersion`).all().map((r) => r.version),
    );
    for (const repair of REPAIRS) {
        if (done.has(repair.version)) continue;
        raw.exec(repair.sql);
        raw.prepare(`INSERT INTO ${SCHEMA_NAME}.ProgressSchemaVersion (version, applied_at) VALUES (?, ?)`)
            .run(repair.version, new Date().toISOString());
    }
}

function attachProgress(raw) {
    const progressPath = getProgressDatabasePath();
    fs.mkdirSync(path.dirname(progressPath), { recursive: true });
    raw.prepare(`ATTACH DATABASE ? AS ${SCHEMA_NAME}`).run(progressPath);
    raw.pragma(`${SCHEMA_NAME}.journal_mode = WAL`);
    raw.exec(SCHEMA);
    applyProgressRepairs(raw);
}

const adapter = createSqliteAdapter({
    resolvePath: getDatabasePath,
    onOpen: attachProgress,
});

export const openDatabase = adapter.openDatabase;

export const closeDatabase = adapter.closeDatabase;

export const isOpen = adapter.isOpen;

export default adapter.db;
