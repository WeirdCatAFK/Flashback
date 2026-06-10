import { request } from './client.js';

export function superSearch({ q, tag, deck, document: docQ, folder, limit = 20 } = {}) {
    const params = new URLSearchParams();
    if (q)      params.set('q', q);
    if (tag)    params.set('tag', tag);
    if (deck)   params.set('deck', deck);
    if (docQ)   params.set('document', docQ);
    if (folder) params.set('folder', folder);
    params.set('limit', limit);
    return request('GET', `/api/search?${params.toString()}`);
}
