export const version = 2;
export const description = 'Inter-document links: DocumentLinks queue table + link ConnectionType';

export async function shouldRun(db) {
    const hasTable = await db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='DocumentLinks'"
    ).get();
    const hasLinkType = await db.prepare(
        "SELECT id FROM ConnectionTypes WHERE name='link'"
    ).get();
    return !hasTable || !hasLinkType;
}

export async function up(db) {

    await db.exec(`
        CREATE TABLE IF NOT EXISTS DocumentLinks (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            source_hash TEXT NOT NULL,
            target_hash TEXT NOT NULL,
            anchor_text TEXT,
            UNIQUE(source_hash, target_hash)
        )
    `);

    await db.exec(`CREATE INDEX IF NOT EXISTS idx_doclinks_source ON DocumentLinks(source_hash)`);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_doclinks_target ON DocumentLinks(target_hash)`);

    await db.prepare(
        `INSERT OR IGNORE INTO ConnectionTypes (name, is_directed) VALUES ('link', 1)`
    ).run();
}
