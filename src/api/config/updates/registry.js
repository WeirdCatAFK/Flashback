// The ordered list of canonical updates, and the version a freshly written canonical file
// is stamped with.
//
// This module is deliberately a LEAF: it imports the update modules (which are pure
// transforms importing nothing) and nothing else. `files.js` reads `LATEST_VERSION` from
// here to stamp new sidecars, so anything heavier in this file would put the whole access
// layer in an import cycle.
//
// Import update modules here in order — never reorder or remove entries.
import * as u001 from './001_type_answer_split.js';

export const UPDATES = [u001];

/**
 * The version a canonical file is at once every update has been applied to it.
 * A file with no `formatVersion` key is version 0: either it predates versioning, or it was
 * written by a caller that assembled its own metadata object. Either way the runner treats
 * it as needing every update — which is safe precisely because each update is idempotent
 * per item (see UPDATES.md).
 */
export const LATEST_VERSION = UPDATES.reduce((max, u) => Math.max(max, u.version), 0);

/** The updates an item at `itemVersion` still needs, in ascending order. */
export function pendingFor(itemVersion, updates = UPDATES) {
    return updates
        .filter(u => u.version > (itemVersion ?? 0))
        .sort((a, b) => a.version - b.version);
}
