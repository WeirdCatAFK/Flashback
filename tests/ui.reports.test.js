/**
 * The report screens' pure logic: Statistics (the heatmap's weeks, the gap-band rows),
 * the Diary's month calendar, Metadata's priority levels and tag list, and the tag-name
 * rule a vault-wide rename applies. No DOM, no React.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { HEAT_WEEKS, dayKey, heatDays, bandRows, forecastTotal, heatLevel } from '../src/ui/views/stats/report.js';
import { keyOf, ymOf, monthCells, monthRange, stepMonth, writtenIn } from '../src/ui/views/diary/calendar.js';
import {
  levelsOf, tiersOf, placeCategory, shiftTarget, newCategoryPriority, withPriorities,
  reachOf, shownTags, uncategorized,
} from '../src/ui/views/manage/metadata.js';
import { cleanTagName, swapTag } from '../src/shared/tagNames.js';

describe('heatLevel', () => {
  test('none is 0, then quarters of the busiest day', () => {
    assert.equal(heatLevel(0, 10), 0);
    assert.equal(heatLevel(5, 0), 0);
    assert.equal(heatLevel(2, 10), 1);
    assert.equal(heatLevel(5, 10), 2);
    assert.equal(heatLevel(7, 10), 3);
    assert.equal(heatLevel(10, 10), 4);
  });
});

describe('heatDays', () => {
  const today = new Date(2026, 8, 24);

  test('whole weeks, Monday first, ending with the week that holds today', () => {
    const days = heatDays([], today);
    assert.equal(days.length, HEAT_WEEKS * 7);
    assert.equal(days[0].date.getDay(), 1, 'the first column starts on a Monday');
    const at = days.findIndex((d) => d.day === dayKey(today));
    assert.ok(at >= days.length - 7, 'today sits in the last column');
  });

  test('days after today are future and empty; levels scale to the busiest day', () => {
    const days = heatDays([{ day: '2026-09-24', total: 8 }, { day: '2026-09-23', total: 2 }, { day: '2026-09-25', total: 50 }], today);
    const byDay = new Map(days.map((d) => [d.day, d]));
    assert.equal(byDay.get('2026-09-24').level, 4);
    assert.equal(byDay.get('2026-09-23').level, 1);
    assert.equal(byDay.get('2026-09-25').future, true);
    assert.equal(byDay.get('2026-09-25').total, 0, 'a future count is not drawn');
  });
});

describe('bandRows and forecastTotal', () => {
  test('every band in order, with its share of all cards and of the fullest band', () => {
    const rows = bandRows({ new: 2, wk: 6 });
    assert.equal(rows[0].id, 'new');
    const wk = rows.find((r) => r.id === 'wk');
    assert.equal(wk.bar, 1);
    assert.equal(wk.share, 0.75);
    assert.equal(rows.find((r) => r.id === 'long').n, 0);
  });

  test('an empty vault has no shares rather than NaN', () => {
    assert.ok(bandRows({}).every((r) => r.share === 0 && r.bar === 0));
  });

  test('the forecast total adds every day', () => {
    assert.equal(forecastTotal([{ due: 3 }, { due: 4 }, {}]), 7);
    assert.equal(forecastTotal(null), 0);
  });
});

describe('Diary calendar', () => {
  test('keys and months round-trip, months zero-based', () => {
    assert.equal(keyOf(2026, 0, 5), '2026-01-05');
    assert.deepEqual(ymOf('2026-09-24'), { y: 2026, m: 8 });
  });

  test('a month lays out Monday first, with levels, entries and out-of-range days', () => {
    const days = [{ date: '2026-09-02', reviews: 10, hasEntry: true }, { date: '2026-09-03', reviews: 3 }];
    const { lead, cells } = monthCells(2026, 8, days, { first: '2026-09-02', today: '2026-09-24' });
    assert.equal(lead, 1, 'September 2026 starts on a Tuesday');
    assert.equal(cells.length, 30);
    assert.equal(cells[1].level, 4);
    assert.equal(cells[1].wrote, true);
    assert.equal(cells[2].level, 2);
    assert.equal(cells[0].off, true, 'before the first recorded day');
    assert.equal(cells[24].off, true, 'after today');
    assert.equal(cells[23].off, false);
  });

  test('the range runs from the earliest day to today, and stepping stays inside it', () => {
    const r = monthRange([{ date: '2026-07-10' }, { date: '2026-09-01' }], '2026-09-24');
    assert.deepEqual(r.from, { y: 2026, m: 6 });
    assert.deepEqual(r.to, { y: 2026, m: 8 });
    assert.deepEqual(stepMonth({ y: 2026, m: 8 }, 1, r.from, r.to), { y: 2026, m: 8 });
    assert.deepEqual(stepMonth({ y: 2026, m: 6 }, -1, r.from, r.to), { y: 2026, m: 6 });
    assert.deepEqual(stepMonth({ y: 2026, m: 0 }, -1, { y: 2025, m: 0 }, r.to), { y: 2025, m: 11 });
  });

  test('what was written in a month, newest first', () => {
    const days = [
      { date: '2026-09-02', hasEntry: true, firstLine: 'Early' },
      { date: '2026-09-20', hasEntry: true, firstLine: 'Late' },
      { date: '2026-09-21', hasEntry: false },
      { date: '2026-08-30', hasEntry: true },
    ];
    assert.deepEqual(writtenIn(days, 2026, 8).map((d) => d.firstLine), ['Late', 'Early']);
  });
});

describe('Metadata: priority levels', () => {
  const cats = [
    { id: 1, name: 'Definition', priority: 0 },
    { id: 2, name: 'Symbol', priority: 0 },
    { id: 3, name: 'Concept', priority: 1 },
    { id: 4, name: 'Exercise', priority: 2 },
  ];

  test('levels are the distinct priorities in order, each alphabetical', () => {
    assert.deepEqual(levelsOf(cats), [0, 1, 2]);
    assert.deepEqual(tiersOf(cats)[0].members.map((c) => c.name), ['Definition', 'Symbol']);
  });

  test('moving onto a level writes only that category', () => {
    assert.deepEqual(placeCategory(cats, 4, { level: 1 }), [{ id: 4, priority: 1 }]);
  });

  test('emptying a level closes the gap, keeping a first level of 0', () => {
    assert.deepEqual(placeCategory(cats, 3, { level: 0 }), [{ id: 3, priority: 0 }, { id: 4, priority: 1 }]);
  });

  test('a new level on top pushes the others down; at the bottom it goes after them', () => {
    assert.deepEqual(placeCategory(cats, 2, 'top'), [
      { id: 1, priority: 1 }, { id: 3, priority: 2 }, { id: 4, priority: 3 },
    ]);
    assert.deepEqual(placeCategory(cats, 1, 'bottom'), [{ id: 1, priority: 3 }]);
  });

  test('a category alone on the top level asking for a new top level stays put', () => {
    const alone = [{ id: 1, name: 'A', priority: 0 }, { id: 2, name: 'B', priority: 1 }];
    assert.deepEqual(placeCategory(alone, 1, 'top'), []);
  });

  test('gapped priorities renumber from the lowest one', () => {
    const gapped = [{ id: 1, name: 'A', priority: 3 }, { id: 2, name: 'B', priority: 7 }, { id: 3, name: 'C', priority: 9 }];
    assert.deepEqual(placeCategory(gapped, 3, { level: 7 }), [{ id: 2, priority: 4 }, { id: 3, priority: 4 }]);
  });

  test('Raise and Lower: the next level, a level of its own at a shared edge, nothing alone at the edge', () => {
    assert.deepEqual(shiftTarget(cats, 3, -1), { level: 0 });
    assert.equal(shiftTarget(cats, 1, -1), 'top');
    assert.equal(shiftTarget(cats, 4, 1), null);
    assert.deepEqual(shiftTarget(cats, 4, -1), { level: 1 });
  });

  test('a new category joins the last level; the optimistic redraw applies the writes', () => {
    assert.equal(newCategoryPriority(cats), 2);
    assert.equal(newCategoryPriority([]), 0);
    assert.equal(withPriorities(cats, [{ id: 4, priority: 1 }]).find((c) => c.id === 4).priority, 1);
  });

  test('the cards with no category', () => {
    assert.equal(uncategorized(10, [{ cards: 3 }, { cards: 4 }]), 3);
    assert.equal(uncategorized(2, [{ cards: 3 }]), 0);
  });
});

describe('Metadata: tags', () => {
  const tags = [
    { name: 'memory', folders: 0, documents: 2, decks: 1, cardsDirect: 0, cards: 9 },
    { name: 'biology', folders: 1, documents: 0, decks: 0, cardsDirect: 2, cards: 9 },
    { name: 'exam', folders: 0, documents: 0, decks: 0, cardsDirect: 0, cards: 0 },
  ];

  test('reach lists where a tag is applied, skipping the empty kinds', () => {
    assert.deepEqual(reachOf(tags[0]), [['document', 2], ['deck', 1]]);
    assert.deepEqual(reachOf(tags[1]), [['folder', 1], ['card', 2]]);
    assert.deepEqual(reachOf(tags[2]), []);
  });

  test('by use orders by cards reached, then by name; A to Z by name', () => {
    assert.deepEqual(shownTags(tags, '', 'use').map((t) => t.name), ['biology', 'memory', 'exam']);
    assert.deepEqual(shownTags(tags, '', 'az').map((t) => t.name), ['biology', 'exam', 'memory']);
  });

  test('the filter ignores case and a leading #', () => {
    assert.deepEqual(shownTags(tags, '#MEM', 'use').map((t) => t.name), ['memory']);
  });
});

describe('tag names', () => {
  test('clean trims and drops leading #', () => {
    assert.equal(cleanTagName('  ##memory '), 'memory');
    assert.equal(cleanTagName(null), '');
  });

  test('swap renames in place, merges a duplicate, removes on null, and reports untouched lists', () => {
    assert.deepEqual(swapTag(['a', 'b', 'c'], 'b', 'x'), ['a', 'x', 'c']);
    assert.deepEqual(swapTag(['a', 'b'], 'b', 'a'), ['a']);
    assert.deepEqual(swapTag(['a', 'b'], 'a'), ['b']);
    assert.equal(swapTag(['a'], 'z', 'y'), null);
    assert.equal(swapTag(undefined, 'a', 'b'), null);
  });
});
