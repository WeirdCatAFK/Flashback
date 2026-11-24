import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { up as formatVersionTable } from '../../src/api/config/migrations/018_format_version_table.js';

const TABLE = (name) => `CREATE TABLE ${name} (version INTEGER PRIMARY KEY, applied_at TEXT, description TEXT)`;

function openDb() {
    const raw = new Database(':memory:');
    return { raw, adapter: { prepare: (sql) => raw.prepare(sql), exec: (sql) => raw.exec(sql) } };
}

const tables = (raw) => raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);

describe('migration 018: CanonicalVersion becomes FormatVersion', () => {
    it('renames the old table and keeps its rows', async () => {
        const { raw, adapter } = openDb();
        raw.exec(TABLE('CanonicalVersion'));
        raw.prepare('INSERT INTO CanonicalVersion (version, description) VALUES (1, ?)').run('first');

        await formatVersionTable(adapter);

        assert.deepEqual(tables(raw), ['FormatVersion']);
        assert.equal(raw.prepare('SELECT description FROM FormatVersion WHERE version = 1').get().description, 'first');
    });

    it('merges into a FormatVersion table that already exists, then drops the old one', async () => {
        const { raw, adapter } = openDb();
        raw.exec(TABLE('CanonicalVersion'));
        raw.exec(TABLE('FormatVersion'));
        raw.prepare('INSERT INTO CanonicalVersion (version, description) VALUES (1, ?)').run('old');
        raw.prepare('INSERT INTO FormatVersion (version, description) VALUES (2, ?)').run('new');

        await formatVersionTable(adapter);

        assert.deepEqual(tables(raw), ['FormatVersion']);
        assert.deepEqual(raw.prepare('SELECT version FROM FormatVersion ORDER BY version').all().map((r) => r.version), [1, 2]);
    });

    it('does nothing on a vault that never had the old table', async () => {
        const { raw, adapter } = openDb();
        raw.exec(TABLE('FormatVersion'));

        await formatVersionTable(adapter);

        assert.deepEqual(tables(raw), ['FormatVersion']);
    });
});
