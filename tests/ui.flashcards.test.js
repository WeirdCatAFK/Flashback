/**
 * The Flashcards catalogue's and the Decks screen's pure logic: the source tree,
 * the request a view makes, when a card comes due, where group headers fall in a
 * page, and a deck's colour and caption. No DOM, no React.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSourceTree, ancestorsOf, searchArgsFor, EMPTY_VIEW, isNarrowed, scopeParts,
  dueLabel, withGroupHeaders, groupLabel, frontLine, docTitle, share,
} from '../src/ui/views/flashcards/catalogue.js';
import { sortDecks, deckStatus, longTermShare, newDeckName } from '../src/ui/views/decks/deckShelf.js';
import { DECK_COLORS, deckColor, nextDeckColor } from '../src/shared/deckColors.js';
import { coverTravel, dragCoverY } from '../src/ui/components/cover/coverMath.js';
import { COVER_GROUPS, coverPatternLabel } from '../src/ui/components/cover/coverPatterns.js';
import { COVER_PATTERNS } from '../src/shared/covers.js';

const t = (s, vars = {}) => s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`));
const DAY = 86_400_000;

describe('buildSourceTree', () => {
  const tree = buildSourceTree([
    { path: 'Learning/Leitner/So lernt man.pdf', cards: 3, longTerm: 1 },
    { path: 'Learning/Ebbinghaus.epub', cards: 2, longTerm: 2 },
    { path: 'Learning\\Leitner\\Spacing.md', cards: 1, longTerm: 0 },
    { path: 'Top.md', cards: 4, longTerm: 0 },
  ]);

  test('folders first, then documents, each alphabetical', () => {
    assert.deepEqual(tree.map((n) => [n.kind, n.name]), [['folder', 'Learning'], ['document', 'Top']]);
    const learning = tree[0];
    assert.deepEqual(learning.children.map((n) => n.name), ['Leitner', 'Ebbinghaus']);
  });

  test('a folder sums everything under it, and backslash paths join the same folder', () => {
    const learning = tree[0];
    assert.equal(learning.cards, 6);
    assert.equal(learning.longTerm, 3);
    const leitner = learning.children[0];
    assert.equal(leitner.path, 'Learning/Leitner');
    assert.deepEqual(leitner.children.map((d) => d.path), ['Learning/Leitner/So lernt man.pdf', 'Learning/Leitner/Spacing.md']);
  });

  test('ancestorsOf lists the folders to open for a path', () => {
    assert.deepEqual(ancestorsOf('a/b/c.md'), ['a', 'a/b']);
    assert.deepEqual(ancestorsOf('c.md'), []);
  });
});

describe('searchArgsFor', () => {
  test('the default view asks for the gap grouping in due order', () => {
    const a = searchArgsFor(EMPTY_VIEW, 'fsrs');
    assert.equal(a.groupBy, 'gap');
    assert.equal(a.sortBy, 'due');
    assert.equal(a.sortDir, 'asc');
    assert.equal(a.algorithm, 'fsrs');
    assert.equal(a.flagged, false);
  });

  test('health "any" is the flagged filter, a kind is flagKind; grouping "none" sends none', () => {
    assert.equal(searchArgsFor({ ...EMPTY_VIEW, health: 'any' }).flagKind, null);
    assert.equal(searchArgsFor({ ...EMPTY_VIEW, health: 'any' }).flagged, true);
    assert.equal(searchArgsFor({ ...EMPTY_VIEW, health: 'probe' }).flagKind, 'probe');
    assert.equal(searchArgsFor({ ...EMPTY_VIEW, group: 'none' }).groupBy, null);
    assert.equal(searchArgsFor({ ...EMPTY_VIEW, sort: 'created' }).sortDir, 'desc');
  });

  test('a source becomes source + sourcePath', () => {
    const a = searchArgsFor({ ...EMPTY_VIEW, source: { kind: 'folder', path: 'Learning' } });
    assert.equal(a.source, 'folder');
    assert.equal(a.sourcePath, 'Learning');
  });

  test('order and grouping do not count as narrowing', () => {
    assert.equal(isNarrowed({ ...EMPTY_VIEW, sort: 'front', group: 'none' }), false);
    assert.equal(isNarrowed({ ...EMPTY_VIEW, band: 'wk' }), true);
  });

  test('the scope line names what narrows the list', () => {
    const parts = scopeParts({ ...EMPTY_VIEW, source: { kind: 'document', path: 'a/Memory.epub' }, band: 'wk' }, t, (k) => k);
    assert.deepEqual(parts, ['Memory', 'up to a week']);
  });

  test('a tag or category from Metadata narrows, searches by id, and is named in the scope line', () => {
    const v = { ...EMPTY_VIEW, tag: 'memory', category: { id: 7, name: 'Definition' } };
    assert.equal(isNarrowed(v), true);
    assert.equal(searchArgsFor(v).tag, 'memory');
    assert.equal(searchArgsFor(v).category, 7);
    assert.deepEqual(scopeParts(v, t, (k) => k), ['#memory', 'Definition']);
    assert.equal(searchArgsFor(EMPTY_VIEW).category, null);
  });
});

describe('dueLabel', () => {
  const now = Date.parse('2026-09-23T12:00:00Z');
  const at = (daysAgo, gap) => ({ gap, last_recall: new Date(now - daysAgo * DAY).toISOString() });

  test('never reviewed is new', () => {
    assert.equal(dueLabel({ gap: null, last_recall: null }, now, t), 'new');
  });
  test('past due and due today are due now; one day out is tomorrow', () => {
    assert.equal(dueLabel(at(10, 4), now, t), 'due now');
    assert.equal(dueLabel(at(1, 1), now, t), 'due now');
    assert.equal(dueLabel(at(0, 1), now, t), 'due tomorrow');
  });
  test('further out counts whole days', () => {
    assert.equal(dueLabel(at(2, 10), now, t), 'due in 8 d');
  });
});

describe('withGroupHeaders', () => {
  const cards = [
    { global_hash: 'a', gap: null },
    { global_hash: 'b', gap: 3 },
    { global_hash: 'c', gap: 5 },
  ];
  const groups = [{ key: 'new', count: 4 }, { key: 'wk', count: 2 }];

  test('a header before each group, carrying the count across every page', () => {
    const rows = withGroupHeaders(cards, 'gap', groups);
    assert.deepEqual(rows.map((r) => (r.header ? `#${r.key}:${r.count}` : r.card.global_hash)), ['#new:4', 'a', '#wk:2', 'b', 'c']);
  });

  test('a page that opens mid-group still starts with its header', () => {
    const rows = withGroupHeaders(cards.slice(1), 'gap', groups);
    assert.equal(rows[0].header, true);
    assert.equal(rows[0].key, 'wk');
  });

  test('by source, standalone cards group under the default deck', () => {
    const rows = withGroupHeaders([{ document_path: 'a\\b.md' }, { document_path: null }], 'source', [{ key: 'a/b.md', count: 1 }, { key: null, count: 1 }]);
    assert.deepEqual(rows.filter((r) => r.header).map((r) => groupLabel('source', r.key, t)), ['b', 'Cards (default deck)']);
  });

  test('no grouping, no headers', () => {
    assert.equal(withGroupHeaders(cards, 'none', null).some((r) => r.header), false);
  });
});

describe('row text', () => {
  test('cloze blanks read as a gap; custom cards by name', () => {
    assert.equal(frontLine({ card_type: 'cloze', frontText: 'The {{mitochondria}} is  here' }), 'The ___ is here');
    assert.equal(frontLine({ card_type: 'custom', name: 'Planets', frontText: '' }), 'Planets');
  });
  test('docTitle drops folders and the extension', () => {
    assert.equal(docTitle('Biology\\Cell\\Molecular Biology.pdf'), 'Molecular Biology');
  });
  test('share is clamped and safe on an empty whole', () => {
    assert.equal(share(3, 0), 0);
    assert.equal(share(5, 4), 1);
  });
});

describe('decks', () => {
  const tp = (one, other, n) => (n === 1 ? one : other).replace('{n}', n);

  test('the default deck is kraft; a stored colour wins; an old deck takes its hash\'s, the same every time', () => {
    assert.equal(deckColor({ is_system: 1, color: 'sage' }), 'kraft');
    assert.equal(deckColor({ color: 'plum', global_hash: 'x' }), 'plum');
    const a = deckColor({ color: null, global_hash: 'abc-123' });
    assert.ok(DECK_COLORS.includes(a));
    assert.equal(deckColor({ color: 'not-a-colour', global_hash: 'abc-123' }), a);
  });

  test('a new deck takes the first colour nobody shows, then cycles', () => {
    assert.equal(nextDeckColor([]), 'slate');
    assert.equal(nextDeckColor(['slate', 'sage']), 'ochre');
    assert.equal(nextDeckColor([...DECK_COLORS]), DECK_COLORS[0]);
  });

  test('the caption says what is due, else what is new, else nothing', () => {
    assert.deepEqual(deckStatus({ due: 3, fresh: 5 }, t, tp), { text: '3 due', strong: true });
    assert.deepEqual(deckStatus({ due: 0, fresh: 5 }, t, tp), { text: '5 new', strong: false });
    assert.equal(deckStatus({ due: 0, fresh: 0 }, t, tp).text, 'nothing due');
  });

  test('new deck names skip the ones taken', () => {
    assert.equal(newDeckName([], t), 'New deck');
    assert.equal(newDeckName([{ name: 'New deck' }, { name: 'New deck 2' }], t), 'New deck 3');
  });

  test('the default deck sorts first', () => {
    assert.deepEqual(sortDecks([{ name: 'a' }, { name: 'b', is_system: 1 }]).map((d) => d.name), ['b', 'a']);
    assert.equal(longTermShare({ longTerm: 3 }, 0), 0);
  });
});

describe('deck cover reposition', () => {
  test('an image can slide by its height at the banner width, less the banner', () => {
    assert.equal(coverTravel(1000, 1000, 800, 160), 640);
    assert.equal(coverTravel(2000, 400, 800, 160), 0, 'a wide image fills the banner with nothing to spare');
    assert.equal(coverTravel(0, 0, 800, 160), 0);
  });

  test('dragging down shows more of the top, clamped to the ends', () => {
    assert.equal(dragCoverY(0.5, 64, 640), 0.4);
    assert.equal(dragCoverY(0.5, -64, 640), 0.6);
    assert.equal(dragCoverY(0.1, 640, 640), 0);
    assert.equal(dragCoverY(0.9, -640, 640), 1);
    assert.equal(dragCoverY(0.3, 50, 0), 0.3, 'nothing to travel, nothing moves');
  });
});

describe('drawn covers', () => {
  test('the menu offers every cover the API accepts, once, and each has a name', () => {
    const offered = COVER_GROUPS.flatMap((g) => g.patterns);
    assert.deepEqual([...offered].sort(), [...COVER_PATTERNS].sort());
    for (const id of COVER_PATTERNS) assert.notEqual(coverPatternLabel(id, t), id, `${id} has a name`);
  });
});
