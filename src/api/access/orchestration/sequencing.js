export const CONFUSABLE_THRESHOLD = 1;
export const FAR_DISTANCE = 4;
export const MIN_LAG = 4;
export const WEAK_RUN_MAX = 3;
export const SATURATION_RATIO = 0.4;
export const TARGET_DISTANCE = 3;
export const W_DIST = 1.0;
export const W_URGENCY = 8.0;
export const WEAK_LEVEL = 2;

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

export function feasibleLag(clusterSizes, total) {
    const largest = Math.max(0, ...clusterSizes);
    if (largest <= 1) return MIN_LAG;
    return Math.max(0, Math.floor((total - 1) / (largest - 1)) - 1);
}

function interleaveTier(cards, facets, { minLag, includeFolderEdge, rand }) {
    const remaining = shuffled(cards, rand);
    const out = [];
    let run = 1;

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

        const scaffolding = previous != null && isWeak(previous) && run < WEAK_RUN_MAX;

        for (let i = 0; i < remaining.length; i++) {
            const candidate = remaining[i];
            const gap = nearestConflict(candidate);

            const scaffoldable = scaffolding
                && isWeak(candidate)
                && clusterOf.get(candidate.globalHash) === clusterOf.get(previous.globalHash);

            if (gap !== Infinity && !scaffoldable) {
                if (gap > fallbackGap) { fallbackGap = gap; fallbackIndex = i; }
                continue;
            }

            const d = previous
                ? distance(previous.globalHash, candidate.globalHash, facets, includeFolderEdge)
                : FAR_DISTANCE;
            const urgency = (outstanding.get(clusterOf.get(candidate.globalHash)) ?? 1) / remaining.length;
            const score = urgency * W_URGENCY
                - Math.abs(d - TARGET_DISTANCE) * W_DIST
                + rand() * 0.5;
            if (score > bestScore) { bestScore = score; bestIndex = i; }
        }

        if (bestIndex === -1) {
            const candidate = remaining[fallbackIndex];
            const continuesRun = previous
                && distance(previous.globalHash, candidate.globalHash, facets, includeFolderEdge) <= CONFUSABLE_THRESHOLD;
            if (continuesRun && !(isWeak(candidate) && run < WEAK_RUN_MAX)) {
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

        const chosen = take(bestIndex);
        const extendsRun = previous
            && distance(previous.globalHash, chosen.globalHash, facets, includeFolderEdge) <= CONFUSABLE_THRESHOLD;
        out.push(chosen);
        run = extendsRun ? run + 1 : 1;
    }

    return out;
}

export function orderCards(cards, facets, { seed = 1, explain = false } = {}) {
    const wrap = (order, relaxation) => (explain ? { order, relaxation } : order);
    if (!Array.isArray(cards) || cards.length === 0) return wrap([], 'none');

    const rand = mulberry32(seed);

    let includeFolderEdge = true;
    let relaxation = 'none';

    if (saturation(cards, facets, true) > SATURATION_RATIO) {
        includeFolderEdge = false;
        relaxation = 'no-folder-edge';
    }

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
