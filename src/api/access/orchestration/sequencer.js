/**
 * sequencer.js — decides the ORDER a session's due cards are presented in.
 *
 * Strictly separate from the scheduler. `srs.js` decides WHICH cards are due today;
 * nothing in this file may influence that. Topology never pulls a card forward or pushes it
 * back across days — mixing selection and sequencing would corrupt the retention estimates,
 * which are already hard to read through new-card noise. This module only arranges what it
 * is handed.
 *
 * Layering: imports `query.js` and the pure `sequencing.js` engine only — never `srs.js`,
 * never `documents.js` — and is composed at the route layer, exactly like `cardHealth.js`
 * (see ACCESS.md). That is what keeps the scheduler ignorant of sequencing in the code and
 * not just in the design doc. All the ordering maths lives in `sequencing.js`, which imports
 * nothing and is tested without a database.
 */
import { randomUUID } from 'crypto';
import query from '../resources/query.js';
import { orderCards, distance, CONFUSABLE_THRESHOLD } from './sequencing.js';

// getDue() hands us raw DB rows (snake_case); the ordering engine speaks the client's
// camelCase shape. This module is the single place that knows about the split — every card
// entering `orderCards` goes through `normalize()` first. Getting this wrong is silent: the
// queue still holds every card exactly once, it just stops meaning anything.
const hashOf = (card) => card.global_hash ?? card.globalHash;
// A missing priority reads as 0 (the most foundational tier), matching getDue()'s own
// COALESCE — but a *mis-read* priority collapses every card into that tier, which is why the
// snake_case name has to be consulted here rather than defaulted past.
const priorityOf = (card) => card.categoryPriority ?? card.category_priority ?? 0;
const normalize = (cards) => cards.map(c => ({
    ...c,
    globalHash: hashOf(c),
    categoryPriority: priorityOf(c),
}));

/**
 * Session entry point: order a due set and stamp it with a session id.
 *
 * `order` mirrors the client's `fb-trainer-order` preference:
 *   interleaved — graph-aware (default)
 *   shuffle     — random within tiers, no graph reads
 *   priority    — the pre-sequencing behaviour, kept so a user can opt back out
 *
 * Never throws on account of the graph: if facets can't be read, the session falls back to
 * a shuffle and the user still gets to study.
 */
export async function sequence({ due = [], newCards = [], order = 'interleaved', seed = null } = {}) {
    const cards = normalize([...due, ...newCards]);
    const sessionId = randomUUID();
    const effectiveSeed = seed ?? (Date.now() & 0x7fffffff);

    if (order === 'priority' || cards.length === 0) {
        return { sessionId, order: 'priority', relaxation: 'none', queue: cards };
    }

    // An empty facet map makes every pair read as FAR_DISTANCE, so orderCards degrades to a
    // plain within-tier shuffle without a special case — and without touching the database.
    if (order === 'shuffle') {
        return {
            sessionId,
            order: 'shuffle',
            relaxation: 'shuffle',
            queue: orderCards(cards, new Map(), { seed: effectiveSeed }),
        };
    }

    let facets;
    try {
        facets = await query.getSessionFacets(cards.map(hashOf));
    } catch (err) {
        console.error('session facets unavailable, falling back to shuffle:', err);
        return {
            sessionId,
            order: 'shuffle',
            relaxation: 'shuffle',
            queue: orderCards(cards, new Map(), { seed: effectiveSeed }),
        };
    }

    const { order: queue, relaxation } = orderCards(cards, facets, {
        seed: effectiveSeed,
        explain: true,
    });

    return { sessionId, order: 'interleaved', relaxation, queue };
}

/**
 * Ordering telemetry for one review, computed from what was ACTUALLY presented.
 *
 * The client reports the card shown immediately before this one, so a card re-queued after
 * a failed grade is measured at its real position rather than the one the sequencer planned.
 * Returns nulls rather than zeros when there's nothing to measure — a review with no logged
 * ordering must never read as "shown next to its sibling".
 */
export async function measureOrdering({ sessionId, cardHash, prevCardHash }) {
    if (!sessionId || !cardHash) return { prevDistance: null, nearestSiblingLag: null };

    try {
        const history = await query.getSessionReviewOrder(sessionId);
        const facets = await query.getSessionFacets(
            [...new Set([...history.map(r => r.globalHash), cardHash, prevCardHash].filter(Boolean))],
        );

        const prevDistance = prevCardHash ? distance(prevCardHash, cardHash, facets) : null;

        // Walk back through what was actually shown for the nearest confusable sibling.
        let nearestSiblingLag = null;
        for (let i = history.length - 1; i >= 0; i--) {
            if (distance(history[i].globalHash, cardHash, facets) <= CONFUSABLE_THRESHOLD) {
                nearestSiblingLag = history.length - i;
                break;
            }
        }

        return { prevDistance, nearestSiblingLag };
    } catch (err) {
        // Telemetry must never cost the user a graded review.
        console.error('ordering telemetry failed:', err);
        return { prevDistance: null, nearestSiblingLag: null };
    }
}

export default { sequence, measureOrdering };
