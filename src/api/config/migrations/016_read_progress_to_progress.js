import { listReadProgress } from '../../access/primitives/accounts.js';
import { getVaultId } from '../../access/primitives/vault.js';

export const version = 16;
export const description = 'ReadProgress: move out of accounts.db into the progress store';

const CARRIED = ['unit', 'total', 'pos', 'pos_pct', 'far', 'far_pct', 'body_etag'];

export async function up(db) {
    let rows = [];
    try {
        rows = await listReadProgress(getVaultId());
    } catch {
        return;
    }
    if (rows.length === 0) return;

    const insert = db.prepare(`
        INSERT OR IGNORE INTO progress.ReadProgress
            (account_id, doc_hash, ${CARRIED.join(', ')}, updated_at)
        VALUES (?, ?, ${CARRIED.map(() => '?').join(', ')}, ?)
    `);

    for (const row of rows) {
        await insert.run(
            row.scope, row.doc_hash,
            ...CARRIED.map((c) => row[c] ?? null),
            row.updated_at ?? new Date().toISOString(),
        );
    }
}
