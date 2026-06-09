// Import migration modules here in order — never reorder or remove entries.
// e.g.:  import * as m001 from './migrations/001_pre_beta.js';
const MIGRATIONS = [];

function ensureVersionTable(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS SchemaVersion (
        version     INTEGER PRIMARY KEY,
        applied_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
        description TEXT
    )`);
}

function appliedVersions(db) {
    return new Set(
        db.prepare('SELECT version FROM SchemaVersion').all().map(r => r.version)
    );
}

/**
 * Runs all pending migrations in version order.
 * Each migration executes in its own transaction; a failed migration
 * halts the runner and rethrows so startup fails loudly.
 */
export default function runMigrations(db) {
    ensureVersionTable(db);
    const applied = appliedVersions(db);

    const pending = MIGRATIONS
        .filter(m => !applied.has(m.version))
        .sort((a, b) => a.version - b.version);

    if (pending.length === 0) return;

    const record = db.prepare(
        'INSERT INTO SchemaVersion (version, description) VALUES (?, ?)'
    );

    for (const migration of pending) {
        db.transaction(() => {
            migration.up(db);
            record.run(migration.version, migration.description);
        })();
        console.log(`Migration ${migration.version} applied: ${migration.description}`);
    }
}
