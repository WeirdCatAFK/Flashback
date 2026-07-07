// FSRS-6 math tests — the correctness backstop for the hand-rolled scheduler.
// Pure functions, no database. Run: node --test tests/fsrs.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_WEIGHTS,
    WEIGHT_BOUNDS,
    MIN_OPTIMIZE_REVIEWS,
    STATE,
    retrievability,
    intervalFromStability,
    initialCard,
    nextState,
    optimize,
} from '../src/api/access/fsrs.js';

const W = DEFAULT_WEIGHTS;
const approx = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
const daysAgo = (n) => new Date(Date.now() - n * 86400000);

describe('FSRS-6 weights', () => {
    it('ships exactly 21 default weights', () => {
        assert.equal(W.length, 21);
        assert.ok(W.every((x) => typeof x === 'number' && Number.isFinite(x)));
    });
});

describe('retrievability', () => {
    it('is 1 at t=0 and decreases with elapsed time', () => {
        assert.ok(approx(retrievability(0, 10), 1));
        assert.ok(retrievability(5, 10) < 1);
        assert.ok(retrievability(20, 10) < retrievability(5, 10));
    });

    it('equals requested retention at the derived interval (inverse round-trip)', () => {
        for (const S of [5, 20, 100]) {
            for (const r of [0.8, 0.9, 0.95]) {
                const I = intervalFromStability(S, r);
                // Skip cases clamped to the 1-day floor: when the ideal interval
                // is sub-day the round-trip can't hold at day granularity.
                if (I <= 1) continue;
                // interval is rounded to whole days, so allow a small tolerance
                assert.ok(
                    approx(retrievability(I, S), r, 0.03),
                    `S=${S} r=${r}: R(${I},${S})=${retrievability(I, S)}`,
                );
            }
        }
    });
});

describe('intervalFromStability', () => {
    it('is monotonically increasing in stability', () => {
        let prev = 0;
        for (const S of [0.5, 1, 5, 20, 100, 500]) {
            const I = intervalFromStability(S, 0.9);
            assert.ok(I >= prev, `interval should grow with stability (S=${S})`);
            prev = I;
        }
    });

    it('is at least 1 day and capped', () => {
        assert.ok(intervalFromStability(0.01, 0.9) >= 1);
        assert.ok(intervalFromStability(1e9, 0.9) <= 36500);
    });
});

describe('initial review (state NEW)', () => {
    it('sets initial stability S0 = w[G-1] for each grade', () => {
        for (const G of [1, 2, 3, 4]) {
            const c = initialCard(G, new Date());
            assert.ok(approx(c.stability, W[G - 1]), `G=${G}`);
        }
    });

    it('computes initial difficulty D0 = w4 - exp(w5*(G-1)) + 1, clamped [1,10]', () => {
        for (const G of [1, 2, 3, 4]) {
            const expected = Math.min(10, Math.max(1, W[4] - Math.exp(W[5] * (G - 1)) + 1));
            const c = initialCard(G, new Date());
            assert.ok(approx(c.difficulty, expected, 1e-9), `G=${G}`);
            assert.ok(c.difficulty >= 1 && c.difficulty <= 10);
        }
    });

    it('routes Again to relearning and everything else to review', () => {
        assert.equal(initialCard(1, new Date()).state, STATE.RELEARNING);
        assert.equal(initialCard(3, new Date()).state, STATE.REVIEW);
        assert.equal(initialCard(1, new Date()).lapses, 1);
        assert.equal(initialCard(3, new Date()).lapses, 0);
    });

    it('a NEW card passed to nextState is treated as a first review', () => {
        const c = nextState({ state: STATE.NEW }, 3, new Date());
        assert.ok(approx(c.stability, W[2]));
        assert.equal(c.reps, 1);
    });
});

describe('subsequent reviews', () => {
    const base = {
        stability: 10,
        difficulty: 5,
        state: STATE.REVIEW,
        reps: 3,
        lapses: 0,
        last_review: daysAgo(10),
    };

    it('increases stability on a successful recall (Good)', () => {
        const c = nextState(base, 3, new Date());
        assert.ok(c.stability > base.stability);
        assert.equal(c.state, STATE.REVIEW);
        assert.equal(c.reps, 4);
    });

    it('orders resulting stability Easy > Good > Hard', () => {
        const hard = nextState(base, 2, new Date()).stability;
        const good = nextState(base, 3, new Date()).stability;
        const easy = nextState(base, 4, new Date()).stability;
        assert.ok(easy > good, `easy ${easy} > good ${good}`);
        assert.ok(good > hard, `good ${good} > hard ${hard}`);
    });

    it('drops stability and increments lapses on a lapse (Again), never above pre-lapse', () => {
        const c = nextState(base, 1, new Date());
        assert.ok(c.stability <= base.stability);
        assert.equal(c.state, STATE.RELEARNING);
        assert.equal(c.lapses, 1);
    });

    it('keeps difficulty within [1,10] across all grades', () => {
        for (const G of [1, 2, 3, 4]) {
            const c = nextState(base, G, new Date());
            assert.ok(c.difficulty >= 1 && c.difficulty <= 10, `G=${G} -> D=${c.difficulty}`);
        }
    });

    it('Easy schedules a longer interval than Good', () => {
        const good = nextState(base, 3, new Date()).interval;
        const easy = nextState(base, 4, new Date()).interval;
        assert.ok(easy >= good);
    });

    it('produces a due date in the future relative to the review time', () => {
        const now = new Date();
        const c = nextState(base, 3, now);
        assert.ok(new Date(c.due).getTime() > now.getTime());
    });
});

describe('per-vault optimizer', () => {
    const DAY = 86400000;
    // Deterministic PRNG so the synthetic history (and thus the fit) is reproducible.
    const mulberry32 = (seed) => () => {
        seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    // Simulate review logs from a *known* weight vector: outcomes are drawn from
    // that model's retrievability, so DEFAULT_WEIGHTS is a genuine mismatch the
    // optimizer can improve on.
    const makeHistory = (trueW, { cards = 60, reviews = 12, seed = 1234 } = {}) => {
        const rng = mulberry32(seed);
        const gaps = [0, 1, 2, 4, 7, 10, 14, 9, 21, 15, 30, 20, 25]; // days before review i
        const base = Date.UTC(2025, 0, 1);
        const rows = [];
        for (let c = 0; c < cards; c++) {
            let card = null;
            let t = base + c * 3600000;
            for (let i = 0; i < reviews; i++) {
                if (i > 0) t += gaps[i] * DAY;
                let grade;
                if (!card) grade = 3;
                else {
                    const p = retrievability(gaps[i], card.stability, trueW);
                    grade = rng() < p ? 3 : 1;
                }
                rows.push({ flashcard_id: c + 1, timestamp: new Date(t).toISOString(), rating: grade });
                card = nextState(card, grade, new Date(t), trueW);
            }
        }
        return rows;
    };

    it('keeps default weights when there is too little data', () => {
        const rows = makeHistory(DEFAULT_WEIGHTS, { cards: 5, reviews: 6 }); // 30 < 400
        const res = optimize(rows);
        assert.equal(res.optimized, false);
        assert.equal(res.reason, 'insufficient-data');
        assert.deepEqual(res.weights, DEFAULT_WEIGHTS);
        assert.ok(res.reviewCount < MIN_OPTIMIZE_REVIEWS);
    });

    it('lowers the loss when the data comes from mismatched weights', () => {
        const trueW = DEFAULT_WEIGHTS.slice();
        trueW[20] = 0.5;   // decay (default 0.2)
        trueW[8] = 2.5;    // recall-stability scale
        trueW[10] = 1.2;   // retrievability term
        const rows = makeHistory(trueW, { cards: 60, reviews: 12 });

        const res = optimize(rows);
        assert.equal(res.optimized, true);
        assert.ok(res.reviewCount >= MIN_OPTIMIZE_REVIEWS, `only ${res.reviewCount} reviews`);
        assert.ok(res.loss < res.initialLoss, `loss ${res.loss} !< ${res.initialLoss}`);
    });

    it('returns weights inside the FSRS parameter bounds', () => {
        const trueW = DEFAULT_WEIGHTS.slice();
        trueW[20] = 0.45;
        const rows = makeHistory(trueW, { cards: 60, reviews: 12, seed: 99 });
        const res = optimize(rows);
        assert.equal(res.weights.length, 21);
        res.weights.forEach((x, i) => {
            const [lo, hi] = WEIGHT_BOUNDS[i];
            assert.ok(x >= lo && x <= hi, `w[${i}]=${x} out of [${lo},${hi}]`);
        });
    });
});

describe('same-day (short-term) reviews', () => {
    it('uses the short-term update when elapsed < 1 day', () => {
        const card = {
            stability: 2,
            difficulty: 5,
            state: STATE.LEARNING,
            reps: 1,
            lapses: 0,
            last_review: new Date(Date.now() - 3600 * 1000), // 1h ago
        };
        const good = nextState(card, 3, new Date());
        assert.equal(good.state, STATE.LEARNING);
        const again = nextState(card, 1, new Date());
        assert.equal(again.state, STATE.RELEARNING);
        assert.equal(again.lapses, 1);
    });
});
