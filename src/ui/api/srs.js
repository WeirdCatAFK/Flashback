import { request } from './client.js';

export const getStats = () =>
  request('GET', '/api/srs/stats');

// Vault-wide analytics for the Stats view; algorithm-aware (defaults server-side).
export const getStatistics = (algorithm) =>
  request('GET', `/api/srs/statistics${algorithm ? `?algorithm=${encodeURIComponent(algorithm)}` : ''}`);

// opts carries the FSRS-only fields { rating, requestRetention }; Leitner/SM-2
// ignore them and rely on the client-computed outcome/easeFactor/newLevel.
//
// It also carries the session-ordering context { sessionId, sessionPosition, prevCardHash }
// — how this card was PRESENTED, which the server turns into ordering telemetry.
// `prevCardHash` is the card actually shown before this one, so a card re-queued after a
// failed grade is measured where it really landed. All three are optional; omitting them
// (the Flashcards view, a script) just logs the review with no ordering context.
export const submitReview = (path, flashcardHash, outcome, easeFactor, newLevel, algorithm, opts = {}) =>
  request('POST', '/api/srs/review', {
    path, flashcardHash, outcome, easeFactor, newLevel, algorithm,
    rating: opts.rating, requestRetention: opts.requestRetention,
    sessionId: opts.sessionId, sessionPosition: opts.sessionPosition,
    prevCardHash: opts.prevCardHash,
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

// Returns { queue, sessionId, order, relaxation, due, new, counts, nextDue }. `queue` is
// the session already in presentation order — the server sequenced it, so the caller must
// NOT re-sort it. `order` mirrors the `fb-trainer-order` preference.
export const getDue = ({ algorithm, folder, deck, tags, maxNew, minPriority, order } = {}) => {
  const qs = new URLSearchParams();
  if (algorithm)    qs.set('algorithm', algorithm);
  if (folder)       qs.set('folder',    folder);
  if (deck)         qs.set('deck',      deck);
  if (tags?.length) tags.forEach(t => qs.append('tag', t));
  if (maxNew != null) qs.set('maxNew',  String(maxNew));
  if (minPriority > 0) qs.set('minPriority', String(minPriority));
  if (order)        qs.set('order',     order);
  const q = qs.toString();
  return request('GET', `/api/srs/due${q ? `?${q}` : ''}`);
};
