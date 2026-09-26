/**
 * The Documents screen's pure logic: the file tree's widths and slide-out zone,
 * what a tree row says about a document or folder, and what the finder lists.
 * No DOM, no React.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  snapWidth, stepWidth, storedWidth, peekZoneWidth, MIN_WIDTH, MAX_WIDTH, DEFAULT_WIDTH, PEEK_MIN, PEEK_CLEAR,
} from '../src/ui/views/documents/treeLayout.js';
import { docStem, docKind, readFacts } from '../src/ui/components/document/explorer/rowFacts.js';
import { cardFront, cardsByHighlight, cardMatches, highlightMatches, orderedCards, hlColor, readingOrder } from '../src/ui/components/document/finderRows.js';
import { marginStart } from '../src/ui/components/document/renderers/epub/epubTheme.js';
import { marginItems, stackTops, marginFits, marginFront, marginLeft, COLUMN_GAP, EDGE, LIFT, GAP } from '../src/ui/components/document/margin/marginLayout.js';

const t = (s, vars = {}) => s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`));

describe('tree width', () => {
  test('a drag near a snap lands on it; elsewhere it stays, clamped', () => {
    assert.equal(snapWidth(252), 260);
    assert.equal(snapWidth(300), 300);
    assert.equal(snapWidth(90), MIN_WIDTH);
    assert.equal(snapWidth(900), MAX_WIDTH);
  });

  test('the arrow keys step between snaps, then to the ends', () => {
    assert.equal(stepWidth(236, 1), 260);
    assert.equal(stepWidth(260, 1), 340);
    assert.equal(stepWidth(340, 1), MAX_WIDTH);
    assert.equal(stepWidth(236, -1), 200);
    assert.equal(stepWidth(200, -1), MIN_WIDTH);
  });

  test('a stored width out of range, or garbage, reads as the default', () => {
    assert.equal(storedWidth('300'), 300);
    assert.equal(storedWidth('20'), DEFAULT_WIDTH);
    assert.equal(storedWidth(null), DEFAULT_WIDTH);
  });

  test('the slide-out zone is the space left of the text, less the clear strip, never narrower than the minimum', () => {
    assert.equal(peekZoneWidth(100, 400), 400 - 100 - PEEK_CLEAR);
    assert.equal(peekZoneWidth(100, 120), PEEK_MIN);
    assert.equal(peekZoneWidth(100, null), PEEK_MIN);
  });
});

describe('tree rows', () => {
  test('a name shows without its extension; the kind is the extension', () => {
    assert.equal(docStem('Memory (1885).epub'), 'Memory (1885)');
    assert.equal(docStem('README'), 'README');
    assert.equal(docStem('.hidden'), '.hidden');
    assert.equal(docKind('Scan.PDF'), 'pdf');
    assert.equal(docKind('README'), '');
  });

  test('a document never opened has no line; one started has a stub; finished is full', () => {
    assert.equal(readFacts({ progress: null }, t).value, null);
    assert.ok(readFacts({ progress: { furthestPercent: null } }, t).value > 0);
    assert.deepEqual(readFacts({ progress: { furthestPercent: 0.42 } }, t), { value: 0.42, finished: false, label: '42% read' });
    assert.deepEqual(readFacts({ progress: { finished: true } }, t), { value: 1, finished: true, label: 'Finished' });
  });

  test('a folder draws its rollup only once something in it has been opened', () => {
    assert.equal(readFacts({ rollup: { total: 4, finished: 0, inProgress: 0 } }, t).value, null);
    const f = readFacts({ rollup: { total: 4, finished: 1, inProgress: 1, percent: 0.4 } }, t);
    assert.equal(f.value, 0.4);
    assert.equal(f.label, '1 of 4 read');
    assert.equal(readFacts({ rollup: { total: 2, finished: 2, inProgress: 0, percent: 1, subscription: true } }, t).label, '2 of 2 issues read');
  });
});

describe('finder rows', () => {
  const card = (hash, front, hl, extra = {}) => ({ globalHash: hash, cardType: 'basic', vanillaData: { frontText: front, backText: '', ...(hl ? { location: { type: 'highlight', id: hl } } : {}) }, ...extra });
  const highlights = [{ id: 'h1', color: 'green', text: 'first passage' }, { id: 'h2', color: 'pink', text: 'second passage' }];
  const flashcards = [card('a', 'On h2', 'h2'), card('b', 'Loose card', null), card('c', 'On {{h1}}', 'h1'), card('d', 'Orphan', 'gone')];

  test('cards come in highlight order; loose and orphaned cards last, in their own order', () => {
    assert.deepEqual(orderedCards(flashcards, highlights).map(({ card: c }) => c.globalHash), ['c', 'a', 'b', 'd']);
    assert.equal(orderedCards(flashcards, highlights).find(({ card: c }) => c.globalHash === 'd').highlight, null);
  });

  test('cards group under their highlight; a front reads its cloze as a gap', () => {
    const map = cardsByHighlight(flashcards);
    assert.deepEqual(map.get('h2').map((c) => c.globalHash), ['a']);
    assert.equal(map.has('gone'), true);
    assert.equal(cardFront(flashcards[2], t), 'On ___');
    assert.equal(cardFront({ cardType: 'custom', name: '' }, t), 'Custom HTML card');
  });

  test('a highlight matches through its passage or any of its cards', () => {
    const map = cardsByHighlight(flashcards);
    assert.equal(highlightMatches(highlights[0], map.get('h1'), 'FIRST'), true);
    assert.equal(highlightMatches(highlights[1], map.get('h2'), 'on h2'), true);
    assert.equal(highlightMatches(highlights[1], map.get('h2'), 'nothing'), false);
    assert.equal(cardMatches(flashcards[1], '  '), true);
  });

  test('a stored colour name becomes its token; an unknown one is amber', () => {
    assert.equal(hlColor('blue'), 'var(--color-hl-3)');
    assert.equal(hlColor('mauve'), 'var(--color-hl-1)');
  });
});

describe('margin', () => {
  test('each item sits level with its passage, pushed down only as far as the one above needs', () => {
    const { tops, bottom } = stackTops([
      { id: 'b', anchor: 120, height: 40 },
      { id: 'a', anchor: 100, height: 60 },
      { id: 'c', anchor: 400, height: 30 },
      { id: 'gone', anchor: null, height: 30 },
    ]);
    assert.equal(tops.get('a'), 100 - LIFT);
    assert.equal(tops.get('b'), 100 - LIFT + 60 + GAP, 'b would overlap a, so it waits below it');
    assert.equal(tops.get('c'), 400 - LIFT);
    assert.equal(tops.has('gone'), false, 'a passage not on the page gets no item');
    assert.equal(bottom, 400 - LIFT + 30);
  });

  test('every highlight gets an item with its cards; the column needs room', () => {
    const items = marginItems(
      [{ id: 'h1', color: 'blue' }, { id: 'h2', color: 'pink' }],
      [{ globalHash: 'x', vanillaData: { location: { type: 'highlight', id: 'h2' } } }, { globalHash: 'y', vanillaData: { location: { type: 'highlight', id: 'h2' } } }],
    );
    assert.deepEqual(items.map((i) => [i.id, i.cards.length]), [['h1', 0], ['h2', 2]]);
    assert.equal(marginFits(1000), true);
    assert.equal(marginFits(600), false);
  });

  test('the margin column starts just past the text, and never runs off the area', () => {
    assert.equal(marginLeft(900, 1600, 220), 900 + COLUMN_GAP);
    assert.equal(marginLeft(700, 800, 220), 800 - 220 - EDGE);
    assert.equal(marginLeft(10, 100, 220), 0);
  });

  test('a cloze front splits into text and blanks; a custom card shows its name', () => {
    const f = marginFront({ cardType: 'cloze', vanillaData: { frontText: 'The {{first}} box.' } });
    assert.deepEqual(f.parts, [{ text: 'The ' }, { blank: 'first' }, { text: ' box.' }]);
    assert.deepEqual(marginFront({ cardType: 'custom', name: 'Planets' }), { kind: 'custom', text: 'Planets' });
  });

  test('an EPUB column leans with the tree, and moves over for the margin only when centred', () => {
    assert.equal(marginStart('48px', true), '48px');
    assert.equal(marginStart('48px', false), '48px');
    assert.equal(marginStart('auto', false), 'auto');
    assert.equal(marginStart('', false), 'auto');
    assert.equal(marginStart('auto', true, '960px'), 'max(0px, (100% - 960px - 252px) / 2)');
    assert.match(marginStart('auto', true), /^max\(0px, \(100% - [\d.]+rem - \d+px\) \/ 2\)$/);
  });
});

describe('finder reading order', () => {
  test('PDF highlights sort by page, then height on the page', () => {
    const hls = [{ id: 'a', page: 2, bbox: { y: 10 } }, { id: 'b', page: 1, bbox: { y: 300 } }, { id: 'c', page: 1, bbox: { y: 40 } }];
    assert.deepEqual(readingOrder(hls).map((h) => h.id), ['c', 'b', 'a']);
  });

  test('text and clip highlights sort by offset; EPUB by CFI steps, numerically', () => {
    assert.deepEqual(readingOrder([{ id: 'a', start: 90 }, { id: 'b', start: 5 }]).map((h) => h.id), ['b', 'a']);
    const epub = [{ id: 'x', cfi: 'epubcfi(/6/10!/4/2,/1:0,/1:9)' }, { id: 'y', cfi: 'epubcfi(/6/8!/4/20,/1:0,/1:9)' }, { id: 'z', cfi: 'epubcfi(/6/8!/4/4,/1:0,/1:9)' }];
    assert.deepEqual(readingOrder(epub).map((h) => h.id), ['z', 'y', 'x']);
  });

  test('inline marks follow the page; one the page cannot place keeps its place after the rest', () => {
    const hls = [{ id: 'm1' }, { id: 'gone' }, { id: 'm2' }];
    assert.deepEqual(readingOrder(hls, ['m2', 'm1']).map((h) => h.id), ['m2', 'm1', 'gone']);
  });
});

import { groupCues, placeHighlights, segments, paraIndexAt, timeAtOffset, isBlankNote, rangeOverlapping } from '../src/ui/components/document/renderers/youtube/transcript.js';
import { nearestCorner, cornerPosition, storedCorner } from '../src/ui/components/document/renderers/youtube/floatCorner.js';

describe('youtube transcript', () => {
  const cues = [
    { start: 0, dur: 4, text: 'Here is an experiment.' },
    { start: 4, dur: 4, text: 'Take twenty facts.' },
    { start: 30, dur: 5, text: 'Same total time.' },
    { start: 36, dur: 6, text: 'A week later, test yourself' },
    { start: 44, dur: 4, text: 'on all twenty' },
    { start: 80, dur: 4, text: 'Why does it happen?' },
  ];

  test('captions group into paragraphs after a sentence, and regardless after a long run', () => {
    const paras = groupCues(cues);
    assert.deepEqual(paras.map((p) => p.start), [0, 30, 80]);
    assert.equal(paras[1].text, 'Same total time. A week later, test yourself on all twenty');
    assert.deepEqual(paras[1].cues.map((c) => c.offset), [0, 17, 45]);
    assert.equal(paraIndexAt(paras, 50), 1);
    assert.equal(paraIndexAt(paras, -1), -1);
    assert.equal(timeAtOffset(paras[1], 20), 36);
  });

  test('a highlight lands on its words from its line; a blank moment covers its line; unknown words stay a note', () => {
    const paras = groupCues(cues);
    const { ranges, loose } = placeHighlights(paras, [
      { id: 'a', start: 36, text: 'test yourself', color: 'blue' },
      { id: 'b', start: 4, text: '@ 0:04' },
      { id: 'c', start: 31, text: 'Something I wrote while watching' },
    ]);
    assert.deepEqual(ranges.get(1), [{ id: 'a', color: 'blue', from: 31, to: 44 }]);
    assert.deepEqual(ranges.get(0), [{ id: 'b', color: 'amber', from: 23, to: 41 }]);
    assert.deepEqual(loose.map((h) => h.id), ['c']);
    assert.equal(rangeOverlapping(ranges.get(1), 35, 40).id, 'a');
    assert.equal(rangeOverlapping(ranges.get(1), 0, 5), null);
    assert.ok(isBlankNote('@ 1:12') && isBlankNote('') && !isBlankNote('A note'));
  });

  test('a paragraph cuts into plain and marked runs; an overlapping mark yields', () => {
    const runs = segments('abcdefghij', [{ id: 'x', color: 'amber', from: 2, to: 5 }, { id: 'y', color: 'pink', from: 4, to: 7 }]);
    assert.deepEqual(runs, [{ text: 'ab' }, { text: 'cde', id: 'x', color: 'amber' }, { text: 'fghij' }]);
  });
});

describe('youtube small player', () => {
  const area = { left: 100, top: 50, width: 800, height: 600 };
  test('a drop settles in the nearest corner', () => {
    assert.equal(nearestCorner(150, 80, area), 'tl');
    assert.equal(nearestCorner(850, 600, area), 'br');
    assert.equal(storedCorner('tr'), 'tr');
    assert.equal(storedCorner('middle'), 'bl');
  });
  test('corners sit in from the edges, and the top ones below the bar', () => {
    assert.deepEqual(cornerPosition('bl', area, 340, 190), { left: 116, top: 444 });
    assert.deepEqual(cornerPosition('tr', area, 340, 190), { left: 544, top: 106 });
  });
});
