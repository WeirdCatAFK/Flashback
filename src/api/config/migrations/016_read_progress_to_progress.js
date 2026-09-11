// Migration 016 — ReadProgress moves out of the accounts store
//
// The last table to leave. `accounts.db` was always meant to answer one question — who may reach
// this install, and as what — and it ended up holding two kinds of progress as well, purely
// because it was the only store that did not travel with a copied vault. `AccountProgress` left
// in 015; this is where reading positions follow, and afterwards the accounts store is identity
// and access alone.
//
// Reading positions were never split the way schedules were: `ReadProgress` has always held
// everyone's, the owner included under the `'owner'` sentinel, for the reasons in DATAMODEL.md
// § Read progress — a scroll position moves continuously, so sidecar storage would turn reading
// into a commit stream, and a Reader must be able to record one at all. That model is unchanged.
// Only the file changes.
//
// Two columns go on the way:
//
//   - `vault_id` disappears. `accounts.db` is install-scoped and can hold several vaults, so it
//     needed the discriminator; `{vault}/progress.db` IS one vault's, so carrying it would be
//     recording a constant in every row.
//   - `scope` becomes `account_id`. Same values — an account id or `'owner'` — but the progress
//     store already calls that column `account_id` in all five other tables, and one store should
//     not use two words for one idea.
//
// No `shouldRun` is exported deliberately. The rows stay in `accounts.db` afterwards (this
// refactor moves by copy and never deletes the old copy in the same change), so any guard phrased
// as "are there rows to move?" would answer yes forever and re-run on every launch. Recorded in
// `SchemaVersion` like an ordinary migration, and `INSERT OR IGNORE` makes a re-run harmless.
//
// Rows belonging to a deleted account are not carried across. `listReadProgress` has always
// filtered them out of every read — quietly dropping one on a read would turn a temporarily
// missing account into permanent loss — so they were already invisible, and copying them would
// resurrect nothing.
//
// The rows arrive already repaired, and the ordering that makes that true is not incidental:
// `accounts.js` applies its `REPAIRS` inside `onOpen`, and the read below is what opens the
// store. Repair 1 clears the EPUB percentages that were written on two different scales (see
// DATAMODEL.md § Read progress), so copying before it ran would carry the bad figures across
// and put them somewhere the repair can no longer reach.

import { listReadProgress } from '../../access/primitives/accounts.js';
import { getVaultId } from '../../access/primitives/vault.js';

export const version = 16;
export const description = 'ReadProgress: move out of accounts.db into the progress store';

const CARRIED = ['unit', 'total', 'pos', 'pos_pct', 'far', 'far_pct', 'body_etag'];

/** @param {object} db */
export async function up(db) {
    let rows = [];
    try {
        rows = await listReadProgress(getVaultId());
    } catch {
        // No accounts store, or none for this vault: nothing to carry.
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
