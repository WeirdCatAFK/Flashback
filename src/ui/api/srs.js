import { request } from './client.js';

export const getStats = () =>
  request('GET', '/api/srs/stats');

export const submitReview = (path, flashcardHash, outcome, easeFactor, newLevel) =>
  request('POST', '/api/srs/review', { path, flashcardHash, outcome, easeFactor, newLevel });

export const getDue = ({ algorithm, folder, deck, tags, maxNew } = {}) => {
  const qs = new URLSearchParams();
  if (algorithm)    qs.set('algorithm', algorithm);
  if (folder)       qs.set('folder',    folder);
  if (deck)         qs.set('deck',      deck);
  if (tags?.length) tags.forEach(t => qs.append('tag', t));
  if (maxNew != null) qs.set('maxNew',  String(maxNew));
  const q = qs.toString();
  return request('GET', `/api/srs/due${q ? `?${q}` : ''}`);
};
