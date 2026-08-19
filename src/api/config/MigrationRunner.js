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
import * as m010 from './migrations/010_per_account_progress.js';
import * as m011 from './migrations/011_drop_resurrected_srs_columns.js';
import * as m012 from './migrations/012_reviewlogs_account_index.js';
const MIGRATIONS = [m001, m002, m003, m004, m005, m006, m007, m008, m009, m010, m011, m012];

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
    //
    // shouldRun is async and MUST be awaited. `.filter(m => m.shouldRun?.(db))` reads
    // naturally and is wrong: an async function returns a Promise, every Promise is truthy,
    // so every guarded migration re-ran on every single boot. That was survivable only
    // because each one happened to be idempotent — migration 010 is not, and cannot be.
    const pending = [];
    for (const m of MIGRATIONS) {
        if (!applied.has(m.version) || (m.shouldRun && await m.shouldRun(db))) pending.push(m);
    }
    pending.sort((a, b) => a.version - b.version);

    if (pending.length === 0) return;

    const record = db.prepare(
        'INSERT OR REPLACE INTO SchemaVersion (version, description) VALUES (?, ?)'
    );

    for (const migration of pending) {
        await db.transaction(async () => {
            // Awaited. Since the data layer went async, an un-awaited up() returns a pending
            // promise, the transaction body resolves, and COMMIT lands BEFORE the migration's
            // statements do — so a failure half-way through could no longer roll back.
            await migration.up(db);
            await record.run(migration.version, migration.description);
        })();
        console.log(`Migration ${migration.version} applied: ${migration.description}`);
    }
}
