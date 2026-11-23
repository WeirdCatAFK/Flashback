import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { testDataDir } from '../support/testData.js';

const ROOT = testDataDir('dbAdapter');
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

const { default: db, closeDatabase } = await import('../../src/api/access/primitives/database.js');
const { getProgressDatabasePath } = await import('../../src/api/access/primitives/config.js');

after(() => {
    closeDatabase();
    try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {  }
});

before(async () => {
    await db.exec('CREATE TABLE IF NOT EXISTS AdapterProbe (id INTEGER PRIMARY KEY, v TEXT)');
});

async function reset() {
    await db.exec('DELETE FROM AdapterProbe');
}

const insert = (v) => db.prepare('INSERT INTO AdapterProbe (v) VALUES (?)').run(v);
const values = async () =>
    (await db.prepare('SELECT v FROM AdapterProbe ORDER BY id').all()).map(r => r.v);

const yieldHard = () => new Promise(resolve => setImmediate(resolve));

describe('async statement surface', () => {
    it('prepare() is synchronous and its methods are async', async () => {
        await reset();
        const stmt = db.prepare('INSERT INTO AdapterProbe (v) VALUES (?)');
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

    it('does not let an outside write interleave into an open transaction', async () => {
        await reset();

        let openTheGate;
        const gate = new Promise(resolve => { openTheGate = resolve; });

        const tx = db.transaction(async () => {
            await insert('inside');
            await gate;
            throw new Error('rollback');
        })();

        await yieldHard();
        const outside = insert('outside');
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
        await insert('after');
        assert.deepEqual(await values(), ['after']);
    });

    it('returns the body\'s value', async () => {
        await reset();
        assert.equal(await db.transaction(async () => 42)(), 42);
    });

    it('forwards arguments to the body', async () => {
        await reset();
        await db.transaction(async (rows) => {
            for (const r of rows) await insert(r);
        })(['a', 'b']);
        assert.deepEqual(await values(), ['a', 'b']);
    });
});

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
        assert.deepEqual(await values(), ['outer']);
    });

    it('does not deadlock when an inner transaction runs inside an outer one', async () => {
        await reset();
        await db.transaction(async () => {
            await db.transaction(async () => { await insert('nested'); })();
        })();
        assert.deepEqual(await values(), ['nested']);
    });
});

describe('attached progress store', () => {
    it('is attached, and its tables live there rather than in main', async () => {
        const schemas = (await db.pragma('database_list')).map((r) => r.name);
        assert.ok(schemas.includes('progress'), `expected a progress schema, got ${schemas.join(', ')}`);

        const there = (await db.prepare(
            "SELECT name FROM progress.sqlite_master WHERE type = 'table' AND name = 'CardProgress'",
        ).all()).length;
        assert.equal(there, 1, 'CardProgress should exist in the progress schema');

        assert.ok(fs.existsSync(getProgressDatabasePath()), 'progress.db should exist on disk');
    });

    it('runs the attached file in WAL too', async () => {
        const mode = (await db.pragma('progress.journal_mode'))[0].journal_mode;
        assert.equal(mode, 'wal');
    });

    it('rolls back main and progress together when the body throws', async () => {
        await db.exec("DELETE FROM progress.CardProgress WHERE card_hash = 'adapter-rollback'");
        await assert.rejects(
            db.transaction(async () => {
                await db.prepare(
                    "INSERT INTO progress.CardProgress (account_id, card_hash, level) VALUES ('owner', 'adapter-rollback', 3)",
                ).run();
                await insert('paired');
                throw new Error('paired boom');
            })(),
            /paired boom/,
        );

        const left = await db.prepare(
            "SELECT count(*) AS n FROM progress.CardProgress WHERE card_hash = 'adapter-rollback'",
        ).get();
        assert.equal(left.n, 0, 'the progress write must not survive the rollback');
    });

    it('attaches before BEGIN, so a transaction may be the first thing a connection does', async () => {
        closeDatabase();
        await db.transaction(async () => {
            const schemas = (await db.pragma('database_list')).map((r) => r.name);
            assert.ok(schemas.includes('progress'));
        })();
    });
});
