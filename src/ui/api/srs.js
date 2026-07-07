import { request } from './client.js';

export const getStats = () =>
  request('GET', '/api/srs/stats');

// opts carries the FSRS-only fields { rating, requestRetention }; Leitner/SM-2
// ignore them and rely on the client-computed outcome/easeFactor/newLevel.
export const submitReview = (path, flashcardHash, outcome, easeFactor, newLevel, algorithm, opts = {}) =>
  request('POST', '/api/srs/review', {
    path, flashcardHash, outcome, easeFactor, newLevel, algorithm,
    rating: opts.rating, requestRetention: opts.requestRetention,
  });

export const undoReview = (path, flashcardHash, algorithm) =>
  request('POST', '/api/srs/undo', { path, flashcardHash, algorithm });

export const migrateProgress = (from, to) =>
  request('POST', '/api/srs/migrate', { from, to });

// FSRS per-vault optimizer: fit the weights from this vault's review history.
export const optimizeFsrs = () =>
  request('POST', '/api/srs/optimize');

// Optimizer status (rated-review count, last-optimized timestamp) for Config.
export const getFsrsInfo = () =>
  request('GET', '/api/srs/fsrs-info');

export const getDue = ({ algorithm, folder, deck, tags, maxNew, minPriority } = {}) => {
  const qs = new URLSearchParams();
  if (algorithm)    qs.set('algorithm', algorithm);
  if (folder)       qs.set('folder',    folder);
  if (deck)         qs.set('deck',      deck);
  if (tags?.length) tags.forEach(t => qs.append('tag', t));
  if (maxNew != null) qs.set('maxNew',  String(maxNew));
  if (minPriority > 0) qs.set('minPriority', String(minPriority));
  const q = qs.toString();
  return request('GET', `/api/srs/due${q ? `?${q}` : ''}`);
};
