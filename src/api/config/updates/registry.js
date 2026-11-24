import * as u001 from './001_type_answer_split.js';

/**
 * Each up(meta, kind) is pure, synchronous and idempotent per file. It returns true only when it changed the file.
 * The runner owns formatVersion. Readers accept both shapes, because a Seal rollback restores old files.
 * A one-way update needs a DATAMODEL.md row, and its release text must tell users they cannot downgrade. Never reorder or remove an entry.
 */
export const UPDATES = [u001];

export const LATEST_VERSION = UPDATES.reduce((max, u) => Math.max(max, u.version), 0);

export function pendingFor(itemVersion, updates = UPDATES) {
    return updates
        .filter(u => u.version > (itemVersion ?? 0))
        .sort((a, b) => a.version - b.version);
}
