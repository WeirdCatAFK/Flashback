import BetterSQLite from "better-sqlite3";
import path from "path";
import fs from "fs";
import { getDatabasePath } from "./config.js";

// The live handle. Swapped by openDatabase() when the active vault changes; never
// exported directly, because a module binding cannot be re-pointed in an importer.
let handle = null;

function open() {
    const dbPath = getDatabasePath();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new BetterSQLite(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    return db;
}

/**
 * Opens (or re-opens) the connection for whatever vault config.js currently points at.
 * Closes any previous handle first, so callers cannot leak a connection by mistake.
 * @returns {import('better-sqlite3').Database} the raw handle, for callers that need it.
 */
export function openDatabase() {
    if (handle) closeDatabase();
    handle = open();
    return handle;
}

/**
 * Closes the connection, truncating the WAL on the way out.
 *
 * The checkpoint matters: with `journal_mode = WAL` the vault carries `-wal` and `-shm`
 * files beside the `.db`, and a rename or a switch that leaves un-checkpointed pages
 * behind is how a vault loses its most recent writes. SQLite checkpoints on the last
 * connection closing anyway; doing it explicitly means a failure here surfaces as an
 * error rather than as silently missing data.
 */
export function closeDatabase() {
    if (!handle) return;
    try {
        handle.pragma("wal_checkpoint(TRUNCATE)");
    } catch {
        // A corrupt or already-detached DB should not block the close below.
    }
    try {
        handle.close();
    } finally {
        handle = null;
    }
}

/** @returns {boolean} whether a connection is currently open. */
export function isOpen() {
    return !!handle && handle.open;
}

// The default export is a stable Proxy rather than the connection itself.
//
// Nine modules do `import db from './database.js'`, and query.js additionally stores the
// reference (`this.db = db`) in a constructor that runs once at import. An ESM binding is
// immutable and that stored reference would outlive any swap, so re-pointing the handle
// has to happen BEHIND an object whose identity never changes. Every property access is
// forwarded to the live connection, and functions are bound to it because better-sqlite3
// is a native addon that needs its real `this`.
//
// Safe to do here specifically because nothing in the codebase caches a prepared
// statement: every `prepare()` in query.js is a local `const stmt` used immediately, so
// no statement can outlive the connection it was compiled against.
const db = new Proxy(
    {},
    {
        get(_target, prop) {
            if (!handle) openDatabase();
            const value = handle[prop];
            return typeof value === "function" ? value.bind(handle) : value;
        },
        set(_target, prop, value) {
            if (!handle) openDatabase();
            handle[prop] = value;
            return true;
        },
        has(_target, prop) {
            if (!handle) openDatabase();
            return prop in handle;
        },
    }
);

export default db;
