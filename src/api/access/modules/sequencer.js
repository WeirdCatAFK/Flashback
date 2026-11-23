import { randomUUID } from 'crypto';
import * as sessionRows from '../resources/db/sessions.js';
import { currentScope } from '../../requestContext.js';
import { orderCards, distance, CONFUSABLE_THRESHOLD } from './sequencing.js';

const hashOf = (card) => card.global_hash ?? card.globalHash;
const priorityOf = (card) => card.categoryPriority ?? card.category_priority ?? 0;
const normalize = (cards) => cards.map(c => ({
    ...c,
    globalHash: hashOf(c),
    categoryPriority: priorityOf(c),
}));

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
        facets = await sessionRows.getFacets(cards.map(hashOf));
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

export async function measureOrdering({ sessionId, cardHash, prevCardHash, scope = null }) {
    if (!sessionId || !cardHash) return { prevDistance: null, nearestSiblingLag: null };

    try {
        const history = await sessionRows.getReviewOrder(sessionId, scope ?? currentScope());
        const facets = await sessionRows.getFacets(
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
