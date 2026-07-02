import { request } from './client.js';

export const getLog = (limit = 20) =>
    request('GET', `/api/seal/log?limit=${limit}`);

export const inspectDrift = () =>
    request('GET', '/api/seal/inspect');

export const getCommitFiles = (oid) =>
    request('GET', `/api/seal/commit/${oid}/files`);

export const rollback = (ref, keepSrsProgress = true) =>
    request('POST', '/api/seal/rollback', { ref, keepSrsProgress });
