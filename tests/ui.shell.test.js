/**
 * The shell's pure keyboard logic: key names with modifiers, their display parts,
 * and the Navigation group's defaults. No DOM, no React.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { eventKeyName, keyParts, formatKeyLabel, actionForKey, keybindingActions, MODIFIER_KEYS } from '../src/ui/keybindings.js';

const key = (k, mods = {}) => ({ key: k, code: k === ' ' ? 'Space' : `Key${k}`, ctrlKey: false, metaKey: false, altKey: false, ...mods });

describe('eventKeyName', () => {
  test('plain keys keep their old names', () => {
    assert.equal(eventKeyName(key('1')), '1');
    assert.equal(eventKeyName(key('s')), 'S');
    assert.equal(eventKeyName(key(' ')), 'Space');
    assert.equal(eventKeyName(key('Enter')), 'Enter');
  });
  test('Ctrl, Cmd and Alt prefix the name, so a plain binding never fires on them', () => {
    assert.equal(eventKeyName(key('1', { ctrlKey: true })), 'Ctrl+1');
    assert.equal(eventKeyName(key('1', { metaKey: true })), 'Ctrl+1');
    assert.equal(eventKeyName(key(',', { ctrlKey: true })), 'Ctrl+,');
    assert.equal(eventKeyName(key('3', { altKey: true })), 'Alt+3');
    assert.notEqual(eventKeyName(key('1', { ctrlKey: true })), '1');
  });
  test('modifiers alone are named so recording can skip them', () => {
    assert.ok(MODIFIER_KEYS.includes('Control'));
    assert.ok(MODIFIER_KEYS.includes('Shift'));
  });
});

describe('keyParts and formatKeyLabel', () => {
  test('a combination splits into keycaps', () => {
    assert.deepEqual(keyParts('Ctrl+1'), ['Ctrl', '1']);
    assert.deepEqual(keyParts('Ctrl+ArrowUp'), ['Ctrl', '↑']);
    assert.deepEqual(keyParts('Ctrl+,'), ['Ctrl', ',']);
  });
  test('a lone plus is a key, not a separator', () => {
    assert.deepEqual(keyParts('+'), ['+']);
    assert.deepEqual(keyParts('Ctrl++'), ['Ctrl', '+']);
  });
  test('single keys still get their short labels', () => {
    assert.equal(formatKeyLabel('Backspace'), '⌫');
    assert.equal(formatKeyLabel('Ctrl+Enter'), 'Ctrl+⏎');
  });
});

describe('Navigation shortcuts', () => {
  const nav = keybindingActions((s) => s).find((g) => g.group === 'Navigation').actions;
  const map = Object.fromEntries(nav.map((a) => [a.id, a.default]));
  test('Ctrl+1 to Ctrl+9 follow the tab bar, one screen each', () => {
    const order = ['documents', 'flashcards', 'decks', 'trainer', 'stats', 'diary', 'graph', 'seal', 'manage'];
    order.forEach((id, k) => assert.deepEqual(map[`nav.${id}`], [`Ctrl+${k + 1}`], id));
  });
  test('no two screens share a default key', () => {
    const keys = nav.flatMap((a) => a.default);
    assert.equal(new Set(keys).size, keys.length);
  });
  test('actionForKey finds the screen for a key and nothing for a stranger', () => {
    const ids = nav.map((a) => a.id);
    assert.equal(actionForKey(map, ids, 'Ctrl+4'), 'nav.trainer');
    assert.equal(actionForKey(map, ids, 'Ctrl+,'), 'nav.config');
    assert.equal(actionForKey(map, ids, '4'), null);
  });
});
