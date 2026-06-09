import { request } from './client.js';

export const getStats = () =>
  request('GET', '/api/srs/stats');

export const submitReview = (path, flashcardHash, outcome, easeFactor, newLevel, algorithm) =>
  request('POST', '/api/srs/review', { path, flashcardHash, outcome, easeFactor, newLevel, algorithm });

export const migrateProgress = (from, to) =>
  request('POST', '/api/srs/migrate', { from, to });

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
