import { request } from './client.js';

export const getHighlights = (path) =>
  request('GET', `/api/highlights?path=${encodeURIComponent(path)}`);

export const createHighlight = (path, data) =>
  request('POST', '/api/highlights', { path, ...data });

export const updateHighlight = (path, hash, data) =>
  request('PUT', `/api/highlights/${hash}`, { path, ...data });

export const deleteHighlight = (path, hash) =>
  request('DELETE', `/api/highlights/${hash}?path=${encodeURIComponent(path)}`);
