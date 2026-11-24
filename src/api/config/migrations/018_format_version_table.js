export const version = 18;
export const description = 'CanonicalVersion becomes FormatVersion';

async function mainHasTable(db, name) {
    return !!await db.prepare("SELECT 1 FROM main.sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

export async function up(db) {
    if (!await mainHasTable(db, 'CanonicalVersion')) return;
    if (!await mainHasTable(db, 'FormatVersion')) {
        await db.exec('ALTER TABLE main.CanonicalVersion RENAME TO FormatVersion');
        return;
    }
    await db.exec(`INSERT OR IGNORE INTO main.FormatVersion (version, applied_at, description)
        SELECT version, applied_at, description FROM main.CanonicalVersion`);
    await db.exec('DROP TABLE main.CanonicalVersion');
}
