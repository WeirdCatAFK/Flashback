/**
 * Translations — lookup and locale formatting.
 *
 * Both modules under test are pure (no React, no DOM, no SQLite), so this suite
 * runs standalone under `node --test` with no rebuild and no vault, in the same
 * spirit as tests/sequencing.test.js.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { makeTranslators, stripContext, interpolate } from '../src/ui/translations/translate.js';
import { makeFormatters, toDate } from '../src/ui/translations/format.js';
import { extractFromSource, unquote } from '../scripts/translations-extract.js';

const ES = {
  _meta: { code: 'es', name: 'Español' },
  'No subfolders': 'Sin subcarpetas',
  'Delete "{name}"?': '¿Eliminar «{name}»?',
  'Import {n} cards': { one: 'Importar {n} tarjeta', other: 'Importar {n} tarjetas' },
  'Level|noun': 'Nivel',
  'Collapsed {n} items': 'Colapsado: {n}',
};

// ── Fallback to English ───────────────────────────────────────────────────────

test('English has no pack and falls back to the key itself', () => {
  const { t } = makeTranslators(null, 'en');
  assert.equal(t('No subfolders'), 'No subfolders');
  assert.equal(t('Delete "{name}"?', { name: 'Physics' }), 'Delete "Physics"?');
});

test('a key missing from a pack renders readable English, not a blank', () => {
  const { t } = makeTranslators(ES, 'es');
  assert.equal(t('Not translated yet'), 'Not translated yet');
});

test('a partially translated pack mixes translated and English strings', () => {
  const { t } = makeTranslators(ES, 'es');
  assert.equal(t('No subfolders'), 'Sin subcarpetas');
  assert.equal(t('Untouched string'), 'Untouched string');
});

// ── Context suffix ────────────────────────────────────────────────────────────

test('the |context suffix is never shown to the user', () => {
  assert.equal(stripContext('Level|noun'), 'Level');
  assert.equal(stripContext('Level'), 'Level');

  const en = makeTranslators(null, 'en');
  assert.equal(en.t('Level|noun'), 'Level', 'English fallback strips the suffix');

  const es = makeTranslators(ES, 'es');
  assert.equal(es.t('Level|noun'), 'Nivel', 'the pack keys on the full string');
});

// ── Interpolation ─────────────────────────────────────────────────────────────

test('interpolation fills named placeholders in either language', () => {
  assert.equal(interpolate('Hi {who}', { who: 'Dani' }), 'Hi Dani');
  const { t } = makeTranslators(ES, 'es');
  assert.equal(t('Delete "{name}"?', { name: 'Física' }), '¿Eliminar «Física»?');
});

test('an unmatched placeholder stays visible rather than blanking out', () => {
  assert.equal(interpolate('Missing {gone}', { other: 1 }), 'Missing {gone}');
});

test('a zero or false value interpolates rather than being skipped', () => {
  assert.equal(interpolate('{n} left', { n: 0 }), '0 left');
  assert.equal(interpolate('{v} set', { v: false }), 'false set');
});

// ── Plurals ───────────────────────────────────────────────────────────────────

test('English plurals work with no pack loaded at all', () => {
  const { tp } = makeTranslators(null, 'en');
  assert.equal(tp('Import {n} card', 'Import {n} cards', 1), 'Import 1 card');
  assert.equal(tp('Import {n} card', 'Import {n} cards', 5), 'Import 5 cards');
  assert.equal(tp('Import {n} card', 'Import {n} cards', 0), 'Import 0 cards');
});

test('a pack supplies its own plural forms, selected by Intl', () => {
  const { tp } = makeTranslators(ES, 'es');
  assert.equal(tp('Import {n} card', 'Import {n} cards', 1), 'Importar 1 tarjeta');
  assert.equal(tp('Import {n} card', 'Import {n} cards', 5), 'Importar 5 tarjetas');
});

test('Polish gets its few/many forms from the same key', () => {
  const pl = makeTranslators({
    'Import {n} cards': {
      one: '{n} karta', few: '{n} karty', many: '{n} kart', other: '{n} karty',
    },
  }, 'pl');
  const call = (n) => pl.tp('Import {n} card', 'Import {n} cards', n);
  assert.equal(call(1), '1 karta');
  assert.equal(call(3), '3 karty', 'few');
  assert.equal(call(7), '7 kart', 'many');
});

test('a translator may collapse all forms into one string', () => {
  const { tp } = makeTranslators(ES, 'es');
  assert.equal(tp('Collapsed {n} item', 'Collapsed {n} items', 1), 'Colapsado: 1');
  assert.equal(tp('Collapsed {n} item', 'Collapsed {n} items', 9), 'Colapsado: 9');
});

test('a missing plural form falls back to other rather than undefined', () => {
  const { tp } = makeTranslators({ 'Import {n} cards': { other: 'Importar {n}' } }, 'es');
  assert.equal(tp('Import {n} card', 'Import {n} cards', 1), 'Importar 1');
});

test('t() on a plural entry prefers other instead of rendering an object', () => {
  const { t } = makeTranslators(ES, 'es');
  assert.equal(t('Import {n} cards', { n: 3 }), 'Importar 3 tarjetas');
});

// ── toDate ────────────────────────────────────────────────────────────────────

test("SQLite's zoneless timestamps are read as UTC, not local", () => {
  // Parsing "2026-08-08 14:30:00" raw makes it local time and silently shifts
  // every review timestamp by the machine's offset.
  assert.equal(toDate('2026-08-08 14:30:00').toISOString(), '2026-08-08T14:30:00.000Z');
  assert.equal(toDate('2026-08-08T14:30:00Z').toISOString(), '2026-08-08T14:30:00.000Z');
});

test('toDate accepts Date and epoch ms, and rejects junk without throwing', () => {
  const now = new Date();
  assert.equal(toDate(now), now);
  assert.equal(toDate(now.getTime()).getTime(), now.getTime());
  for (const bad of [null, undefined, '', 'not a date', {}, new Date('x')]) {
    assert.equal(toDate(bad), null);
  }
});

// ── Formatters ────────────────────────────────────────────────────────────────

test('relative time is rendered in the active language', () => {
  const day = 86_400_000;
  const en = makeFormatters('en');
  const es = makeFormatters('es');

  assert.equal(en.formatRelative(Date.now() + day), 'tomorrow');
  assert.equal(es.formatRelative(Date.now() + day), 'mañana');
  assert.match(en.formatRelative(Date.now() - 2 * day), /2 days ago/);
});

test('maxUnit keeps SRS intervals precise instead of idiomatic', () => {
  const day = 86_400_000;
  const en = makeFormatters('en');
  // Without the clamp this reads "next month", which is useless when the user is
  // asking exactly how far out a card is scheduled.
  assert.equal(en.formatRelative(Date.now() + 40 * day, { maxUnit: 'day' }), 'in 40 days');
  assert.equal(en.formatRelative(Date.now() + 40 * day), 'next month');
});

test('an unknown maxUnit degrades to the full ladder instead of breaking', () => {
  const en = makeFormatters('en');
  assert.equal(en.formatRelative(Date.now() + 3 * 86_400_000, { maxUnit: 'fortnight' }), 'in 3 days');
});

test('numbers follow locale conventions, including the odd ones', () => {
  const en = makeFormatters('en');
  const es = makeFormatters('es');

  assert.equal(en.formatNumber(1234.5), '1,234.5');
  assert.equal(en.formatNumber(1234567.5), '1,234,567.5');

  // Spanish swaps the separators — and per CLDR omits grouping entirely for
  // four-digit integers, so 1234 is "1234,5" but 12345 is "12.345,5".
  assert.equal(es.formatNumber(1234.5), '1234,5');
  assert.equal(es.formatNumber(1234567.5), '1.234.567,5');

  assert.equal(en.formatNumber(null), '0', 'null-safe');
  assert.equal(en.formatNumber(0), '0');
});

test('formatDay reads a bare ISO day as UTC so the date never slips', () => {
  // Anchored to UTC explicitly — otherwise a user west of Greenwich sees the
  // previous day for every diary entry.
  assert.match(makeFormatters('en').formatDay('2026-08-08'), /August 8, 2026/);
  assert.match(makeFormatters('es').formatDay('2026-08-08'), /8 de agosto de 2026/);
});

test('formatters return empty string for unreadable input', () => {
  const f = makeFormatters('en');
  assert.equal(f.formatDate(null), '');
  assert.equal(f.formatDateTime('garbage'), '');
  assert.equal(f.formatRelative(undefined), '');
  assert.equal(f.formatDay(''), '');
});

// ── Key extraction ────────────────────────────────────────────────────────────

const keysOf = (src) => extractFromSource(src).hits.map((h) => h.key);

test('extracts plain keys from either quote style', () => {
  assert.deepEqual(
    keysOf(`<p>{t('No subfolders')}</p><p>{t("No decks yet")}</p>`),
    ['No subfolders', 'No decks yet'],
  );
});

test('extracts the plural form as the key, keeping the singular alongside', () => {
  const { hits } = extractFromSource(`{tp('Import {n} card', 'Import {n} cards', total)}`);
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0], {
    key: 'Import {n} cards', one: 'Import {n} card', kind: 'plural', line: 1,
  });
});

test('unquote resolves escapes so the key matches the runtime string', () => {
  assert.equal(unquote(String.raw`'It\'s ready'`), "It's ready");
  assert.equal(unquote(String.raw`"Line\nbreak"`), 'Line\nbreak');
  assert.equal(unquote(String.raw`'Back\\slash'`), 'Back\\slash');
  assert.equal(unquote(String.raw`'caf\u00e9'`), 'café');
});

test('an apostrophe key survives the round trip', () => {
  assert.deepEqual(keysOf(String.raw`t('It\'s empty')`), ["It's empty"]);
});

test('reports the line each key appears on', () => {
  const { hits } = extractFromSource(`const a = 1;\n\nt('First');\nt('Second');`);
  assert.deepEqual(hits.map((h) => [h.key, h.line]), [['First', 3], ['Second', 4]]);
});

test('hits come back in source order, not grouped by call type', () => {
  // tp is matched in its own pass; without an explicit sort the plural key would
  // jump ahead of the plain one and the editor would list them out of order.
  const src = `t('alpha');\ntp('one {n}', 'many {n}', n);\nt('omega');`;
  assert.deepEqual(keysOf(src), ['alpha', 'many {n}', 'omega']);
});

// ── Extraction: what must NOT be picked up ────────────────────────────────────

test('whole-line comments do not inject phantom keys', () => {
  assert.deepEqual(keysOf(`// t('commented out')\n * t('in a block')\nt('real')`), ['real']);
});

test('a flashback:// URL inside a string is not mistaken for a comment', () => {
  // The reason inline comments are left alone: this codebase is full of these.
  assert.deepEqual(keysOf(`t('See [note](flashback://abc123)')`), ['See [note](flashback://abc123)']);
});

test('method calls and identifiers ending in t are ignored', () => {
  assert.deepEqual(keysOf(`obj.t('nope'); format('nope'); const dt = at('nope');`), []);
});

test('the real UI tree yields no false positives before migration', () => {
  // Guards the scanner against firing on ordinary code — if this ever trips, the
  // patterns have grown too greedy.
  assert.equal(extractFromSource(`allThemes.map((t) => t.name)`).violations.length, 0);
  assert.equal(extractFromSource(`catch (t) { report(t); }`).violations.length, 0);
});

// ── Extraction: violations ────────────────────────────────────────────────────

test('a non-literal key is a violation, not a silent skip', () => {
  const { hits, violations } = extractFromSource(`t(item.label)`, 'App.jsx');
  assert.equal(hits.length, 0);
  assert.equal(violations.length, 1);
  assert.match(violations[0].reason, /non-literal key/);
  assert.equal(violations[0].file, 'App.jsx');
  assert.equal(violations[0].line, 1);
});

test('tp with a literal first argument but a variable second is still caught', () => {
  // The failure mode that looks fine at a glance — it opens with a valid quote.
  const { hits, violations } = extractFromSource(`tp('one card', plural, n)`);
  assert.equal(hits.length, 0);
  assert.equal(violations.length, 1);
  assert.match(violations[0].reason, /every message argument/);
});

test('a bare t() is not reported', () => {
  assert.equal(extractFromSource(`const { t } = useT(); t()`).violations.length, 0);
});

test('a commented-out violation is not reported', () => {
  assert.equal(extractFromSource(`// t(dynamicKey)`).violations.length, 0);
});
