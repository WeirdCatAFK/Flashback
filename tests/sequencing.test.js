// Session sequencing tests — the correctness backstop for graph-aware interleaving.
// Pure functions, no database. Run: node --test tests/sequencer.test.js
//
// The properties pinned here are the ones the design actually rests on: the hard lag
// constraint, the ordered degradation ladder (which must never end in clustering), the
// bounded weak-node scaffold, tier containment, and reproducibility under a fixed seed.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    MIN_LAG,
    WEAK_RUN_MAX,
    CONFUSABLE_THRESHOLD,
    FAR_DISTANCE,
    SATURATION_RATIO,
    distance,
    feasibleLag,
    orderCards,
} from '../src/api/access/orchestration/sequencing.js';

// --- builders -------------------------------------------------------------
// A card as the sequencer sees it: identity, tier, and strength. Everything
// relational lives in the facet map, exactly as it does at runtime.
let counter = 0;
const card = (over = {}) => ({
    globalHash: `h${++counter}`,
    categoryPriority: 0,
    level: 5,
    isNew: false,
    ...over,
});

const facet = (over = {}) => ({
    docId: null,
    folderId: null,
    ancestorIds: [],
    tags: new Set(),
    deckIds: new Set(),
    linkedDocIds: new Set(),
    ...over,
});

// n cards, each in its own document/folder — mutually unrelated (distance FAR).
const unrelated = (n, over = {}) => {
    const cards = [];
    const facets = new Map();
    for (let i = 0; i < n; i++) {
        const c = card(over);
        cards.push(c);
        facets.set(c.globalHash, facet({ docId: 1000 + counter, folderId: 2000 + counter }));
    }
    return { cards, facets };
};

// n cards all anchored to one document — mutually confusable.
const oneDocument = (n, over = {}) => {
    const cards = [];
    const facets = new Map();
    for (let i = 0; i < n; i++) {
        const c = card(over);
        cards.push(c);
        facets.set(c.globalHash, facet({ docId: 7, folderId: 9 }));
    }
    return { cards, facets };
};

const merge = (...groups) => ({
    cards: groups.flatMap(g => g.cards),
    facets: new Map(groups.flatMap(g => [...g.facets])),
});

// Smallest gap between any two confusable cards in the emitted order.
const minConfusableGap = (order, facets) => {
    let min = Infinity;
    for (let i = 0; i < order.length; i++) {
        for (let j = i + 1; j < order.length; j++) {
            const d = distance(order[i].globalHash, order[j].globalHash, facets);
            if (d <= CONFUSABLE_THRESHOLD) min = Math.min(min, j - i);
        }
    }
    return min;
};

const longestRun = (order, facets) => {
    let best = 1, run = 1;
    for (let i = 1; i < order.length; i++) {
        const d = distance(order[i - 1].globalHash, order[i].globalHash, facets);
        if (d <= CONFUSABLE_THRESHOLD) { run += 1; best = Math.max(best, run); } else run = 1;
    }
    return best;
};

// --- distance -------------------------------------------------------------

describe('distance', () => {
    it('rates same-document, shared-tag and same-folder cards as confusable', () => {
        const facets = new Map([
            ['sameDocA', facet({ docId: 1, folderId: 1 })],
            ['sameDocB', facet({ docId: 1, folderId: 1 })],
            ['tagA', facet({ docId: 2, folderId: 5, tags: new Set(['verbs']) })],
            ['tagB', facet({ docId: 3, folderId: 6, tags: new Set(['verbs']) })],
            ['folderA', facet({ docId: 4, folderId: 8 })],
            ['folderB', facet({ docId: 5, folderId: 8 })],
        ]);
        assert.ok(distance('sameDocA', 'sameDocB', facets) <= CONFUSABLE_THRESHOLD);
        assert.ok(distance('tagA', 'tagB', facets) <= CONFUSABLE_THRESHOLD);
        assert.ok(distance('folderA', 'folderB', facets) <= CONFUSABLE_THRESHOLD);
    });

    it('rates shared decks and linked documents as near but not confusable', () => {
        const facets = new Map([
            ['deckA', facet({ docId: 1, folderId: 1, deckIds: new Set([3]) })],
            ['deckB', facet({ docId: 2, folderId: 2, deckIds: new Set([3]) })],
            ['linkA', facet({ docId: 10, folderId: 3, linkedDocIds: new Set([11]) })],
            ['linkB', facet({ docId: 11, folderId: 4 })],
        ]);
        for (const [a, b] of [['deckA', 'deckB'], ['linkA', 'linkB']]) {
            const d = distance(a, b, facets);
            assert.ok(d > CONFUSABLE_THRESHOLD, `${a}/${b} must not be confusable`);
            assert.ok(d < FAR_DISTANCE, `${a}/${b} must still read as related`);
        }
    });

    it('rates cards with no shared facet as far apart', () => {
        const facets = new Map([
            ['a', facet({ docId: 1, folderId: 1 })],
            ['b', facet({ docId: 2, folderId: 2 })],
        ]);
        assert.equal(distance('a', 'b', facets), FAR_DISTANCE);
    });

    it('is symmetric and treats a missing facet as far, never as confusable', () => {
        const facets = new Map([['a', facet({ docId: 1, folderId: 1 })]]);
        assert.equal(distance('a', 'ghost', facets), FAR_DISTANCE);
        assert.equal(distance('ghost', 'a', facets), FAR_DISTANCE);
    });

    it('does not call two standalone cards confusable just for lacking a document', () => {
        const facets = new Map([
            ['s1', facet()],
            ['s2', facet()],
        ]);
        assert.equal(distance('s1', 's2', facets), FAR_DISTANCE);
    });
});

// --- hard constraint ------------------------------------------------------

describe('orderCards — min-lag constraint', () => {
    it('separates confusable cards by at least MIN_LAG when the session allows it', () => {
        // 6 cards from one document, buffered by 30 unrelated ones: satisfiable.
        const input = merge(oneDocument(6), unrelated(30));
        const order = orderCards(input.cards, input.facets, { seed: 1 });
        assert.equal(order.length, 36);
        assert.ok(
            minConfusableGap(order, input.facets) >= MIN_LAG,
            'confusable pair landed closer than MIN_LAG',
        );
    });

    it('emits every card exactly once', () => {
        const input = merge(oneDocument(5), unrelated(20));
        const order = orderCards(input.cards, input.facets, { seed: 7 });
        const seen = new Set(order.map(c => c.globalHash));
        assert.equal(seen.size, input.cards.length);
        assert.equal(order.length, input.cards.length);
    });
});

// --- degradation ----------------------------------------------------------

describe('orderCards — degradation', () => {
    it('degrades to a shuffle, never to clusters, when every card is confusable', () => {
        // A flat vault: 24 cards, one folder, nothing to interleave with. The hard
        // constraint is unsatisfiable, so the ladder must bottom out at shuffle —
        // the one outcome that must NOT happen is grouped output.
        const input = oneDocument(24);
        const order = orderCards(input.cards, input.facets, { seed: 3 });
        assert.equal(order.length, 24);
        assert.equal(new Set(order.map(c => c.globalHash)).size, 24);

        // Shuffle, not input order: a saturated session must still be randomized.
        const inOriginalOrder = order.every((c, i) => c.globalHash === input.cards[i].globalHash);
        assert.ok(!inOriginalOrder, 'saturated session returned creation order');
    });

    it('reports the relaxation it settled on', () => {
        const flat = oneDocument(20);
        const flatResult = orderCards(flat.cards, flat.facets, { seed: 5, explain: true });
        assert.equal(flatResult.relaxation, 'shuffle');

        const roomy = merge(oneDocument(4), unrelated(30));
        const roomyResult = orderCards(roomy.cards, roomy.facets, { seed: 5, explain: true });
        assert.equal(roomyResult.relaxation, 'none');
    });

    it('drops the folder edge before lowering the lag when folders saturate', () => {
        // 20 cards, distinct documents, all under one folder, no shared tags. Only the
        // same-folder edge makes them confusable — dropping it alone restores slack.
        const cards = [];
        const facets = new Map();
        for (let i = 0; i < 20; i++) {
            const c = card();
            cards.push(c);
            facets.set(c.globalHash, facet({ docId: 100 + i, folderId: 42 }));
        }
        const result = orderCards(cards, facets, { seed: 11, explain: true });
        assert.equal(result.relaxation, 'no-folder-edge');
        assert.equal(result.order.length, 20);
    });

    it('recognizes saturation at the configured ratio', () => {
        assert.ok(SATURATION_RATIO > 0 && SATURATION_RATIO < 1);
    });

    it('lowers the lag to what the geometry can actually sustain', () => {
        // 12 cluster-mates in 36 slots cannot all sit MIN_LAG apart: (12-1)*(4+1)+1 = 56 > 36.
        // Honouring MIN_LAG anyway is what strands the remainder in a block at the end, so
        // the achievable lag has to be computed rather than assumed.
        assert.equal(feasibleLag([12], 36), 2);
        assert.ok((12 - 1) * (2 + 1) + 1 <= 36, 'derived lag must actually fit');

        // Roomy: the full lag survives.
        assert.ok(feasibleLag([6], 36) >= MIN_LAG);
        // Singleton clusters are unconstrained.
        assert.equal(feasibleLag([1, 1, 1], 10), MIN_LAG);
        // Nothing to interleave with at all.
        assert.equal(feasibleLag([24], 24), 0);
    });

    it('reports short-lag, not none, when the geometry forced a smaller lag', () => {
        const crowded = merge(oneDocument(12), unrelated(24));
        const result = orderCards(crowded.cards, crowded.facets, { seed: 2, explain: true });
        assert.equal(result.relaxation, 'short-lag');
    });
});

// --- weak-node scaffold ---------------------------------------------------

describe('orderCards — weak-node scaffold', () => {
    it('never runs a same-cluster streak longer than WEAK_RUN_MAX', () => {
        const weak = oneDocument(12, { isNew: true, level: 0 });
        const input = merge(weak, unrelated(24));
        const order = orderCards(input.cards, input.facets, { seed: 2 });
        assert.ok(
            longestRun(order, input.facets) <= WEAK_RUN_MAX,
            'weak-card run exceeded WEAK_RUN_MAX',
        );
    });

    it('does not scaffold mature cards — they get the full lag', () => {
        const input = merge(oneDocument(6, { isNew: false, level: 9 }), unrelated(30));
        const order = orderCards(input.cards, input.facets, { seed: 4 });
        assert.equal(longestRun(order, input.facets), 1, 'mature cards were blocked together');
    });
});

// --- tiers ----------------------------------------------------------------

describe('orderCards — pedagogical tiers', () => {
    it('never lets a later tier precede an earlier one', () => {
        const input = merge(
            unrelated(8, { categoryPriority: 0 }),
            unrelated(8, { categoryPriority: 1 }),
            unrelated(8, { categoryPriority: 2 }),
        );
        const order = orderCards(input.cards, input.facets, { seed: 6 });
        const priorities = order.map(c => c.categoryPriority);
        assert.deepEqual(priorities, [...priorities].sort((a, b) => a - b));
    });

    it('shuffles within a tier rather than preserving creation order', () => {
        const input = unrelated(30, { categoryPriority: 1 });
        const order = orderCards(input.cards, input.facets, { seed: 8 });
        const identical = order.every((c, i) => c.globalHash === input.cards[i].globalHash);
        assert.ok(!identical, 'tier came back in creation order');
    });
});

// --- reproducibility ------------------------------------------------------

describe('orderCards — seeding', () => {
    it('reproduces an identical sequence for the same seed', () => {
        const input = merge(oneDocument(5), unrelated(20));
        const a = orderCards(input.cards, input.facets, { seed: 42 });
        const b = orderCards(input.cards, input.facets, { seed: 42 });
        assert.deepEqual(a.map(c => c.globalHash), b.map(c => c.globalHash));
    });

    it('produces different sequences for different seeds', () => {
        const input = merge(oneDocument(5), unrelated(20));
        const a = orderCards(input.cards, input.facets, { seed: 1 });
        const b = orderCards(input.cards, input.facets, { seed: 2 });
        assert.notDeepEqual(a.map(c => c.globalHash), b.map(c => c.globalHash));
    });

    it('does not mutate the caller\'s array', () => {
        const input = merge(oneDocument(4), unrelated(10));
        const before = input.cards.map(c => c.globalHash);
        orderCards(input.cards, input.facets, { seed: 9 });
        assert.deepEqual(input.cards.map(c => c.globalHash), before);
    });
});

// --- edge cases -----------------------------------------------------------

describe('orderCards — edge cases', () => {
    it('handles empty, single-card and facet-less sessions', () => {
        assert.deepEqual(orderCards([], new Map(), { seed: 1 }), []);

        const one = unrelated(1);
        assert.equal(orderCards(one.cards, one.facets, { seed: 1 }).length, 1);

        // No facets at all (a vault mid-rebuild): everything reads as far apart, and
        // the result must still be a complete shuffle rather than an error.
        const bare = unrelated(10);
        const order = orderCards(bare.cards, new Map(), { seed: 1 });
        assert.equal(order.length, 10);
    });
});
