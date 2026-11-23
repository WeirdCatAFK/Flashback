import db from '../../primitives/database.js';
import { READ_FIELDS, scoped } from './sql.js';

export async function save(scope, docHash, state = {}) {
    await db.prepare(`
        INSERT INTO progress.ReadProgress
            (account_id, doc_hash, ${READ_FIELDS.join(', ')}, updated_at)
        VALUES (?, ?, ${READ_FIELDS.map(() => '?').join(', ')}, ?)
        ON CONFLICT(account_id, doc_hash) DO UPDATE SET
            ${READ_FIELDS.map(f => `${f} = excluded.${f}`).join(', ')},
            updated_at = excluded.updated_at
    `).run(
        scoped(scope), docHash,
        ...READ_FIELDS.map(f => state[f] ?? null),
        new Date().toISOString(),
    );
}

export async function get(scope, docHash) {
    return await db.prepare(
        'SELECT * FROM progress.ReadProgress WHERE account_id = ? AND doc_hash = ?',
    ).get(scoped(scope), docHash) ?? null;
}

export async function list(scope) {
    return await db.prepare(`
        SELECT * FROM progress.ReadProgress
        WHERE account_id = ?
        ORDER BY updated_at DESC
    `).all(scoped(scope));
}

export async function remove(scope, docHash) {
    await db.prepare(
        'DELETE FROM progress.ReadProgress WHERE account_id = ? AND doc_hash = ?',
    ).run(scoped(scope), docHash);
}
