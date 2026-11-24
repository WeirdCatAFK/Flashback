import db from '../../primitives/database.js';
import { scoped } from './sql.js';

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
