/**
 * The async database adapter — and specifically the one failure it exists to prevent.
 *
 * Until now `query.js` was synchronous end to end: 221 prepared statements, every write
 * wrapped in better-sqlite3's `db.transaction(() => { ... })()` IIFE. That form is safe
 * *because* it is synchronous — nothing can run between two statements of a transaction,
 * because nothing can run at all until the transaction returns.
 *
 * Making the data layer async removes that guarantee, and removes it silently. Once a
 * statement is awaited, every `await` inside a transaction body is a yield to the microtask
 * queue, and another request's handler is free to run there. On SQLite there is exactly one
 * connection, so a statement issued by that other handler is executed against a connection
 * with an open BEGIN — it joins a transaction it knows nothing about. If the first
 * transaction then rolls back, it takes the stranger's write with it.
 *
 * Nothing about that failure is loud. No error is thrown, no constraint is violated; a row
 * that was written successfully is simply not there afterwards. That is why this file is
 * written before the adapter it tests, and why the interleaving case below is the reason
 * the whole file exists — the rest are guards around it.
 *
 * The adapter contract these tests pin down:
 *   - `prepare(sql)` stays SYNCHRONOUS and returns a statement whose `.get`/`.all`/`.run`
 *     are async. That keeps the conversion of query.js to `await`/`async` rather than a
 *     rewrite of all 221 call forms.
 *   - `transaction(fn)()` is atomic AND isolated: no statement issued outside it may land
 *     inside it, whatever the two interleave.
 *
 * Isolation is a guarantee of the interface, not of a driver. SQLite earns it with a lock
 * (one connection, no isolation of its own); Postgres will earn it with a dedicated client
 * per transaction and its own MVCC. The tests below must pass unchanged on both.
 *
 * Run: node --test tests/dbAdapter.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';

const ROOT = path.join(process.cwd(), 'data_test_dbadapter');
process.env.USER_DATA_PATH = ROOT;

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });
fs.writeFileSync(
    path.join(ROOT, 'config.json'),
    JSON.stringify({
        port: 0, logFormat: 'dev', host: 'localhost', isLocalhost: true,
        isCustomPath: false, customPath: '', vaultName: 'adapter',
    }, null, 2),
);

const { default: db, closeDatabase } = await import('../src/api/access/primitives/database.js');

after(() => {
    closeDatabase();
    try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* Windows handle lag */ }
});

// A scratch table of our own. These tests are about the adapter's concurrency semantics,
// not about any vault table, and owning the table means they never have to reason about
// what a migration or a seed left behind.
before(async () => {
    await db.exec('CREATE TABLE IF NOT EXISTS AdapterProbe (id INTEGER PRIMARY KEY, v TEXT)');
});

async function reset() {
    await db.exec('DELETE FROM AdapterProbe');
}

const insert = (v) => db.prepare('INSERT INTO AdapterProbe (v) VALUES (?)').run(v);
const values = async () =>
    (await db.prepare('SELECT v FROM AdapterProbe ORDER BY id').all()).map(r => r.v);

/** Yields the event loop hard enough that anything pending gets a turn to run. */
const yieldHard = () => new Promise(resolve => setImmediate(resolve));

describe('async statement surface', () => {
    it('prepare() is synchronous and its methods are async', async () => {
        await reset();
        const stmt = db.prepare('INSERT INTO AdapterProbe (v) VALUES (?)');
        // If prepare() returned a promise, the conversion of query.js would mean rewriting
        // every call form rather than adding `await` — so this is a contract, not a detail.
        assert.equal(typeof stmt.run, 'function');
        assert.ok(!(stmt instanceof Promise));

        const result = stmt.run('a');
        assert.ok(result instanceof Promise, '.run() must be async');
        await result;

        assert.deepEqual(await values(), ['a']);
    });

    it('run() reports changes and lastInsertRowid', async () => {
        await reset();
        const result = await insert('a');
        // query.js reads both of these (7 lastInsertRowid, 3 .changes), so both survive
        // the port or those call sites break silently.
        assert.equal(result.changes, 1);
        assert.ok(Number(result.lastInsertRowid) > 0);
    });

    it('get() returns one row and all() returns many', async () => {
        await reset();
        await insert('a');
        await insert('b');
        assert.equal((await db.prepare('SELECT v FROM AdapterProbe ORDER BY id').get()).v, 'a');
        assert.deepEqual(await values(), ['a', 'b']);
        assert.equal(await db.prepare('SELECT v FROM AdapterProbe WHERE v = ?').get('nope'), undefined);
    });
});

describe('transactions', () => {
    it('commits every statement in the body', async () => {
        await reset();
        await db.transaction(async () => {
            await insert('a');
            await insert('b');
        })();
        assert.deepEqual(await values(), ['a', 'b']);
    });

    it('rolls back the whole body when it throws', async () => {
        await reset();
        await assert.rejects(
            db.transaction(async () => {
                await insert('a');
                throw new Error('boom');
            })(),
            /boom/,
        );
        assert.deepEqual(await values(), []);
    });

    /**
     * THE test. A write issued from outside a transaction, while that transaction is open
     * and awaiting, must not become part of it.
     *
     * The transaction rolls back deliberately: that is what makes the failure observable.
     * If the outside write joined the transaction it disappears with it, and the assertion
     * below sees an empty table instead of the row that was written successfully.
     *
     * A naive async wrapper — one that simply promisifies better-sqlite3 and leaves the
     * single connection unguarded — fails here, which is the entire point of writing it
     * before the adapter exists.
     */
    it('does not let an outside write interleave into an open transaction', async () => {
        await reset();

        // The competing write must originate from a DIFFERENT async context than the
        // transaction body — that is what makes it a second request rather than part of
        // this one. Issuing it from inside the callback would (correctly) make it part of
        // the transaction, and would test nothing.
        let openTheGate;
        const gate = new Promise(resolve => { openTheGate = resolve; });

        const tx = db.transaction(async () => {
            await insert('inside');
            await gate;              // hold the transaction open, mid-body
            throw new Error('rollback');
        })();

        await yieldHard();           // let the transaction reach the gate
        const outside = insert('outside');   // issued from the test's context
        await yieldHard();
        openTheGate();

        await assert.rejects(tx, /rollback/);
        await outside;

        assert.deepEqual(
            await values(),
            ['outside'],
            'the outside write must survive the transaction it was never part of',
        );
    });

    /**
     * Two transactions overlapping in time must not interleave their statements. Under a
     * single SQLite connection an inner BEGIN inside an open transaction is an error at
     * best and a silently flattened transaction at worst.
     */
    it('serializes overlapping transactions', async () => {
        await reset();

        const order = [];
        const one = db.transaction(async () => {
            order.push('1-start');
            await yieldHard();
            await insert('one');
            order.push('1-end');
        })();
        const two = db.transaction(async () => {
            order.push('2-start');
            await yieldHard();
            await insert('two');
            order.push('2-end');
        })();

        await Promise.all([one, two]);

        assert.deepEqual(order, ['1-start', '1-end', '2-start', '2-end']);
        assert.deepEqual(await values(), ['one', 'two']);
    });

    it('releases the lock when the body throws, so later work is not deadlocked', async () => {
        await reset();
        await assert.rejects(db.transaction(async () => { throw new Error('boom'); })(), /boom/);
        // If the failed transaction leaked its lock this insert never resolves and the test
        // times out rather than failing — which is still a failure, just a slower one.
        await insert('after');
        assert.deepEqual(await values(), ['after']);
    });

    it('returns the body\'s value', async () => {
        await reset();
        assert.equal(await db.transaction(async () => 42)(), 42);
    });

    it('forwards arguments to the body', async () => {
        await reset();
        // query.js's batch writers use this shape: db.transaction((rows) => {...})(cards)
        // at lines 374, 397, 404 and 411. Dropping the argument would silently write nothing.
        await db.transaction(async (rows) => {
            for (const r of rows) await insert(r);
        })(['a', 'b']);
        assert.deepEqual(await values(), ['a', 'b']);
    });
});

/**
 * Nesting is not hypothetical here: `documents.js` opens a transaction and calls `query.js`
 * methods that open their own. better-sqlite3 handles that with SAVEPOINTs, so the adapter
 * has to as well — an inner BEGIN on an open connection is an error, and treating the inner
 * transaction as a no-op would silently widen the rollback scope of an inner failure.
 */
describe('nested transactions', () => {
    it('commits an inner transaction as part of the outer one', async () => {
        await reset();
        await db.transaction(async () => {
            await insert('outer');
            await db.transaction(async () => { await insert('inner'); })();
        })();
        assert.deepEqual(await values(), ['outer', 'inner']);
    });

    it('rolls the inner work back with the outer when the outer fails', async () => {
        await reset();
        await assert.rejects(
            db.transaction(async () => {
                await insert('outer');
                await db.transaction(async () => { await insert('inner'); })();
                throw new Error('boom');
            })(),
            /boom/,
        );
        assert.deepEqual(await values(), []);
    });

    it('lets the outer transaction survive a caught inner failure', async () => {
        await reset();
        await db.transaction(async () => {
            await insert('outer');
            await assert.rejects(
                db.transaction(async () => {
                    await insert('inner');
                    throw new Error('inner boom');
                })(),
                /inner boom/,
            );
        })();
        // The savepoint rolls back only the inner statement; the outer commit stands.
        assert.deepEqual(await values(), ['outer']);
    });

    it('does not deadlock when an inner transaction runs inside an outer one', async () => {
        await reset();
        // A queue that is not re-entrant would hang here forever: the outer transaction
        // holds the lock the inner one waits for. The test would time out rather than fail.
        await db.transaction(async () => {
            await db.transaction(async () => { await insert('nested'); })();
        })();
        assert.deepEqual(await values(), ['nested']);
    });
});
