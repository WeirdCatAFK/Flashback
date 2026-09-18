/**
 * Knowledge-graph data and export helpers — the pure modules under src/ui/views/graph.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraphData, applyVisibility, focusedIdsFor, neighborGroupsFor, nodeDisplayName } from '../src/ui/views/graph/graphData.js';
import { escapeHtml, exportJson, datestamp } from '../src/ui/views/graph/export.js';
import { withAlpha, luminance, blendModeFor, restAlphaFor, labelMinScaleFor, lerp } from '../src/ui/views/graph/paint.js';
import { degreeMap, chargeFor } from '../src/ui/views/graph/forces.js';
import { HALO_BASE, HALO_MAX } from '../src/ui/views/graphMetrics.js';

const payload = {
  nodes: [
    { id: 1, type: 'Folder', label: 'root' },
    { id: 2, type: 'Document', label: 'doc', documentPath: 'a/doc.md' },
    { id: 3, type: 'Flashcard', flashcardFront: 'x'.repeat(60), learned: 1, mass: 1, cardCount: 1 },
    { id: 4, type: 'Tag', label: 't' },
    { id: 5, type: 'Deck', label: 'Default', deckIsSystem: true },
  ],
  edges: [
    { fromId: 1, toId: 2, relation: 'inheritance' },
    { fromId: 2, toId: 3, relation: 'reference' },
    { fromId: 4, toId: 2, relation: 'tag' },
    { fromId: 5, toId: 3, relation: 'deck' },
    { fromId: 2, toId: 99, relation: 'link' },
    { fromId: 1, toId: 4, relation: 'connection' },
    { fromId: 1, toId: 4, relation: 'disconnection' },
  ],
};

describe('buildGraphData', () => {
  const g = buildGraphData(payload);

  test('drops links to nodes that are not in the payload', () => {
    assert.ok(!g.links.some((l) => l.target === 99));
  });

  test('a disconnection cancels the edge it severs but is itself kept', () => {
    assert.ok(!g.links.some((l) => l.relation === 'connection'));
    assert.ok(g.links.some((l) => l.relation === 'disconnection'));
  });

  test('origin folders and system decks are identified', () => {
    assert.deepEqual([...g.originIds], [1]);
    assert.deepEqual([...g.defaultDeckIds], [5]);
  });

  test('a flashcard is named by its truncated front', () => {
    const fc = g.nodes.find((n) => n.id === 3);
    assert.equal(fc.name.length, 53);
    assert.ok(fc.name.endsWith('…'));
    assert.equal(nodeDisplayName({ type: 'Document', label: 'L' }), 'L');
  });

  test('a deck aggregates the mass of the cards it holds', () => {
    const deck = g.nodes.find((n) => n.id === 5);
    assert.equal(deck.cardCount, 1);
    assert.equal(deck.mass, 1);
    assert.equal(deck.learned, 1);
  });
});

describe('visibility and selection', () => {
  const g = buildGraphData(payload);
  const all = { showTags: true, showDecks: true, showLinks: true, showOrigin: true, showDefaultDeck: true };

  test('hiding tags removes tag nodes and tag links', () => {
    const v = applyVisibility(g, { ...all, showTags: false });
    assert.ok(!v.nodes.some((n) => n.type === 'Tag'));
    assert.ok(!v.links.some((l) => l.relation === 'tag'));
  });

  test('hiding the system deck removes it and every link that touched it', () => {
    const v = applyVisibility(g, { ...all, showDefaultDeck: false });
    assert.ok(!v.nodes.some((n) => n.id === 5));
    assert.ok(!v.links.some((l) => l.source === 5 || l.target === 5));
  });

  test('focusedIds is the selection plus its neighbours', () => {
    const v = applyVisibility(g, all);
    const ids = focusedIdsFor({ id: 2 }, v);
    assert.deepEqual([...ids].sort(), [1, 2, 3, 4]);
    assert.equal(focusedIdsFor(null, v), null);
  });

  test('neighbour groups are ordered by type and carry direction', () => {
    const v = applyVisibility(g, all);
    const groups = neighborGroupsFor({ id: 2, type: 'Document' }, v);
    assert.deepEqual(groups.map((x) => x.type), ['Folder', 'Flashcard', 'Tag']);
    assert.equal(groups[1].nodes[0].relation, 'reference');
    assert.equal(groups[1].nodes[0].direction, 'out');
    assert.equal(groups[2].nodes[0].direction, 'in');
  });
});

describe('paint helpers', () => {
  test('withAlpha handles hex, short hex and rgb', () => {
    assert.equal(withAlpha('#ff0000', 0.5), 'rgba(255,0,0,0.5)');
    assert.equal(withAlpha('#f00', 0.5), 'rgba(255,0,0,0.5)');
    assert.equal(withAlpha('rgb(1, 2, 3)', 0.2), 'rgba(1,2,3,0.2)');
  });

  test('blend mode follows the ground luminance', () => {
    assert.equal(blendModeFor('#000'), 'lighter');
    assert.equal(blendModeFor('#ffffff'), 'multiply');
    assert.equal(luminance('nonsense'), 0);
  });

  test('density-driven knobs', () => {
    assert.equal(restAlphaFor(1), 0.30);
    assert.ok(restAlphaFor(100000) >= 0.07);
    assert.equal(labelMinScaleFor(10), 0.8);
    assert.equal(labelMinScaleFor(3000), 2.0);
    assert.equal(lerp(0, 10, 0.5), 5);
  });
});

describe('forces', () => {
  test('degreeMap counts both ends of each link, object or id', () => {
    const deg = degreeMap([{ source: 1, target: 2 }, { source: { id: 2 }, target: { id: 3 } }]);
    assert.equal(deg.get(2), 2);
    assert.equal(deg.get(1), 1);
  });

  test('cohesion 1 is the tightest charge, 0 the loosest', () => {
    assert.ok(Math.abs(chargeFor(1).strength) < Math.abs(chargeFor(0).strength));
    assert.ok(chargeFor(1).distanceMax < chargeFor(0).distanceMax);
  });
});

describe('export', () => {
  test('escapeHtml', () => {
    assert.equal(escapeHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  });

  test('exportJson resolves link endpoints to ids and keeps the documented fields', () => {
    const v = { nodes: [{ id: 1, type: 'Document', name: 'n', extra: 'dropped' }], links: [{ source: { id: 1 }, target: 2, relation: 'link' }] };
    const out = exportJson(v, 'T');
    assert.equal(out.exportedAt, 'T');
    assert.deepEqual(out.links, [{ source: 1, target: 2, relation: 'link' }]);
    assert.equal('extra' in out.nodes[0], false);
  });

  test('datestamp is the local calendar day', () => {
    assert.equal(datestamp(new Date(2026, 0, 5)), '2026-01-05');
  });

  test('the halo constants exist for the standalone page to interpolate', () => {
    assert.ok(HALO_BASE > 0 && HALO_MAX > HALO_BASE);
  });
});
