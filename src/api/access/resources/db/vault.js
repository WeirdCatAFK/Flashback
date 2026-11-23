import db from '../../primitives/database.js';

export async function integrityCheck() {
    return (await db.prepare('PRAGMA integrity_check').get()).integrity_check;
}

export async function wipeDerivedContent() {
    await db.transaction(async () => {
        await db.prepare('DELETE FROM DeckEntries').run();
        await db.prepare('DELETE FROM InheritedTags').run();
        await db.prepare('DELETE FROM DocumentLinks').run();
        await db.prepare('DELETE FROM Highlights').run();
        await db.prepare('DELETE FROM Flashcards').run();
        await db.prepare('DELETE FROM Documents').run();
        await db.prepare('DELETE FROM Folders').run();
        await db.prepare('DELETE FROM Decks').run();
        await db.prepare('DELETE FROM Tags').run();
        await db.prepare('DELETE FROM Media').run();
        await db.prepare('DELETE FROM Connections').run();
        await db.prepare('DELETE FROM Nodes').run();
    })();
}

export async function getCanonicalVersions() {
    return new Set((await db.prepare('SELECT version FROM CanonicalVersion').all()).map(r => r.version));
}

export async function getSchemaVersion() {
    const row = await db.prepare('SELECT MAX(version) AS version FROM SchemaVersion').get();
    return row?.version ?? 0;
}

export async function recordCanonicalVersion(version, description = null) {
    await db.prepare(
        'INSERT OR REPLACE INTO CanonicalVersion (version, description) VALUES (?, ?)'
    ).run(version, description);
}
