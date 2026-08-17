// Import migration modules here in order — never reorder or remove entries.
import * as m001 from './migrations/001_pre_beta.js';
import * as m002 from './migrations/002_document_links.js';
import * as m003 from './migrations/003_system_deck.js';
import * as m004 from './migrations/004_fsrs.js';
import * as m005 from './migrations/005_card_origin.js';
import * as m006 from './migrations/006_review_algorithm.js';
import * as m007 from './migrations/007_card_health.js';
import * as m008 from './migrations/008_type_answer_answer_text.js';
import * as m009 from './migrations/009_session_ordering.js';
const MIGRATIONS = [m001, m002, m003, m004, m005, m006, m007, m008, m009];

async function ensureVersionTable(db) {
    await db.exec(`CREATE TABLE IF NOT EXISTS SchemaVersion (
        version     INTEGER PRIMARY KEY,
        applied_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
        description TEXT
    )`);
}

async function appliedVersions(db) {
    return new Set(
        (await db.prepare('SELECT version FROM SchemaVersion').all()).map(r => r.version)
    );
}

/**
 * Runs all pending migrations in version order.
 * Each migration executes in its own transaction; a failed migration
 * halts the runner and rethrows so startup fails loudly.
 */
export default async function runMigrations(db) {
    await ensureVersionTable(db);
    const applied = await appliedVersions(db);

    // A migration runs if it hasn't been recorded yet, OR if its optional
    // shouldRun() guard says its artifacts are still missing (handles the case
    // where a migration was recorded but its tables were later dropped).
    const pending = MIGRATIONS
        .filter(m => !applied.has(m.version) || m.shouldRun?.(db))
        .sort((a, b) => a.version - b.version);

    if (pending.length === 0) return;

    const record = db.prepare(
        'INSERT OR REPLACE INTO SchemaVersion (version, description) VALUES (?, ?)'
    );

    for (const migration of pending) {
        await db.transaction(async () => {
            migration.up(db);
            await record.run(migration.version, migration.description);
        })();
        console.log(`Migration ${migration.version} applied: ${migration.description}`);
    }
}
