/**
 * Config's catalogue and search (src/ui/views/config/settings.js): which rows exist in
 * which situation, how search matches them, and the summaries the index derives. No DOM,
 * no React; identity `t`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SECTIONS, sectionName, settingRows, searchSettings, hitsBySection, changedShortcuts, diaryAccessOf } from '../src/ui/views/config/settings.js';

const t = (s, vars = {}) => s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`));
const ids = (rows) => rows.map((r) => r.id);

describe('settingRows', () => {
  test('every row belongs to a known section, and ids are unique', () => {
    const rows = settingRows(t, { fsrs: true, desktop: true, customPath: true });
    const sections = new Set(SECTIONS.map((s) => s.id));
    assert.ok(rows.every((r) => sections.has(r.section)));
    assert.equal(new Set(ids(rows)).size, rows.length);
  });

  test('FSRS rows only under FSRS', () => {
    assert.ok(!ids(settingRows(t, {})).includes('retention'));
    assert.ok(ids(settingRows(t, { fsrs: true })).includes('optimize'));
  });

  test('the desktop-only sections have no rows outside the desktop app; the tour stays', () => {
    const web = settingRows(t, { desktop: false });
    assert.ok(!web.some((r) => r.section === 'server' || r.section === 'ai'));
    assert.ok(ids(web).includes('tour'));
    assert.ok(!ids(settingRows(t, { desktop: true })).includes('workspacePath'));
    assert.ok(ids(settingRows(t, { desktop: true, customPath: true })).includes('workspacePath'));
  });

  test('the diary row takes the study record’s words; the assistant’s always says diary', () => {
    const rows = settingRows(t, { desktop: true, shared: true, studyRecord: { prefLabel: 'Study log', prefHint: 'Writes a per-day summary.' } });
    assert.equal(rows.find((r) => r.id === 'diary').label, 'Study log');
    assert.match(rows.find((r) => r.id === 'diaryAccess').label, /diary/, 'it gates the local MCP server against the local vault');
  });

  test('every rebindable action and fixed shortcut is a row of Keyboard', () => {
    const keys = settingRows(t, {}).filter((r) => r.section === 'keys');
    assert.ok(keys.some((r) => r.id === 'key:trainer.undo'));
    assert.ok(keys.some((r) => r.id.startsWith('fixed:')));
  });

  test('every section has a name', () => {
    for (const { id } of SECTIONS) assert.notEqual(sectionName(id, t), id);
  });
});

describe('searchSettings', () => {
  const rows = settingRows(t, { fsrs: true, desktop: true });

  test('every term must start a word of the row', () => {
    assert.deepEqual(ids(searchSettings(rows, 'new card')), ['maxNew']);
    assert.ok(ids(searchSettings(rows, 'fsrs')).includes('scheduler'));
    assert.deepEqual(searchSettings(rows, 'ost'), [], 'a word’s middle (h-ost) does not match');
  });

  test('extra words find a row by what people call it', () => {
    assert.ok(ids(searchSettings(rows, 'dark')).includes('theme'));
    assert.ok(ids(searchSettings(rows, 'mcp')).includes('mcp'));
    assert.ok(ids(searchSettings(rows, 'undo')).includes('key:trainer.undo'));
  });

  test('an empty query finds nothing, and results group by section in index order', () => {
    assert.deepEqual(searchSettings(rows, '   '), []);
    const groups = hitsBySection(searchSettings(rows, 'restart'));
    assert.deepEqual(groups.map((g) => g.section), ['server']);
    assert.ok(groups[0].ids.has('port'));
  });
});

describe('summaries', () => {
  test('changed shortcuts count only what differs from the default', () => {
    assert.equal(changedShortcuts({}), 0);
    assert.equal(changedShortcuts({ 'trainer.undo': ['Backspace'] }), 0);
    assert.equal(changedShortcuts({ 'trainer.undo': ['U'], 'nav.decks': ['Ctrl+D'] }), 2);
  });

  test('diary access reads the legacy boolean', () => {
    assert.equal(diaryAccessOf(true), 'full');
    assert.equal(diaryAccessOf('summaries'), 'summaries');
    assert.equal(diaryAccessOf(undefined), 'none');
  });
});
