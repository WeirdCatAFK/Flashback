import { request } from './client.js';

// Read-only whole-vault consistency report (disk vs. the derived index).
export const checkIndex = () =>
    request('GET', '/api/doctor/check');

// Apply the check report — index missing items, drop orphans, resync modified
// documents. `sealDrift` seals any out-of-band sidecar changes into one commit.
export const syncIndex = (sealDrift = true) =>
    request('POST', '/api/doctor/sync', { sealDrift });

// Wipe the index and rebuild it from the canonical files. Destructive to
// ReviewLogs history; the backend requires the exact confirm token.
export const rebuildIndex = () =>
    request('POST', '/api/doctor/rebuild', { confirm: 'REBUILD' });
