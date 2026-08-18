/**
 * The async SQLite adapter, as a factory.
 *
 * This is the M0 adapter with one change: it can be instantiated more than once. Flashback
 * now has two stores that must not know about each other —
 *
 *   - the VAULT database (`database.js`), derived, rebuildable from the canonical files,
 *     and re-pointed every time the active vault changes;
 *   - the ACCOUNTS store (`accounts.js`), install-scoped, outside every vault, and the one
 *     store in the app that cannot be rebuilt from anything.
 *
 * — and they need the same async contract, since a Postgres driver has to satisfy it for
 * both. Everything below is a per-instance closure for that reason.
 *
 * ## The serialization, and why each instance needs its own
 *
 * The data layer is async so a Postgres driver can sit behind the same interface. That
 * removes a guarantee the synchronous code got for free, and removes it silently.
 *
 * better-sqlite3 gives one connection per store and no isolation of its own. Every `await`
 * inside a transaction body is a yield to the microtask queue, and another request's handler
 * is free to run there. A statement it issues would execute on a connection with an open
 * BEGIN — joining a transaction it knows nothing about, and vanishing with it on rollback.
 * No error, no constraint violation; a row that was written successfully is just gone.
 *
 * So a transaction takes an exclusive lock against ALL access to ITS OWN store, held for the
 * whole body. Statements are synchronous underneath, so an uncontended operation costs a
 * microtask and nothing more.
 *
 * **The queue and the AsyncLocalStorage are per instance, and that is load-bearing.** Two
 * stores sharing either would be a bug, not a style choice:
 *
 *   - a shared ALS would make a statement on store B, issued from inside a transaction on
 *     store A, believe it already holds B's lock — so it would bypass B's queue and
 *     interleave into whatever transaction B has open;
 *   - a shared queue would serialize two independent connections against each other, and
 *     deadlock outright the moment a write to B happens inside a transaction on A. That is
 *     not hypothetical: per-user review progress (M2) writes to the accounts store from
 *     inside the vault's review transaction.
 *
 * Postgres will implement the same contract differently and must NOT inherit this lock: it
 * has real MVCC, so a transaction there checks out a dedicated client and concurrent
 * statements go to the pool. Isolation is a promise of this interface, not of a driver.
 */

import BetterSQLite from "better-sqlite3";
import path from "path";
import fs from "fs";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Builds one independent adapter over one SQLite file.
 *
 * @param {object}        options
 * @param {() => string}  options.resolvePath  Where the file lives, resolved PER CALL — the
 *   vault database moves when the active vault changes, so a captured string would be wrong
 *   after the first switch.
 * @param {(raw: import('better-sqlite3').Database) => void} [options.onOpen]  Runs against
 *   the fresh handle before anything else uses it (schema creation for a self-owned store).
 *   Synchronous by necessity: it runs inside open(), which cannot await.
 * @returns {{db: object, openDatabase: () => import('better-sqlite3').Database,
 *            closeDatabase: () => void, isOpen: () => boolean}}
 */
export function createSqliteAdapter({ resolvePath, onOpen }) {
    // The live handle. Swapped by openDatabase() when the active vault changes; never
    // exported directly, because a module binding cannot be re-pointed in an importer.
    let handle = null;

    function open() {
        const dbPath = resolvePath();
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
        const raw = new BetterSQLite(dbPath);
        raw.pragma("journal_mode = WAL");
        raw.pragma("foreign_keys = ON");
        onOpen?.(raw);
        return raw;
    }

    function live() {
        if (!handle) openDatabase();
        return handle;
    }

    /**
     * Opens (or re-opens) the connection. Closes any previous handle first, so callers
     * cannot leak a connection by mistake.
     */
    function openDatabase() {
        if (handle) closeDatabase();
        handle = open();
        return handle;
    }

    /**
     * Closes the connection, truncating the WAL on the way out.
     *
     * The checkpoint matters: with `journal_mode = WAL` the store carries `-wal` and `-shm`
     * files beside the `.db`, and a rename or a switch that leaves un-checkpointed pages
     * behind is how a vault loses its most recent writes. SQLite checkpoints on the last
     * connection closing anyway; doing it explicitly means a failure here surfaces as an
     * error rather than as silently missing data.
     */
    function closeDatabase() {
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
    function isOpen() {
        return !!handle && handle.open;
    }

    // --- serialization (per instance — see the header) ----------------------

    let queueTail = Promise.resolve();

    /** Runs `fn` once every previously-queued operation on THIS store has settled. */
    function enqueue(fn) {
        const result = queueTail.then(fn, fn);
        // Swallow rejections on the chaining path only — `result` still rejects for the
        // caller. Without this a single failed statement would poison every later one.
        queueTail = result.then(() => { }, () => { });
        return result;
    }

    // Tracks whether the current async context is inside a transaction ON THIS STORE, and
    // how deep. Used for two things: statements inside a transaction must BYPASS the queue
    // (the transaction already holds it — going through it again would deadlock against
    // itself), and a nested transaction must use a SAVEPOINT rather than a second BEGIN.
    const txContext = new AsyncLocalStorage();

    let savepointCounter = 0;

    /**
     * Wraps a body so it runs atomically. Mirrors better-sqlite3's shape —
     * `transaction(fn)` returns a function that forwards its arguments to `fn` — because
     * query.js's batch writers depend on it: `db.transaction((rows) => {...})(cards)`.
     *
     * Nesting maps to SAVEPOINTs, which is what better-sqlite3 does today. An inner failure
     * that the caller catches must not roll back the outer transaction's earlier work.
     *
     * @param {(...args: any[]) => any} fn
     * @returns {(...args: any[]) => Promise<any>}
     */
    function transaction(fn) {
        return (...args) => {
            const outer = txContext.getStore();

            // Nested: the lock is already held by the transaction we are inside, so
            // re-entering the queue would deadlock. Scope this level with a savepoint.
            if (outer) {
                const name = `fb_sp_${++savepointCounter}`;
                const raw = live();
                raw.exec(`SAVEPOINT ${name}`);
                return txContext
                    .run({ depth: outer.depth + 1 }, async () => fn(...args))
                    .then(
                        (value) => { raw.exec(`RELEASE ${name}`); return value; },
                        (err) => {
                            // ROLLBACK TO leaves the savepoint on the stack; RELEASE pops it.
                            try { raw.exec(`ROLLBACK TO ${name}`); raw.exec(`RELEASE ${name}`); } catch { /* connection already gone */ }
                            throw err;
                        },
                    );
            }

            return enqueue(async () => {
                const raw = live();
                raw.exec("BEGIN");
                try {
                    const value = await txContext.run({ depth: 1 }, async () => fn(...args));
                    raw.exec("COMMIT");
                    return value;
                } catch (err) {
                    try { raw.exec("ROLLBACK"); } catch { /* connection already gone */ }
                    throw err;
                }
            });
        };
    }

    /** Runs one statement, bypassing the queue when we already hold it via a transaction. */
    function run(op) {
        if (txContext.getStore()) return Promise.resolve().then(op);
        return enqueue(op);
    }

    /**
     * A prepared statement whose execution is async but whose CONSTRUCTION is not.
     *
     * Keeping `prepare()` synchronous is deliberate and is what kept the port of query.js's
     * 221 statements to `await`/`async` instead of a rewrite of every call form. It also
     * keeps the existing "prepare once, run in a loop" shape working inside a transaction.
     *
     * Only `.get`, `.all` and `.run` exist because only those three are used anywhere in
     * the codebase — no `.iterate`, `.pluck`, `.raw`, `.function` or `.aggregate`. A driver
     * that has to implement this interface should not have to implement more than is real.
     */
    function prepare(sql) {
        return {
            get: (...params) => run(() => live().prepare(sql).get(...params)),
            all: (...params) => run(() => live().prepare(sql).all(...params)),
            run: (...params) => run(() => live().prepare(sql).run(...params)),
        };
    }

    /** Multi-statement DDL/SQL. Async for the same reason everything else here is. */
    function exec(sql) {
        return run(() => live().exec(sql));
    }

    /**
     * SQLite-only. Kept on the interface because migrations and validators legitimately
     * need it (`PRAGMA table_info`, `PRAGMA integrity_check`); a Postgres driver answers
     * these from `information_schema` instead, so every caller is a place that needs a
     * dialect path.
     */
    function pragma(source, options) {
        return run(() => live().pragma(source, options));
    }

    // The adapter is a stable object rather than the connection itself.
    //
    // Nine modules do `import db from './database.js'`, and query.js additionally stores the
    // reference (`this.db = db`) in a constructor that runs once at import. An ESM binding
    // is immutable and that stored reference would outlive any swap, so re-pointing the
    // handle has to happen BEHIND an object whose identity never changes.
    //
    // This used to be a Proxy forwarding arbitrary properties to the live connection. It is
    // an explicit surface now because the interface is the contract a second driver
    // implements — forwarding anything better-sqlite3 happens to expose would make that
    // contract unknowable.
    const db = {
        prepare,
        exec,
        pragma,
        transaction,

        /** Closes the connection. Delegates so the WAL checkpoint is not something a caller
         *  can forget; a Postgres driver ends its pool here instead. */
        close: closeDatabase,

        /**
         * Whether the CURRENT async context is inside a transaction on THIS store.
         *
         * better-sqlite3 answered this from the connection, which was only ever right
         * because one connection could be in one transaction at a time. The adapter tracks
         * the context itself, so this is now a precise answer to the question callers
         * actually mean: "would starting a transaction here nest?" (validators/database.js
         * asks exactly that before choosing between a bare rebuild and a wrapped one).
         */
        get inTransaction() {
            return !!txContext.getStore();
        },

        /** Escape hatch for the few callers that genuinely need the driver (ankiImport's
         *  .apkg reader has its own handle and must NOT use this). */
        get raw() {
            return live();
        },
    };

    return { db, openDatabase, closeDatabase, isOpen };
}
