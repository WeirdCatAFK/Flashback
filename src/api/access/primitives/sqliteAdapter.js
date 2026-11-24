import BetterSQLite from "better-sqlite3";
import path from "path";
import fs from "fs";
import { AsyncLocalStorage } from "node:async_hooks";

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

    function openDatabase() {
        if (handle) closeDatabase();
        handle = open();
        return handle;
    }

    /** The checkpoint names no schema, so it also empties the progress.db WAL. Windows cannot rename a vault folder that holds an open -wal file. */
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

    function isOpen() {
        return !!handle && handle.open;
    }

    let queueTail = Promise.resolve();

    function enqueue(fn) {
        const result = queueTail.then(fn, fn);
        queueTail = result.then(() => { }, () => { });
        return result;
    }

    const txContext = new AsyncLocalStorage();

    let savepointCounter = 0;

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

    function run(op) {
        if (txContext.getStore()) return Promise.resolve().then(op);
        return enqueue(op);
    }

    function prepare(sql) {
        return {
            get: (...params) => run(() => live().prepare(sql).get(...params)),
            all: (...params) => run(() => live().prepare(sql).all(...params)),
            run: (...params) => run(() => live().prepare(sql).run(...params)),
        };
    }

    function exec(sql) {
        return run(() => live().exec(sql));
    }

    function pragma(source, options) {
        return run(() => live().pragma(source, options));
    }

    const db = {
        prepare,
        exec,
        pragma,
        transaction,

        close: closeDatabase,

        get inTransaction() {
            return !!txContext.getStore();
        },

        get raw() {
            return live();
        },
    };

    return { db, openDatabase, closeDatabase, isOpen };
}
