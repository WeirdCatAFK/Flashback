/**
 * Seal view describers — how a raw commit label becomes what the user touched.
 * Pure modules under src/ui/views/seal; identity `t`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommitMessage, describeTarget, describeCommit, formatOid, formatCommitTime, isSidecar, documentPath } from '../src/ui/views/seal/describe.js';
import { collectDoctorIssues, TONE_CLASS } from '../src/ui/views/seal/doctor.js';
import { titleOf, sealLine, dayOf, byDay, foldRuns, runHolding, driftCount } from '../src/ui/views/seal/history.js';

const tr = { t: (s, v) => (v ? s.replace(/\{(\w+)\}/g, (_, k) => v[k]) : s), tp: (one, other, n) => (n === 1 ? one : other).replace('{n}', n) };

describe('parseCommitMessage', () => {
  test('splits action and detail; a move becomes an arrow', () => {
    assert.deepEqual(parseCommitMessage('edit: notes/a.md.flashback'), { action: 'edit', detail: 'notes/a.md.flashback' });
    assert.deepEqual(parseCommitMessage('move: a.md -> b/a.md'), { action: 'move', detail: 'a.md → b/a.md' });
    assert.deepEqual(parseCommitMessage('nonsense'), { action: 'unknown', detail: 'nonsense' });
  });
});

describe('describeTarget', () => {
  test('a document sidecar reads as the document', () => {
    assert.deepEqual(describeTarget('notes/Chapter 1.md.flashback', tr), { name: 'Chapter 1.md', dir: 'notes' });
  });
  test('a folder sidecar reads as the folder, the root one as the workspace', () => {
    assert.deepEqual(describeTarget('notes/sub/.flashback', tr), { name: 'sub/', dir: 'notes' });
    assert.deepEqual(describeTarget('.flashback', tr), { name: 'the workspace', dir: '' });
  });
  test('batch labels and deck files', () => {
    assert.equal(describeTarget('3 sidecars', tr).name, '3 documents');
    assert.equal(describeTarget('1 files', tr).name, '1 file');
    assert.equal(describeTarget('_decks/abc.json', tr).name, 'a deck');
    assert.equal(describeTarget('', tr), null);
  });
  test('backslashes are normalised', () => {
    assert.equal(describeTarget('a\\b\\c.md.flashback', tr).dir, 'a/b');
  });
});

describe('describeCommit', () => {
  const commit = (message, stats) => ({ commit: { message }, stats });
  test('an edit that touched only sidecars is a metadata update', () => {
    const row = describeCommit(commit('edit: notes/a.md.flashback', { added: 0, modified: 1, deleted: 0, content: 0 }), tr);
    assert.equal(row.variant, 'metadata');
    assert.equal(row.detail, 'Metadata updated for a.md');
    assert.equal(row.dir, 'notes');
  });
  test('an edit with content changes keeps its action', () => {
    const row = describeCommit(commit('edit: notes/a.md.flashback', { added: 0, modified: 2, deleted: 0, content: 1 }), tr);
    assert.equal(row.variant, 'edit');
    assert.equal(row.detail, 'a.md');
  });
  test('a move keeps the raw arrow', () => {
    const row = describeCommit(commit('move: a.md -> b/a.md', null), tr);
    assert.equal(row.variant, 'move');
    assert.equal(row.detail, 'a.md → b/a.md');
  });
});

describe('small helpers', () => {
  test('formatOid / isSidecar / documentPath', () => {
    assert.equal(formatOid('0123456789abcdef'), '0123456');
    assert.equal(formatOid(null), '');
    assert.equal(isSidecar('x.md.flashback'), true);
    assert.equal(documentPath('x.md.flashback'), 'x.md');
    assert.equal(documentPath('x.md'), 'x.md');
  });
  test('formatCommitTime takes unix seconds', () => {
    const out = formatCommitTime(1000, { formatRelative: (ms) => `rel:${ms}`, formatDateTime: (ms) => `abs:${ms}` });
    assert.deepEqual(out, { relative: 'rel:1000000', absolute: 'abs:1000000' });
    assert.deepEqual(formatCommitTime(0, {}), { relative: '', absolute: '' });
  });
});

describe('collectDoctorIssues', () => {
  const empty = () => ({
    documents: { missingInDb: [], orphanedInDb: [], modified: [], hashConflicts: [], corruptSidecars: [], untracked: [] },
    folders: { missingInDb: [], orphanedInDb: [], ghostDirs: [], corruptSidecars: [] },
    media: { unregistered: [], missingOnDisk: [] },
    decks: { fileWithoutDb: [], dbWithoutFile: [], corruptFiles: [], entryMismatches: [], danglingEntries: [] },
  });
  test('a clean report yields no groups', () => {
    assert.deepEqual(collectDoctorIssues(empty(), tr.t), []);
  });
  test('only non-empty groups appear, with their tone', () => {
    const r = empty();
    r.documents.missingInDb = ['a.md'];
    r.decks.entryMismatches = [{ deckHash: 'abcdef0123', missingInDb: [1, 2], missingInFile: [] }];
    const groups = collectDoctorIssues(r, tr.t);
    assert.equal(groups.length, 2);
    assert.equal(groups[0].tone, 'added');
    assert.equal(groups[1].paths[0], 'abcdef01…  ·  +2 / −0');
    assert.ok(TONE_CLASS[groups[0].tone]);
  });
});

/** A commit as the log returns it; `at` is a local Date, `stats` defaults to one modified sidecar. */
const commit = (oid, message, at, { email = 'me@x', stats = { added: 0, modified: 1, deleted: 0, content: 0 } } = {}) => ({
  oid,
  commit: { message, author: { name: email.split('@')[0], email, timestamp: Math.floor(at.getTime() / 1000) } },
  stats,
});
const at = (d, h, m = 0) => new Date(2026, 8, d, h, m);
const TEXT = { added: 0, modified: 2, deleted: 0, content: 1 };

describe('sealLine', () => {
  test('a created document, folder and deck', () => {
    assert.deepEqual(sealLine(commit('a', 'create: notes/Ch 1.md.flashback', at(1, 9)), tr), { kind: 'added', name: 'Ch 1', dir: 'notes', from: '' });
    assert.equal(sealLine(commit('b', 'create: notes/Sub/.flashback', at(1, 9)), tr).kind, 'folder');
    assert.equal(sealLine(commit('b', 'create: notes/Sub/.flashback', at(1, 9)), tr).name, 'Sub');
    assert.equal(sealLine(commit('c', 'create: _decks/0f3a.json', at(1, 9)), tr).kind, 'deck');
  });

  test('an edit is the text when content changed, metadata when only sidecars did', () => {
    assert.equal(sealLine(commit('a', 'edit: notes/Ch 1.md.flashback', at(1, 9), { stats: TEXT }), tr).kind, 'text');
    assert.equal(sealLine(commit('a', 'edit: notes/Ch 1.md.flashback', at(1, 9)), tr).kind, 'metadata');
  });

  test('a move within its folder is a rename; across folders, a move from the old folder', () => {
    assert.deepEqual(sealLine(commit('a', 'move: notes/Old.md -> notes/New.md', at(1, 9)), tr), { kind: 'renamed', name: 'New', dir: 'notes', from: 'Old' });
    assert.deepEqual(sealLine(commit('a', 'move: notes/A.md -> archive/A.md', at(1, 9)), tr), { kind: 'moved', name: 'A', dir: 'archive', from: 'notes' });
    assert.equal(sealLine(commit('a', 'move: A.md -> archive/A.md', at(1, 9)), tr).from, '');
  });

  test('delete, reconcile and anything unknown', () => {
    assert.equal(sealLine(commit('a', 'delete: notes/Gone.md.flashback', at(1, 9)), tr).kind, 'deleted');
    assert.deepEqual(sealLine(commit('a', 'reconcile: 12 files', at(1, 9)), tr), { kind: 'reconcile', name: '12 files', dir: '', from: '' });
    assert.deepEqual(sealLine(commit('a', 'Initial commit', at(1, 9)), tr), { kind: 'other', name: 'Initial commit', dir: '', from: '' });
  });

  test('titles drop the extension, folders their slash', () => {
    assert.equal(titleOf('Memory (1885).epub'), 'Memory (1885)');
    assert.equal(titleOf('Sub/'), 'Sub');
    assert.equal(titleOf('README'), 'README');
  });
});

describe('days and runs', () => {
  const doc = 'edit: notes/Book.epub.flashback';
  const log = [
    commit('h', doc, at(24, 14, 2)),
    commit('g', doc, at(24, 13, 58)),
    commit('f', doc, at(24, 13, 55), { email: 'other@x' }),
    commit('e', doc, at(24, 13, 51), { stats: TEXT }),
    commit('d', doc, at(24, 13, 40)),
    commit('c', doc, at(24, 13, 30)),
    commit('b', 'create: notes/Book.epub.flashback', at(23, 20)),
  ];

  test('local calendar days, newest first', () => {
    assert.equal(dayOf(log[0]), '2026-09-24');
    assert.deepEqual(byDay(log).map((d) => [d.day, d.commits.length]), [['2026-09-24', 6], ['2026-09-23', 1]]);
  });

  test('consecutive metadata edits by one author on one target fold; anything between breaks the run', () => {
    const groups = foldRuns(byDay(log)[0].commits, tr);
    assert.deepEqual(groups.map((g) => (g.kind === 'run' ? g.commits.map((c) => c.oid).join('') : g.commit.oid)), ['hg', 'f', 'e', 'dc']);
    assert.equal(groups[0].key, 'h');
  });

  test('the run holding a seal, for the ribbon to open', () => {
    assert.equal(runHolding(log, 'g', tr), 'h');
    assert.equal(runHolding(log, 'c', tr), 'd');
    assert.equal(runHolding(log, 'f', tr), null);
  });

  test('drift counts every file changed outside Flashback', () => {
    assert.equal(driftCount({ added: ['a'], modified: ['b', 'c'], deleted: [] }), 3);
    assert.equal(driftCount(null), 0);
  });
});
