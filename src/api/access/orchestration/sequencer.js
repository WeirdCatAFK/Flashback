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
import { currentScope } from '../../requestContext.js';
import { orderCards, distance, CONFUSABLE_THRESHOLD } from './sequencing.js';

const hashOf = (card) => card.global_hash ?? card.globalHash;
const priorityOf = (card) => card.categoryPriority ?? card.category_priority ?? 0;
const normalize = (cards) => cards.map(c => ({
    ...c,
    globalHash: hashOf(c),
    categoryPriority: priorityOf(c),
}));

/** Session entry point: order a due set and stamp it with a session id. */
export async function sequence({ due = [], newCards = [], order = 'interleaved', seed = null } = {}) {
    const cards = normalize([...due, ...newCards]);
    const sessionId = randomUUID();
    const effectiveSeed = seed ?? (Date.now() & 0x7fffffff);

    if (order === 'priority' || cards.length === 0) {
        return { sessionId, order: 'priority', relaxation: 'none', queue: cards };
    }

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

/** Ordering telemetry for one review, computed from what was ACTUALLY presented. */
export async function measureOrdering({ sessionId, cardHash, prevCardHash, scope = null }) {
    if (!sessionId || !cardHash) return { prevDistance: null, nearestSiblingLag: null };

    try {
        const history = await query.getSessionReviewOrder(sessionId, scope ?? currentScope());
        const facets = await query.getSessionFacets(
            [...new Set([...history.map(r => r.globalHash), cardHash, prevCardHash].filter(Boolean))],
        );

        const prevDistance = prevCardHash ? distance(prevCardHash, cardHash, facets) : null;

        let nearestSiblingLag = null;
        for (let i = history.length - 1; i >= 0; i--) {
            if (distance(history[i].globalHash, cardHash, facets) <= CONFUSABLE_THRESHOLD) {
                nearestSiblingLag = history.length - i;
                break;
            }
        }

        return { prevDistance, nearestSiblingLag };
    } catch (err) {
        console.error('ordering telemetry failed:', err);
        return { prevDistance: null, nearestSiblingLag: null };
    }
}

export default { sequence, measureOrdering };
