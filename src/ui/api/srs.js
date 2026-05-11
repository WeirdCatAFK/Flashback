import { request } from './client.js';

export const getStats = () =>
  request('GET', '/api/srs/stats');

export const submitReview = (path, flashcardHash, outcome, easeFactor, newLevel) =>
  request('POST', '/api/srs/review', { path, flashcardHash, outcome, easeFactor, newLevel });
