import { request } from './client.js';

// `cursor` is the oid of the last commit already held; the returned page resumes after it.
// A page shorter than `limit` means there is no more history.
export const getLog = ({ limit = 20, cursor = null } = {}) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor) params.set('cursor', cursor);
    return request('GET', `/api/seal/log?${params}`);
};

export const inspectDrift = () =>
    request('GET', '/api/seal/inspect');

export const getCommitFiles = (oid) =>
    request('GET', `/api/seal/commit/${oid}/files`);

export const rollback = (ref, keepSrsProgress = true) =>
    request('POST', '/api/seal/rollback', { ref, keepSrsProgress });
