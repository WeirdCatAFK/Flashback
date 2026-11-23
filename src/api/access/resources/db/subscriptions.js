import db from '../../primitives/database.js';

export async function get(magazineId) {
    return await db.prepare('SELECT * FROM Subscriptions WHERE magazine_id = ?').get(magazineId);
}

export async function list() {
    return await db.prepare('SELECT * FROM Subscriptions').all();
}

export async function upsert(data) {
    const stmt = db.prepare(`
        INSERT INTO Subscriptions (magazine_id, issue_id, version, target_path, last_sync)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(magazine_id) DO UPDATE SET
            issue_id = excluded.issue_id,
            version = excluded.version,
            target_path = excluded.target_path,
            last_sync = CURRENT_TIMESTAMP
    `);
    return await stmt.run(data.magazineId, data.issueId, data.version, data.targetPath);
}
