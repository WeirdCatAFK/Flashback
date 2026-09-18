/**
 * Seal view describers — how a raw commit label becomes what the user touched.
 * Pure modules under src/ui/views/seal; identity `t`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommitMessage, describeTarget, describeCommit, formatOid, formatCommitTime, isSidecar, documentPath } from '../src/ui/views/seal/describe.js';
import { collectDoctorIssues, TONE_CLASS } from '../src/ui/views/seal/doctor.js';

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
