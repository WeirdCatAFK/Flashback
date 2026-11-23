import * as u001 from './001_type_answer_split.js';

export const UPDATES = [u001];

export const LATEST_VERSION = UPDATES.reduce((max, u) => Math.max(max, u.version), 0);

export function pendingFor(itemVersion, updates = UPDATES) {
    return updates
        .filter(u => u.version > (itemVersion ?? 0))
        .sort((a, b) => a.version - b.version);
}
