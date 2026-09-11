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
 * @param {() => string}  options.resolvePath  Where the file lives, resolved PER CALL — the vault database moves when the active vault changes, so a captured string would be wrong after the first switch.
 * @param {(raw: import('better-sqlite3').Database) => void} [options.onOpen]  Runs against the fresh handle before anything else uses it (schema creation for a self-owned store). Synchronous by necessity: it runs inside open(), which cannot await.
 * @returns {{db: object, openDatabase: () => import('better-sqlite3').Database, closeDatabase: () => void, isOpen: () => boolean}}
 */
export function createSqliteAdapter({ resolvePath, onOpen }) {
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

    /** Opens (or re-opens) the connection. */
    function openDatabase() {
        if (handle) closeDatabase();
        handle = open();
        return handle;
    }

    /**
     * Closes the connection, truncating the WAL on the way out.
     *
     * The checkpoint is deliberately UNQUALIFIED: with no schema prefix it covers every
     * attached database, not just `main`. That is what leaves no `-wal`/`-shm` beside the
     * vault's progress store either, which `releaseVault()` depends on — Windows will not
     * rename a folder holding an open file. Do not "tidy" this to `main.wal_checkpoint`.
     */
    function closeDatabase() {
        if (!handle) return;
        try {
            handle.pragma("wal_checkpoint(TRUNCATE)");
        } catch {
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

    let queueTail = Promise.resolve();

    /** Runs `fn` once every previously-queued operation on THIS store has settled. */
    function enqueue(fn) {
        const result = queueTail.then(fn, fn);
        queueTail = result.then(() => { }, () => { });
        return result;
    }

    const txContext = new AsyncLocalStorage();

    let savepointCounter = 0;

    /**
     * Wraps a body so it runs atomically.
     *
     * @param {(...args: any[]) => any} fn
     * @returns {(...args: any[]) => Promise<any>}
     */
    function transaction(fn) {
        return (...args) => {
            const outer = txContext.getStore();

            if (outer) {
                const name = `fb_sp_${++savepointCounter}`;
                const raw = live();
                raw.exec(`SAVEPOINT ${name}`);
                return txContext
                    .run({ depth: outer.depth + 1 }, async () => fn(...args))
                    .then(
                        (value) => { raw.exec(`RELEASE ${name}`); return value; },
                        (err) => {
                            try { raw.exec(`ROLLBACK TO ${name}`); raw.exec(`RELEASE ${name}`); } catch { }
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
                    try { raw.exec("ROLLBACK"); } catch { }
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

    /** A prepared statement whose execution is async but whose CONSTRUCTION is not. */
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

    /** SQLite-only. */
    function pragma(source, options) {
        return run(() => live().pragma(source, options));
    }

    const db = {
        prepare,
        exec,
        pragma,
        transaction,

        close: closeDatabase,

        /** Whether the CURRENT async context is inside a transaction on THIS store. */
        get inTransaction() {
            return !!txContext.getStore();
        },

        get raw() {
            return live();
        },
    };

    return { db, openDatabase, closeDatabase, isOpen };
}
