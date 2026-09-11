/**
 * The VAULT database — the derived layer, rebuildable from the canonical `.flashback` files.
 *
 * All of the machinery lives in `sqliteAdapter.js`; this module is one instance of it,
 * pointed at whatever vault `config.js` currently resolves. It stayed a module of its own
 * because its default export is the object nine modules import and query.js stores in a
 * constructor — that identity must never change, whatever happens to the connection behind
 * it.
 *
 * The path is resolved PER CALL rather than captured, which is the whole reason an
 * in-process vault switch is possible: `openDatabase()` after `config.reload()` opens the
 * new vault with no importer noticing.
 *
 * The accounts store (`accounts.js`) is the OTHER instance of the same factory. The two
 * share no connection, no queue and no transaction context — see the factory's header for
 * why that separation is load-bearing rather than tidy.
 *
 * ## The progress store rides on this connection
 *
 * `progress.js` is deliberately NOT a third instance. It is ATTACHed here as the schema
 * `progress`, so a card's schedule joins against `Flashcards` in one statement and a review
 * writes both files from inside ONE transaction on ONE queue. A second adapter over the same
 * file would give back exactly the split `srs.js`'s cross-store mirror exists to paper over.
 *
 * Two things about `onOpen` are load-bearing rather than tidy:
 *
 *   - The path is resolved INSIDE the callback. Closing over a resolved string would keep
 *     attaching the previous vault's progress store after a switch — the same trap
 *     `resolvePath` exists to avoid for the main file.
 *   - `journal_mode` is per file, not per connection. The adapter's `WAL` pragma applies to
 *     `main` only; an attached database opens in `delete` mode unless told otherwise, which
 *     would leave two files beside each other with different durability and locking
 *     behaviour. Verified, not assumed.
 */

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
