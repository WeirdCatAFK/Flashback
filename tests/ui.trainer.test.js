/**
 * Trainer session maths — the pure modules under src/ui/views/trainer.
 * No React, no DOM, no vault: runs under plain `node --test`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { REQUEUE_LAG, insertIndexFor, requeueFailed, startSession, applyResult, undoResult, sessionFigures } from '../src/ui/views/trainer/queue.js';
import { gradeSm2, gradesFor, isTypedCorrect, GRADES, FSRS_GRADES } from '../src/ui/views/trainer/grading.js';
import { normalizeScope, hasExclusions, initialScope, withExclusion, withoutExclusion, mergeStudySession, sameScope } from '../src/ui/views/trainer/scope.js';
import { mapApiCard } from '../src/ui/views/trainer/cards.js';

const card = (hash, priority = 0, extra = {}) => ({ globalHash: hash, categoryPriority: priority, level: 1, easeFactor: 2.5, ...extra });
const t = (s) => s;

describe('queue: re-inserting a failed card', () => {
  test('never lands at index 0 when anything else is waiting', () => {
    const rest = [card('a'), card('b'), card('c')];
    assert.ok(insertIndexFor(rest, 0) >= 1);
  });

  test('lands at REQUEUE_LAG in a long same-tier queue', () => {
    const rest = Array.from({ length: 10 }, (_, i) => card(`c${i}`));
    assert.equal(insertIndexFor(rest, 0), REQUEUE_LAG);
  });

  test('clamps to the end of its pedagogical tier', () => {
    const rest = [card('a', 0), card('b', 0), card('c', 5), card('d', 5)];
    assert.equal(insertIndexFor(rest, 0), 2);
  });

  test('goes to index 0 only when the queue is otherwise empty', () => {
    assert.equal(insertIndexFor([], 0), 0);
    assert.deepEqual(requeueFailed([], card('x')).map((c) => c.globalHash), ['x']);
  });

  test('requeueFailed keeps every other card in order', () => {
    const rest = Array.from({ length: 6 }, (_, i) => card(`c${i}`));
    const out = requeueFailed(rest, card('failed'));
    assert.deepEqual(out.map((c) => c.globalHash), ['c0', 'c1', 'c2', 'c3', 'failed', 'c4', 'c5']);
  });
});

describe('queue: applyResult / undoResult', () => {
  const cards = [card('a'), card('b'), card('c')];

  test('a pass drops the head and counts the grade', () => {
    const s = applyResult(startSession(cards), { key: 'good', success: true, toLevel: 2, easeFactor: 2.5, total: 3 });
    assert.deepEqual(s.queue.map((c) => c.globalHash), ['b', 'c']);
    assert.equal(s.stats.good, 1);
    assert.equal(s.sessionDone, false);
    assert.equal(s.presented.position, 1);
    assert.equal(s.presented.prevCardHash, 'a');
  });

  test('a fail re-queues the head with its new level and ease', () => {
    const s = applyResult(startSession(cards), { key: 'again', success: false, toLevel: 1, easeFactor: 2.3, total: 3, now: 'T' });
    assert.equal(s.queue.length, 3);
    const failed = s.queue.find((c) => c.globalHash === 'a');
    assert.equal(failed.level, 1);
    assert.equal(failed.easeFactor, 2.3);
    assert.equal(failed.lastRecall, 'T');
    assert.notEqual(s.queue[0].globalHash, 'a');
  });

  test('passing the last card completes the session and snapshots the tally', () => {
    const s = applyResult(startSession([card('only')]), { key: 'easy', success: true, toLevel: 3, easeFactor: 2.65, total: 1 });
    assert.equal(s.sessionDone, true);
    assert.deepEqual(s.lastSession, { total: 1, stats: { again: 0, good: 0, easy: 1 } });
  });

  test('undo restores the exact previous state, including the presentation trace', () => {
    const before = startSession(cards);
    const after = applyResult(before, { key: 'again', success: false, toLevel: 1, easeFactor: 2.3, total: 3 });
    const undone = undoResult(after);
    assert.deepEqual(undone.queue, before.queue);
    assert.deepEqual(undone.stats, before.stats);
    assert.deepEqual(undone.presented, before.presented);
    assert.equal(undone.lastAction, null);
    assert.equal(undoResult(before), before);
  });

  test('sessionFigures', () => {
    assert.deepEqual(sessionFigures({ again: 1, good: 2, easy: 1 }, 10, 6), { reviews: 4, accuracy: 75, passed: 4, progress: 0.4 });
    assert.deepEqual(sessionFigures({ again: 0, good: 0, easy: 0 }, 0, 0), { reviews: 0, accuracy: 0, passed: 0, progress: 0 });
  });
});

describe('grading', () => {
  test('ease is clamped to 1.3..3.0', () => {
    assert.equal(gradeSm2({ easeFactor: 1.35, level: 2 }, 'again', 'sm2').easeFactor, 1.3);
    assert.equal(gradeSm2({ easeFactor: 2.95, level: 2 }, 'easy', 'sm2').easeFactor, 3.0);
  });

  test('Leitner "Again" floors at level 1; SM-2 goes to 0', () => {
    assert.equal(gradeSm2({ level: 4 }, 'again', 'leitner').toLevel, 1);
    assert.equal(gradeSm2({ level: 4 }, 'again', 'sm2').toLevel, 0);
  });

  test('good and easy climb one and two levels', () => {
    assert.equal(gradeSm2({ level: 2 }, 'good', 'sm2').toLevel, 3);
    assert.equal(gradeSm2({ level: 2 }, 'easy', 'sm2').toLevel, 4);
    assert.equal(gradeSm2({ level: 2 }, 'good', 'sm2').success, true);
    assert.equal(gradeSm2({ level: 2 }, 'again', 'sm2').outcome, 0);
  });

  test('gradesFor resolves labels and picks the FSRS table', () => {
    const sm2 = gradesFor('sm2', t);
    assert.deepEqual(Object.keys(sm2), Object.keys(GRADES));
    assert.equal(sm2.good.label, 'Good');
    const fsrs = gradesFor('fsrs', t);
    assert.deepEqual(Object.keys(fsrs), Object.keys(FSRS_GRADES));
    assert.equal(fsrs.hard.rating, 2);
  });

  test('typed answers compare case- and whitespace-insensitively', () => {
    assert.equal(isTypedCorrect('  Tokyo ', 'tokyo'), true);
    assert.equal(isTypedCorrect(null, 'tokyo'), false);
    assert.equal(isTypedCorrect('kyoto', 'tokyo'), false);
  });
});

describe('scope', () => {
  test('an old saved blob without exclusions normalizes without throwing', () => {
    const s = initialScope(null, JSON.stringify({ folder: 'x' }));
    assert.equal(s.folder, 'x');
    assert.deepEqual(s.exclude, { folders: [], documents: [], decks: [], tags: [] });
    assert.equal(hasExclusions(s.exclude), false);
  });

  test('garbage in localStorage falls back to an empty scope', () => {
    assert.deepEqual(initialScope(null, '{not json'), normalizeScope(null));
  });

  test('exclusions are keyed by hash for decks and by value otherwise', () => {
    let s = normalizeScope(null);
    s = withExclusion(s, 'decks', { hash: 'h1', name: 'A' });
    s = withExclusion(s, 'decks', { hash: 'h1', name: 'A again' });
    s = withExclusion(s, 'tags', 'x');
    s = withExclusion(s, 'tags', 'x');
    assert.equal(s.exclude.decks.length, 1);
    assert.equal(s.exclude.tags.length, 1);
    assert.equal(hasExclusions(s.exclude), true);
    s = withoutExclusion(s, 'decks', 'h1');
    s = withoutExclusion(s, 'tags', 'x');
    assert.equal(hasExclusions(s.exclude), false);
  });

  test('an exclusion-only hand-over widens the current exclusions; anything else replaces', () => {
    const current = normalizeScope({ folder: 'f', exclude: { folders: ['a'] } });
    const widened = mergeStudySession(current, { exclude: { folders: ['b'], documents: ['d'] } });
    assert.equal(widened.folder, 'f');
    assert.deepEqual(widened.exclude.folders, ['a', 'b']);
    assert.deepEqual(widened.exclude.documents, ['d']);
    const replaced = mergeStudySession(current, { deck: 'k' });
    assert.equal(replaced.folder, null);
    assert.equal(replaced.deck, 'k');
  });

  test('sameScope', () => {
    const current = normalizeScope({ folder: 'f' });
    assert.equal(sameScope(current, { folder: 'f' }), true);
    assert.equal(sameScope(current, { folder: 'g' }), false);
    assert.equal(sameScope(current, { exclude: { folders: [] } }), false);
  });
});

describe('cards', () => {
  test('mapApiCard flattens the row and draws a reversible direction once', () => {
    const raw = { global_hash: 'h', card_type: 'reversible', frontText: 'f', backText: 'b', level: 2 };
    assert.equal(mapApiCard(raw, true, () => 0.9).direction, 'reverse');
    assert.equal(mapApiCard(raw, true, () => 0.1).direction, 'forward');
    const c = mapApiCard({ ...raw, card_type: 'basic', custom_html: '<b/>' });
    assert.equal(c.direction, 'forward');
    assert.equal(c.customData.html, '<b/>');
    assert.equal(c.vanillaData.answerText, null);
    assert.equal(c.isNew, false);
  });
});
