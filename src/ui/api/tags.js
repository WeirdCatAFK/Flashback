import { request } from './client.js';

// Tags live under the documents domain (they attach to files/folders), but they
// are vault-wide metadata — the Manage view reads them here.

export const getTags = () =>
  request('GET', '/api/documents/tags').then((r) => r.tags);

// [{ name, count }] — count is how many entities apply the tag directly.
export const getTagUsage = () =>
  request('GET', '/api/documents/tags/usage').then((r) => r.tags);
