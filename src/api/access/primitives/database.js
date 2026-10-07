/** Derived-layer DB. ATTACHes progress.db as the `progress` schema. Never hoist db.prepare() to module scope. */

import fs from "fs";
import path from "path";
import { createSqliteAdapter } from "./sqliteAdapter.js";
import { getDatabasePath, getProgressDatabasePath } from "./config.js";
import { SCHEMA_NAME, SCHEMA, REPAIRS } from "./progress.js";

/**
 * Applies the progress store's own repairs, recorded against `ProgressSchemaVersion`.
 *
 * Synchronous by necessity: it runs inside `open()`, which cannot await.
 *
 * @param {import('better-sqlite3').Database} raw
 */
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

/**
 * Attaches the progress store and brings its schema up to date.
 *
 * The path is resolved here, not captured at module scope — closing over a string would
 * keep attaching the previous vault after a switch. journal_mode is set per-file because
 * the adapter's WAL pragma only applies to `main`; without it the attached DB opens in
 * delete mode.
 *
 * @param {import('better-sqlite3').Database} raw
 */
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

/**
 * Opens (or re-opens) the connection for whatever vault config.js currently points at.
 *
 * @returns {import('better-sqlite3').Database} the raw handle, for callers that need it.
 */
export const openDatabase = adapter.openDatabase;

/** Closes the connection, truncating the WAL on the way out. */
export const closeDatabase = adapter.closeDatabase;

/** @returns {boolean} whether a connection is currently open. */
export const isOpen = adapter.isOpen;

export default adapter.db;
