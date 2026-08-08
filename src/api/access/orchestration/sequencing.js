/**
 * sequencing.js — the pure ordering engine behind graph-aware interleaving.
 *
 * Imports nothing, touches no database and does no IO, exactly like `fsrs.js`: it is an
 * engine part of `sequencer.js`, not a tier of its own (see ACCESS.md). That is what lets
 * `tests/sequencing.test.js` pin its behaviour without a SQLite binary, and what makes the
 * ordering reproducible from a seed.
 *
 * The goal is interleaving. Reviewing ten cards from one document back to back builds
 * fluency that leans on the shared context to do the retrieving; the knowledge it produces
 * is cue-bound and doesn't survive to a shuffled recall attempt the next day. So graph
 * proximity is used as a SPACING signal, not a grouping one: confusable cards still co-occur
 * within a session — that's where discrimination is learned — but separated by unrelated
 * material.
 *
 * The one exception is weak material. A brand-new or lapsing card gets a short same-cluster
 * run so the learner can extract the pattern before being asked to discriminate under load.
 * That scaffold is per-card and outgrown automatically as strength rises; it is not a mode,
 * a phase, or anything the user schedules.
 *
 * The exported constants are tuning parameters, not settled values. The 3–5 item lag has
 * support as a starting point, not as an optimum; fit them against logged outcomes
 * (ReviewLogs.prev_distance / nearest_sibling_lag) rather than treating them as laws.
 */

// Two cards this close are treated as confusable and get the hard lag constraint.
export const CONFUSABLE_THRESHOLD = 1;
// Unrelated. Also the value for any pair we can't resolve — an unknown card is never
// assumed confusable, because a false constraint costs more than a missed one.
export const FAR_DISTANCE = 4;
// Minimum unrelated items between two confusable cards. The learner should have released
// one concept from working memory before its neighbour is retrieved.
export const MIN_LAG = 4;
// Longest same-cluster streak allowed for weak cards — the scaffold, not a licence to block.
export const WEAK_RUN_MAX = 3;
// Above this share of confusable pairs the constraint stops being satisfiable and the
// degradation ladder starts.
export const SATURATION_RATIO = 0.4;
// Preferred gap between consecutive cards. Deliberately NOT the maximum: always jumping as
// far as possible makes every transition the same kind of jump, and the relational structure
// (siblings, cousins, parent–child) never gets retrieved itself.
export const TARGET_DISTANCE = 3;
// How strongly the soft distance preference competes with the shuffle it starts from.
export const W_DIST = 1.0;
// How strongly a crowded cluster's need for room outranks the distance preference. Set
// above W_DIST * FAR_DISTANCE so scheduling pressure wins whenever it is genuinely tight.
export const W_URGENCY = 8.0;
// A card at or below this level is still being acquired and is eligible for scaffolding.
export const WEAK_LEVEL = 2;

/** Deterministic PRNG so a seed reproduces a sequence exactly (tests pin this). */
export function mulberry32(seed) {
    let a = seed >>> 0;
    return function next() {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function shuffled(items, rand) {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

const intersects = (a, b) => {
    if (!a?.size || !b?.size) return false;
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    for (const value of small) if (large.has(value)) return true;
    return false;
};

/**
 * Approximate graph distance between two cards, from their facets.
 *
 * A real BFS over Nodes/Connections would be more machinery than the signal justifies —
 * what matters is which band a pair falls into, and set overlap answers that directly.
 *
 *   1  same document, shared tag, or same immediate folder  → confusable
 *   2  shared deck, or their documents are directly linked
 *   3  documents share an ancestor folder within two levels
 *   4  nothing in common
 *
 * `includeFolderEdge = false` drops the same-folder rule, which is the first rung of the
 * degradation ladder: in a flat vault every document shares one parent and that edge alone
 * makes the whole session confusable.
 */
export function distance(hashA, hashB, facets, includeFolderEdge = true) {
    if (hashA === hashB) return 0;
    const a = facets?.get(hashA);
    const b = facets?.get(hashB);
    if (!a || !b) return FAR_DISTANCE;

    if (a.docId != null && a.docId === b.docId) return 1;
    if (intersects(a.tags, b.tags)) return 1;
    if (includeFolderEdge && a.folderId != null && a.folderId === b.folderId) return 1;

    if (intersects(a.deckIds, b.deckIds)) return 2;
    if ((a.docId != null && b.linkedDocIds?.has(a.docId))
        || (b.docId != null && a.linkedDocIds?.has(b.docId))) return 2;

    if (a.folderId != null && b.folderId != null) {
        const ancestorsA = new Set([a.folderId, ...(a.ancestorIds ?? [])]);
        const ancestorsB = new Set([b.folderId, ...(b.ancestorIds ?? [])]);
        if (intersects(ancestorsA, ancestorsB)) return 3;
    }

    return FAR_DISTANCE;
}

const isWeak = (card) => card.isNew === true
    || card.level == null
    || Number(card.level) <= WEAK_LEVEL;

/** Share of pairs in this set that read as confusable. Drives the degradation ladder. */
export function saturation(cards, facets, includeFolderEdge = true) {
    if (cards.length < 2) return 0;
    let confusable = 0;
    let pairs = 0;
    for (let i = 0; i < cards.length; i++) {
        for (let j = i + 1; j < cards.length; j++) {
            pairs++;
            const d = distance(cards[i].globalHash, cards[j].globalHash, facets, includeFolderEdge);
            if (d <= CONFUSABLE_THRESHOLD) confusable++;
        }
    }
    return confusable / pairs;
}

/**
 * Groups cards into connected components of the confusable graph.
 *
 * Confusability isn't transitive — A can share a document with B and B a tag with C without
 * A and C being related at all — so a component is an approximation. It's the right one for
 * scheduling pressure: what matters is how many cards still need room, not their exact
 * pairwise structure.
 */
function clusterize(cards, facets, includeFolderEdge) {
    const parent = cards.map((_, i) => i);
    const find = (x) => {
        let root = x;
        while (parent[root] !== root) { parent[root] = parent[parent[root]]; root = parent[root]; }
        return root;
    };
    for (let i = 0; i < cards.length; i++) {
        for (let j = i + 1; j < cards.length; j++) {
            const d = distance(cards[i].globalHash, cards[j].globalHash, facets, includeFolderEdge);
            if (d > CONFUSABLE_THRESHOLD) continue;
            const a = find(i);
            const b = find(j);
            if (a !== b) parent[a] = b;
        }
    }
    return new Map(cards.map((c, i) => [c.globalHash, find(i)]));
}

/**
 * The largest lag a set of clusters can actually sustain.
 *
 * Spacing k members of one cluster g items apart inside n slots needs
 * (k - 1) * (g + 1) + 1 <= n. Beyond that the constraint isn't strict, it's impossible, and
 * a greedy told to honour it anyway spends its buffer early and piles the remainder up at
 * the end of the session — producing exactly the blocked run this module exists to prevent.
 *
 * Asking the geometry first is what makes the difference between "the lag was relaxed" and
 * "the lag silently failed at the tail". Returns 0 when even adjacent placement can't fit,
 * which is the signal to stop pretending and shuffle.
 */
export function feasibleLag(clusterSizes, total) {
    const largest = Math.max(0, ...clusterSizes);
    if (largest <= 1) return MIN_LAG;
    return Math.max(0, Math.floor((total - 1) / (largest - 1)) - 1);
}

/**
 * Greedy interleave of one tier under a fixed lag.
 *
 * Starts from a shuffle — which is already better than blocking — and improves it, so any
 * failure mode degrades toward randomness rather than toward clusters.
 *
 * The scheduling pressure term is what keeps this from stranding: a plain "pick the
 * furthest legal card" greedy happily spends its unrelated buffer early and then has
 * nothing left to separate the last few members of a big cluster, so they pile up at the
 * end of the session — the exact blocking this exists to prevent. Emitting from the
 * cluster with the most members still outstanding spends the buffer evenly instead.
 */
function interleaveTier(cards, facets, { minLag, includeFolderEdge, rand }) {
    const remaining = shuffled(cards, rand);
    const out = [];
    let run = 1; // consecutive confusable cards currently emitted

    const clusterOf = clusterize(cards, facets, includeFolderEdge);
    const outstanding = new Map();
    for (const card of cards) {
        const id = clusterOf.get(card.globalHash);
        outstanding.set(id, (outstanding.get(id) ?? 0) + 1);
    }
    const take = (index) => {
        const [card] = remaining.splice(index, 1);
        const id = clusterOf.get(card.globalHash);
        outstanding.set(id, outstanding.get(id) - 1);
        return card;
    };

    const nearestConflict = (candidate) => {
        // Distance back to the closest confusable card already emitted, within the lag
        // window. Infinity when the candidate is legal here.
        let gap = Infinity;
        const from = Math.max(0, out.length - minLag);
        for (let i = from; i < out.length; i++) {
            const d = distance(out[i].globalHash, candidate.globalHash, facets, includeFolderEdge);
            if (d <= CONFUSABLE_THRESHOLD) gap = Math.min(gap, out.length - i);
        }
        return gap;
    };

    while (remaining.length > 0) {
        const previous = out[out.length - 1];
        let bestIndex = -1;
        let bestScore = -Infinity;
        let fallbackIndex = 0;
        let fallbackGap = -1;

        // The weak-node scaffold, applied deliberately rather than only under pressure.
        // A card that is new or lapsing hasn't formed the pattern yet, and asking it to
        // compete for retrieval against unrelated material immediately is asking it to fail
        // for the wrong reason. So while the previous card was weak, its cluster-mates stay
        // legal for a couple more slots — a run of at most WEAK_RUN_MAX — and then the lag
        // reasserts itself. This is per-card and disappears on its own as the card's level
        // rises; it is never a mode the user selects.
        const scaffolding = previous != null && isWeak(previous) && run < WEAK_RUN_MAX;

        for (let i = 0; i < remaining.length; i++) {
            const candidate = remaining[i];
            const gap = nearestConflict(candidate);

            const scaffoldable = scaffolding
                && isWeak(candidate)
                && clusterOf.get(candidate.globalHash) === clusterOf.get(previous.globalHash);

            if (gap !== Infinity && !scaffoldable) {
                // Illegal here. Track the least-bad option in case nothing is legal: the
                // candidate whose nearest confusable neighbour sits furthest back.
                if (gap > fallbackGap) { fallbackGap = gap; fallbackIndex = i; }
                continue;
            }

            const d = previous
                ? distance(previous.globalHash, candidate.globalHash, facets, includeFolderEdge)
                : FAR_DISTANCE;
            // Urgency dominates when a cluster is dense relative to what's left to space it
            // with, and fades to nothing once the crowded clusters are drained. Below it,
            // prefer the medium-to-high band rather than the maximum, and break remaining
            // ties with the seeded PRNG so equally good choices still vary between sessions.
            const urgency = (outstanding.get(clusterOf.get(candidate.globalHash)) ?? 1) / remaining.length;
            const score = urgency * W_URGENCY
                - Math.abs(d - TARGET_DISTANCE) * W_DIST
                + rand() * 0.5;
            if (score > bestScore) { bestScore = score; bestIndex = i; }
        }

        if (bestIndex === -1) {
            // Nothing legal. The scaffold is the only sanctioned way to emit a confusable
            // card early, and only for weak material, and only briefly.
            const candidate = remaining[fallbackIndex];
            const continuesRun = previous
                && distance(previous.globalHash, candidate.globalHash, facets, includeFolderEdge) <= CONFUSABLE_THRESHOLD;
            if (continuesRun && !(isWeak(candidate) && run < WEAK_RUN_MAX)) {
                // Would extend a run we're not allowed to extend — prefer any card that
                // isn't adjacent to the previous one, even if it breaks the wider lag.
                const alternative = remaining.findIndex(c => c !== candidate
                    && distance(previous.globalHash, c.globalHash, facets, includeFolderEdge) > CONFUSABLE_THRESHOLD);
                if (alternative !== -1) {
                    out.push(take(alternative));
                    run = 1;
                    continue;
                }
            }
            out.push(take(fallbackIndex));
            run = continuesRun ? run + 1 : 1;
            continue;
        }

        // A scaffolded pick sits next to its cluster-mate on purpose, so the run has to
        // keep counting — resetting here would let the scaffold extend indefinitely.
        const chosen = take(bestIndex);
        const extendsRun = previous
            && distance(previous.globalHash, chosen.globalHash, facets, includeFolderEdge) <= CONFUSABLE_THRESHOLD;
        out.push(chosen);
        run = extendsRun ? run + 1 : 1;
    }

    return out;
}

/**
 * Order one session's cards.
 *
 * Pedagogical tiers are an outer partition: they stay in priority order (foundational
 * before exercises) and sequencing happens inside each one, so this never reorders a
 * definition behind the exercise that depends on it.
 *
 * Degradation ladder, applied in order and reported as `relaxation`:
 *   none            → the full MIN_LAG held
 *   no-folder-edge  → same-folder pairs stopped counting as confusable
 *   short-lag       → lag lowered to what the tier's geometry can actually sustain
 *   shuffle         → not even adjacent placement fits; plain seeded shuffle
 *
 * @param {Array}  cards   session cards ({ globalHash, categoryPriority, level, isNew })
 * @param {Map}    facets  from query.getSessionFacets
 * @param {object} opts    { seed, explain }
 * @returns {Array|{order, relaxation}} ordered cards, or both when `explain` is set
 */
export function orderCards(cards, facets, { seed = 1, explain = false } = {}) {
    const wrap = (order, relaxation) => (explain ? { order, relaxation } : order);
    if (!Array.isArray(cards) || cards.length === 0) return wrap([], 'none');

    const rand = mulberry32(seed);

    let includeFolderEdge = true;
    let relaxation = 'none';

    // Rung 1: in a flat vault every document shares one parent, and that edge alone makes
    // the whole session confusable. Drop it before touching the lag — losing the weakest
    // relatedness signal costs less than losing the spacing everywhere.
    if (saturation(cards, facets, true) > SATURATION_RATIO) {
        includeFolderEdge = false;
        relaxation = 'no-folder-edge';
    }

    // Rung 2: ask the geometry what lag is actually achievable, per tier, since tiers are
    // sequenced independently and a small tier has less room than the session suggests.
    const clusterOf = clusterize(cards, facets, includeFolderEdge);
    const tiers = [...new Set(cards.map(c => c.categoryPriority ?? 0))].sort((a, b) => a - b);
    const lagByTier = new Map();
    for (const tier of tiers) {
        const inTier = cards.filter(c => (c.categoryPriority ?? 0) === tier);
        const sizes = new Map();
        for (const card of inTier) {
            const id = clusterOf.get(card.globalHash);
            sizes.set(id, (sizes.get(id) ?? 0) + 1);
        }
        const achievable = feasibleLag([...sizes.values()], inTier.length);
        lagByTier.set(tier, Math.min(MIN_LAG, achievable));
        if (achievable < MIN_LAG && relaxation !== 'shuffle') {
            relaxation = achievable < 1 ? 'shuffle' : 'short-lag';
        }
    }

    // Rung 3: a tier whose dominant cluster can't even be placed non-adjacently has nothing
    // to interleave with. Shuffle — never cluster.
    if (relaxation === 'shuffle') {
        const order = [];
        for (const tier of tiers) {
            order.push(...shuffled(cards.filter(c => (c.categoryPriority ?? 0) === tier), rand));
        }
        return wrap(order, 'shuffle');
    }

    const order = [];
    for (const tier of tiers) {
        const inTier = cards.filter(c => (c.categoryPriority ?? 0) === tier);
        order.push(...interleaveTier(inTier, facets, {
            minLag: lagByTier.get(tier),
            includeFolderEdge,
            rand,
        }));
    }

    return wrap(order, relaxation);
}
