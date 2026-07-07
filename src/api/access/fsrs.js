/**
 * fsrs.js
 * Hand-rolled FSRS-6 (Free Spaced Repetition Scheduler) memory model.
 *
 * Pure functions only — no database, no I/O, no side effects. `access/srs.js`
 * is the sole caller; it loads a card's stored FSRS state, calls `nextState()`
 * with the active weight vector + desired retention, and persists the result.
 *
 * FSRS models each card with two latent variables:
 *   - stability  (S): days until recall probability decays to ~90%
 *   - difficulty (D): intrinsic hardness, 1 (easy) .. 10 (hard)
 * plus 21 fitted weights w[0..20]. Grades are 1=Again, 2=Hard, 3=Good, 4=Easy.
 *
 * Reference: FSRS-6 spec (open-spaced-repetition). The equations are documented
 * inline next to each helper; tests/fsrs.test.js pins the numeric behaviour.
 */

// Published FSRS-6 default weights (w[0..20]). Used until a vault is optimized.
export const DEFAULT_WEIGHTS = [
    0.2172, 1.1771, 3.2602, 16.1507, 7.0114, 0.57, 2.0966, 0.0069,
    1.5261, 0.112, 1.0178, 1.849, 0.1133, 0.3127, 2.2934, 0.2191,
    3.0004, 0.7536, 0.3332, 0.1437, 0.2,
];

// Card lifecycle states (stored as integers in Flashcards.fsrs_state).
export const STATE = { NEW: 0, LEARNING: 1, REVIEW: 2, RELEARNING: 3 };

const STABILITY_MIN = 0.01;      // stability floor (days)
const DIFFICULTY_MIN = 1;
const DIFFICULTY_MAX = 10;
const INTERVAL_MAX = 36500;      // ~100 years
const DAY_MS = 86400000;

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// Decay is a free FSRS-6 parameter (w[20]); FACTOR falls out of it so that
// retrievability at t = interval equals exactly the requested retention.
function decayFactor(w) {
    const decay = -w[20];
    const factor = Math.pow(0.9, 1 / decay) - 1;
    return { decay, factor };
}

/**
 * Probability of recall after `elapsedDays` given stability `S`.
 * R(t,S) = (1 + FACTOR * t/S)^DECAY. R(0,S) = 1, monotonically decreasing.
 */
export function retrievability(elapsedDays, stability, weights = DEFAULT_WEIGHTS) {
    const { decay, factor } = decayFactor(weights);
    const t = Math.max(0, elapsedDays);
    return Math.pow(1 + factor * (t / stability), decay);
}

/**
 * Interval (whole days) that lets stability `S` decay to exactly
 * `requestRetention`. Inverse of retrievability(). Clamped to [1, INTERVAL_MAX].
 */
export function intervalFromStability(stability, requestRetention, weights = DEFAULT_WEIGHTS) {
    const { decay, factor } = decayFactor(weights);
    const raw = (stability / factor) * (Math.pow(requestRetention, 1 / decay) - 1);
    return clamp(Math.round(raw), 1, INTERVAL_MAX);
}

// Initial stability for a first-ever review at grade G: S0 = w[G-1].
function initialStability(grade, w) {
    return Math.max(STABILITY_MIN, w[grade - 1]);
}

// Initial difficulty: D0(G) = w[4] - exp(w[5]*(G-1)) + 1, clamped to [1,10].
function initialDifficulty(grade, w) {
    return clamp(w[4] - Math.exp(w[5] * (grade - 1)) + 1, DIFFICULTY_MIN, DIFFICULTY_MAX);
}

// Difficulty update with linear damping + mean reversion toward D0(Easy).
//   ΔD  = -w[6] * (G - 3)
//   D'  = D + ΔD * (10 - D) / 9        (linear damping: less change when hard)
//   D'' = w[7] * D0(4) + (1 - w[7]) * D'   (revert toward the "Easy" anchor)
function nextDifficulty(difficulty, grade, w) {
    const deltaD = -w[6] * (grade - 3);
    const damped = difficulty + deltaD * (10 - difficulty) / 9;
    const reverted = w[7] * initialDifficulty(4, w) + (1 - w[7]) * damped;
    return clamp(reverted, DIFFICULTY_MIN, DIFFICULTY_MAX);
}

// Stability after a successful recall (G >= 2) at retrievability R.
//   S' = S * (1 + exp(w8)*(11-D)*S^-w9 * (exp(w10*(1-R))-1) * hard * easy)
// hard penalty applies on "Hard" (G=2); easy bonus applies on "Easy" (G=4).
function recallStability(difficulty, stability, R, grade, w) {
    const hard = grade === 2 ? w[15] : 1;
    const easy = grade === 4 ? w[16] : 1;
    const inc =
        Math.exp(w[8]) *
        (11 - difficulty) *
        Math.pow(stability, -w[9]) *
        (Math.exp(w[10] * (1 - R)) - 1) *
        hard *
        easy;
    return Math.max(STABILITY_MIN, stability * (1 + inc));
}

// Stability after a lapse (G = 1) at retrievability R.
//   S'_f = w11 * D^-w12 * ((S+1)^w13 - 1) * exp(w14*(1-R))
// Guarded so post-lapse stability never exceeds the pre-lapse value.
function forgetStability(difficulty, stability, R, w) {
    const sf =
        w[11] *
        Math.pow(difficulty, -w[12]) *
        (Math.pow(stability + 1, w[13]) - 1) *
        Math.exp(w[14] * (1 - R));
    return clamp(sf, STABILITY_MIN, stability);
}

// Stability update for a same-day (short-term) review.
//   S' = S * exp(w17 * (G - 3 + w18)) * S^-w19
function shortTermStability(stability, grade, w) {
    const s = stability * Math.exp(w[17] * (grade - 3 + w[18])) * Math.pow(stability, -w[19]);
    return Math.max(STABILITY_MIN, s);
}

/**
 * State for a card seen for the very first time.
 * Returns the full FSRS record; `submitReview` persists it and derives `due`.
 */
export function initialCard(grade, now, weights = DEFAULT_WEIGHTS, requestRetention = 0.9) {
    const stability = initialStability(grade, weights);
    const difficulty = initialDifficulty(grade, weights);
    const interval = intervalFromStability(stability, requestRetention, weights);
    return {
        stability,
        difficulty,
        state: grade === 1 ? STATE.RELEARNING : STATE.REVIEW,
        reps: 1,
        lapses: grade === 1 ? 1 : 0,
        last_review: toISO(now),
        due: toISO(new Date(asDate(now).getTime() + interval * DAY_MS)),
        interval,
    };
}

/**
 * Advance a card's FSRS state by one review.
 *
 * @param {object} card  { stability, difficulty, state, reps, lapses, last_review }
 *                       — a never-reviewed card (state NEW / no stability) is
 *                       routed to initialCard().
 * @param {number} grade 1..4 (Again/Hard/Good/Easy)
 * @param {Date|string|number} now  review timestamp
 * @param {number[]} weights        21-element weight vector
 * @param {number} requestRetention desired retention (0..1)
 * @returns {object} new FSRS record including `due` (ISO) and `interval` (days)
 */
export function nextState(card, grade, now, weights = DEFAULT_WEIGHTS, requestRetention = 0.9) {
    const w = weights;
    if (!card || card.state === STATE.NEW || card.stability == null || !card.last_review) {
        return initialCard(grade, now, w, requestRetention);
    }

    const elapsedDays = (asDate(now).getTime() - asDate(card.last_review).getTime()) / DAY_MS;
    const R = retrievability(elapsedDays, card.stability, w);
    const difficulty = nextDifficulty(card.difficulty, grade, w);

    let stability;
    let state;
    let lapses = card.lapses ?? 0;

    if (elapsedDays < 1) {
        // Same-day repeat (learning steps) — short-term memory update.
        stability = shortTermStability(card.stability, grade, w);
        state = grade === 1 ? STATE.RELEARNING : STATE.LEARNING;
        if (grade === 1) lapses += 1;
    } else if (grade === 1) {
        stability = forgetStability(difficulty, card.stability, R, w);
        state = STATE.RELEARNING;
        lapses += 1;
    } else {
        stability = recallStability(difficulty, card.stability, R, grade, w);
        state = STATE.REVIEW;
    }

    const interval = intervalFromStability(stability, requestRetention, w);
    return {
        stability,
        difficulty,
        state,
        reps: (card.reps ?? 0) + 1,
        lapses,
        last_review: toISO(now),
        due: toISO(new Date(asDate(now).getTime() + interval * DAY_MS)),
        interval,
    };
}

// ── Per-vault optimizer ──────────────────────────────────────────────────────
//
// Fits the 21 weights to the vault's own review history by minimizing the binary
// cross-entropy between predicted recall (retrievability) and observed outcomes
// (rating > 1 = recalled). Pure and deterministic — `access/srs.js` loads the
// history via query and persists the result.

// Minimum rated reviews before fitting is worthwhile; below this we keep defaults.
export const MIN_OPTIMIZE_REVIEWS = 400;

// FSRS-6 parameter bounds. Each gradient step is clamped into these so the fitted
// weights stay in the physically meaningful range the model was designed for.
export const WEIGHT_BOUNDS = [
    [0.001, 100], [0.001, 100], [0.001, 100], [0.001, 100], // w0..w3  initial stability per grade
    [1, 10],      // w4  base difficulty
    [0.001, 4],   // w5  difficulty grade curve
    [0.001, 4],   // w6  difficulty delta
    [0.001, 0.75],// w7  difficulty mean-reversion
    [0, 4.5],     // w8  recall stability scale
    [0, 0.8],     // w9  recall stability stability-exponent
    [0.001, 3.5], // w10 recall stability retrievability term
    [0.001, 5],   // w11 forget stability scale
    [0.001, 0.25],// w12 forget stability difficulty-exponent
    [0.001, 0.9], // w13 forget stability stability-exponent
    [0, 4],       // w14 forget stability retrievability term
    [0, 1],       // w15 hard penalty
    [1, 6],       // w16 easy bonus
    [0, 2],       // w17 short-term scale
    [0, 2],       // w18 short-term offset
    [0, 0.8],     // w19 short-term stability-exponent
    [0.1, 0.8],   // w20 decay
];

const LOSS_EPS = 1e-6; // keep log() away from 0/1

// Group flat, (flashcard_id, id)-ordered rows into per-card grade sequences.
// Only cards with >= 2 reviews contribute: the first review establishes S0 and
// has no prior state to predict, so it carries no loss.
function groupHistories(histories) {
    const byCard = new Map();
    for (const r of histories) {
        if (r.rating == null) continue;
        let arr = byCard.get(r.flashcard_id);
        if (!arr) { arr = []; byCard.set(r.flashcard_id, arr); }
        arr.push({ t: asDate(r.timestamp).getTime(), grade: r.rating });
    }
    const seqs = [];
    for (const arr of byCard.values()) {
        if (arr.length >= 2) seqs.push(arr);
    }
    return seqs;
}

// Cap total work for very large vaults by keeping whole-card sequences until the
// review budget is spent (sequences are already grouped, so cards stay intact).
function capSeqs(seqs, maxReviews) {
    if (!maxReviews) return seqs;
    let total = 0;
    const out = [];
    for (const s of seqs) {
        if (total >= maxReviews) break;
        out.push(s);
        total += s.length;
    }
    return out;
}

// Mean binary cross-entropy of predicted vs. actual recall, replaying each card's
// state with `nextState`. The prediction at review i is retrievability(elapsed,
// S) where S is the stability *after* review i-1.
function bceLoss(seqs, weights) {
    let sum = 0;
    let n = 0;
    for (const seq of seqs) {
        let card = null;
        for (let i = 0; i < seq.length; i++) {
            const { t, grade } = seq[i];
            if (card) {
                const elapsed = (t - asDate(card.last_review).getTime()) / DAY_MS;
                const p = clamp(retrievability(elapsed, card.stability, weights), LOSS_EPS, 1 - LOSS_EPS);
                const y = grade > 1 ? 1 : 0;
                sum += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
                n += 1;
            }
            card = nextState(card, grade, new Date(t), weights);
        }
    }
    return n > 0 ? sum / n : 0;
}

// Central-difference numerical gradient of the loss w.r.t. each weight. Step size
// scales with the weight's magnitude so tiny and large params both move sensibly.
function numericalGradient(seqs, w) {
    const grad = new Array(w.length).fill(0);
    for (let i = 0; i < w.length; i++) {
        const [lo, hi] = WEIGHT_BOUNDS[i];
        const h = Math.max(1e-5, Math.abs(w[i]) * 1e-3);
        const wp = w.slice(); wp[i] = clamp(w[i] + h, lo, hi);
        const wm = w.slice(); wm[i] = clamp(w[i] - h, lo, hi);
        const denom = wp[i] - wm[i];
        grad[i] = denom === 0 ? 0 : (bceLoss(seqs, wp) - bceLoss(seqs, wm)) / denom;
    }
    return grad;
}

/**
 * Fit the 21 weights from a vault's rated review history.
 *
 * @param {Array<{flashcard_id:number, timestamp:string, rating:number}>} histories
 *        rows ordered by (flashcard_id, id) — i.e. query.getAllReviewHistories()
 * @param {object} [opts] iterations / learningRate / minReviews / maxReviews overrides
 * @returns {object} { optimized, weights, loss, initialLoss, reviewCount,
 *                     usableReviews, minReviews, reason? }
 *          `weights`/`loss` describe the best vector found; when there is too
 *          little data `optimized` is false and defaults are returned unchanged.
 */
export function optimize(histories, opts = {}) {
    const {
        minReviews = MIN_OPTIMIZE_REVIEWS,
        // Fitting is O(reviews × iterations) and runs synchronously in the API
        // process, so cap the training set to a representative slice — a few
        // thousand reviews already pin the 21 weights, and this keeps the button
        // responsive (~seconds) even for very large vaults.
        maxReviews = 5000,
        iterations = 60,
        learningRate = 0.04,
        patience = 8,
    } = opts;

    const reviewCount = histories.length;
    const seqs = capSeqs(groupHistories(histories), maxReviews);
    const usableReviews = seqs.reduce((a, s) => a + (s.length - 1), 0);
    const baseline = bceLoss(seqs, DEFAULT_WEIGHTS);

    if (reviewCount < minReviews || usableReviews < 1) {
        return {
            optimized: false,
            reason: 'insufficient-data',
            weights: DEFAULT_WEIGHTS.slice(),
            loss: baseline,
            initialLoss: baseline,
            reviewCount,
            usableReviews,
            minReviews,
        };
    }

    const w = DEFAULT_WEIGHTS.slice();
    // Adam keeps a sane step size per parameter despite the weights spanning
    // three orders of magnitude (w[7] ≈ 0.007 vs w[3] ≈ 16).
    const m = new Array(w.length).fill(0);
    const v = new Array(w.length).fill(0);
    const beta1 = 0.9, beta2 = 0.999, eps = 1e-8;

    let best = w.slice();
    let bestLoss = baseline;
    let sinceImprove = 0;

    for (let it = 1; it <= iterations; it++) {
        const grad = numericalGradient(seqs, w);
        for (let i = 0; i < w.length; i++) {
            m[i] = beta1 * m[i] + (1 - beta1) * grad[i];
            v[i] = beta2 * v[i] + (1 - beta2) * grad[i] * grad[i];
            const mHat = m[i] / (1 - Math.pow(beta1, it));
            const vHat = v[i] / (1 - Math.pow(beta2, it));
            const [lo, hi] = WEIGHT_BOUNDS[i];
            w[i] = clamp(w[i] - learningRate * mHat / (Math.sqrt(vHat) + eps), lo, hi);
        }
        const loss = bceLoss(seqs, w);
        if (loss < bestLoss - 1e-6) {
            bestLoss = loss;
            best = w.slice();
            sinceImprove = 0;
        } else if (++sinceImprove >= patience) {
            break;
        }
    }

    return {
        optimized: true,
        weights: best,
        loss: bestLoss,
        initialLoss: baseline,
        reviewCount,
        usableReviews,
        minReviews,
    };
}

// ── date coercion helpers ────────────────────────────────────────────────────
function asDate(v) {
    return v instanceof Date ? v : new Date(v);
}
function toISO(v) {
    return asDate(v).toISOString();
}
