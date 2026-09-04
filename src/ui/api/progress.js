import { request } from './client.js';

// Read progress — where the current user has read to, and how far through a folder.
//
// Every call here is about the caller's own reading; nothing in this module can reach
// anyone else's positions. Recording a position writes no file and produces no Seal
// commit, which is why a Reader may do it even though they cannot save a document.
// See src/api/API.md § Read progress.

const q = (params) => {
  const parts = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const v of value) parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
    }
  }
  return parts.length ? `?${parts.join('&')}` : '';
};

/**
 * Where the caller has read to in one document.
 * @param {string} path - relative path from the workspace root.
 * @returns {Promise<{ unit, total, position, percent, furthest, furthestPercent,
 *   finished, stale, updatedAt }|null>} null when they have never opened it.
 */
export const getProgress = (path) => request('GET', `/api/progress${q({ path })}`);

/**
 * Records a position.
 *
 * `mode` is the whole auto-versus-manual rule: 'auto' advances the furthest mark only
 * forward, so scrolling back never costs you your place; 'manual' sets it exactly,
 * including backwards, which is what makes a correction possible.
 *
 * @param {string} path
 * @param {{unit: string, position: object, percent?: number, total?: number,
 *   mode?: 'auto'|'manual'}} body
 */
export const setProgress = (path, body) => request('PUT', '/api/progress', { path, ...body });

/** Forgets the caller's position in one document. */
export const clearProgress = (path) => request('DELETE', `/api/progress${q({ path })}`);

/**
 * One folder listing's worth of progress in a single call: `documents` keyed by
 * globalHash, `folders` keyed by path with a subtree rollup each.
 *
 * Shaped to mirror listFolder so the explorer draws a level at a time and never issues
 * a request per node.
 * @param {string} folder - folder to list; '' for the workspace root.
 * @param {string[]} folders - subfolder paths to roll up.
 */
export const listProgress = (folder, folders = []) =>
  request('GET', `/api/progress/list${q({ folder, folders })}`);

/** How far through one folder the caller is. */
export const getRollup = (path) => request('GET', `/api/progress/rollup${q({ path })}`);

/** What the caller is partway through, most recently read first. */
export const listReading = (limit) => request('GET', `/api/progress/reading${q({ limit })}`);

/** The span read but not yet turned into flashcards. */
export const getCoverage = (path) => request('GET', `/api/progress/coverage${q({ path })}`);
