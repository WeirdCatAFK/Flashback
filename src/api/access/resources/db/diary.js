import db from '../../primitives/database.js';
import { scoped } from './sql.js';

export async function getEntry(date, scope) {
    const row = await db.prepare('SELECT content FROM progress.DiaryEntries WHERE account_id = ? AND date = ?').get(scoped(scope), date);
    return row?.content ?? null;
}

export async function listEntries(scope) {
    return await db.prepare('SELECT date, content FROM progress.DiaryEntries WHERE account_id = ? ORDER BY date').all(scoped(scope));
}

export async function saveEntry(date, content, scope) {
    await db.prepare(`
        INSERT INTO progress.DiaryEntries (account_id, date, content, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(account_id, date) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at
    `).run(scoped(scope), date, content, new Date().toISOString());
}

export async function addEntry(date, content, scope) {
    const info = await db.prepare(`
        INSERT INTO progress.DiaryEntries (account_id, date, content, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(account_id, date) DO NOTHING
    `).run(scoped(scope), date, content, new Date().toISOString());
    return info.changes > 0;
}

export async function getSummary(date, scope) {
    const row = await db.prepare('SELECT summary FROM DiarySummaries WHERE scope = ? AND date = ?').get(scoped(scope), date);
    return row ? JSON.parse(row.summary) : null;
}

export async function putSummary(date, summary, scope) {
    await db.prepare('INSERT OR REPLACE INTO DiarySummaries (scope, date, summary) VALUES (?, ?, ?)')
        .run(scoped(scope), date, JSON.stringify(summary));
}

export async function clearSummaries(scope) {
    await db.prepare('DELETE FROM DiarySummaries WHERE scope = ?').run(scoped(scope));
}
