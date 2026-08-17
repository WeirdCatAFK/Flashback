/**
 * SRS.js
 * Spaced Repetition System service.
 */

import query from '../resources/query.js';
import db from '../primitives/database.js';
import * as fsrs from './fsrs.js';

// A card's first N reviews are its acquisition phase — new material normally takes
// a few attempts before it holds, and folding those attempts into retention makes
// the headline number track how many new cards you added rather than how well the
// schedule is working. Reviews past this count are the only ones true retention is
// measured on; the acquisition phase gets its own measures. Shared with diary.js.
export const LEARNING_REVIEWS = 3;

// Last-resort scheduler when the vault has no review history to infer one from
// (see SRSService.detectAlgorithm). Not a claim about the user's preference —
// just the arithmetic the read-only views fall back to on an empty vault.
const DEFAULT_ALGORITHM = 'leitner';

// The retention a scheduled review is aimed at. FSRS targets it explicitly; Leitner
// and SM-2 only assert "revisit at interval I", which is the same claim read the other
// way round — I is where recall has decayed to about this. migrateProgress already
// seeds FSRS stability from an interval on exactly that basis.
const DEFAULT_REQUEST_RETENTION = 0.9;

// Interval helpers (mirror the SQL expressions in getDueFlashcards).
function sm2Interval(reps, ef) {
    if (reps <= 1) return 1;
    if (reps === 2) return 6;
    return Math.min(365, Math.round(6 * Math.pow(ef, reps - 2)));
}

function leitnerInterval(level) {
    if (level <= 0) return 0;
    return Math.min(365, Math.pow(2, level - 1));
}

// Find the SM-2 rep count whose interval is closest to the given target (days).
function leitnerToSm2Reps(level) {
    const target = leitnerInterval(level);
    if (target === 0) return 0;
    let best = 0, bestDiff = Infinity;
    for (let r = 0; r <= 25; r++) {
        const diff = Math.abs(target - sm2Interval(r, 2.5));
        if (diff < bestDiff) { best = r; bestDiff = diff; }
        if (sm2Interval(r, 2.5) > target * 4) break;
    }
    return best;
}

// Find the Leitner level whose interval is closest to the given SM-2 schedule.
function sm2RepsToLeitnerLevel(reps, ef) {
    const target = sm2Interval(reps, ef);
    let best = 0, bestDiff = Infinity;
    for (let l = 0; l <= 25; l++) {
        const diff = Math.abs(target - leitnerInterval(l));
        if (diff < bestDiff) { best = l; bestDiff = diff; }
        if (leitnerInterval(l) > target * 4) break;
    }
    return best;
}

// Interval (days) → closest Leitner level / SM-2 rep count. Used when migrating
// FSRS state (which carries an explicit interval via stability) back to a scalar.
function intervalToLeitnerLevel(interval) {
    let best = 0, bestDiff = Infinity;
    for (let l = 0; l <= 25; l++) {
        const diff = Math.abs(interval - leitnerInterval(l));
        if (diff < bestDiff) { best = l; bestDiff = diff; }
        if (leitnerInterval(l) > interval * 4) break;
    }
    return best;
}
function intervalToSm2Reps(interval) {
    let best = 0, bestDiff = Infinity;
    for (let r = 0; r <= 25; r++) {
        const diff = Math.abs(interval - sm2Interval(r, 2.5));
        if (diff < bestDiff) { best = r; bestDiff = diff; }
        if (sm2Interval(r, 2.5) > interval * 4) break;
    }
    return best;
}

// --- Per-card schedule reads -------------------------------------------------
// These three describe where a card sits under a given algorithm. They live at
// module scope because both getStatistics (vault-wide) and getCardInsights (one
// card) need them; the arithmetic itself already exists once more as SQL in
// query.getDueFlashcards, and a third copy is exactly what we're avoiding.

const DAY_MS = 86400000;

// Scheduled interval in days. `easeFactor` is only read for SM-2.
function intervalOfCard(card, algorithm, easeFactor = 2.5) {
    if (algorithm === 'fsrs') {
        return card.fsrs_stability != null
            ? fsrs.intervalFromStability(card.fsrs_stability, DEFAULT_REQUEST_RETENTION)
            : 0;
    }
    if (algorithm === 'sm2') return sm2Interval(card.sm2_reps ?? 0, easeFactor ?? 2.5);
    return leitnerInterval(card.level ?? 0);
}

// Has this card left the "new" pile under this algorithm?
function isReviewedCard(card, algorithm) {
    return algorithm === 'fsrs'
        ? (card.fsrs_state ?? 0) !== 0 && card.fsrs_stability != null
        : !!card.last_recall;
}

function dueDateOfCard(card, algorithm, easeFactor = 2.5) {
    if (algorithm === 'fsrs') return card.fsrs_due ? new Date(card.fsrs_due) : null;
    if (!card.last_recall) return null;
    return new Date(new Date(card.last_recall).getTime()
        + intervalOfCard(card, algorithm, easeFactor) * DAY_MS);
}

class SRSService {
    /**
     * The scheduler this vault is actually being reviewed with.
     *
     * The active algorithm is a browser preference (`fb-srs-algorithm` in localStorage),
     * so callers that have a browser send it explicitly. Callers that don't — the MCP
     * server, scripts, any direct API consumer — used to fall through to a hardcoded
     * 'leitner', which was then echoed back in the response's `algorithm` field as
     * though the server knew it. It didn't, and it was wrong for every FSRS user.
     *
     * The vault does record the truth: since migration 006 each ReviewLog carries the
     * algorithm it was graded with. Older rows don't, but FSRS is still identifiable
     * there because it's the only scheduler that writes a 1–4 `rating` (Leitner and
     * SM-2 both post an ease_factor, so those two are genuinely indistinguishable on
     * pre-006 rows and we say 'leitner').
     *
     * A vault with no reviews yet has no answer to give; DEFAULT_ALGORITHM stands in.
     */
    async detectAlgorithm() {
        const last = await query.getLatestReviewAlgorithm();
        if (!last) return DEFAULT_ALGORITHM;
        if (last.algorithm) return last.algorithm;
        return last.rating != null ? 'fsrs' : DEFAULT_ALGORITHM;
    }

    // The vault's active FSRS weight vector, falling back to published defaults
    // until the optimizer has run (Phase B seeds FsrsParameters).
    async getWeights() {
        return (await query.getFsrsWeights())?.weights ?? fsrs.DEFAULT_WEIGHTS;
    }

    // Compute + persist one FSRS review. Returns the new FSRS state so callers
    // (documents.js) can mirror it into the sidecar. Must run inside a transaction.
    async _applyFsrs(cardId, rating, timestamp, requestRetention = 0.9, ordering = {}) {
        const current = await query.getFlashcardFsrsState(cardId);
        const next = fsrs.nextState(current, rating, new Date(timestamp), await this.getWeights(), requestRetention);
        // Keep the app-wide `level` scalar in step with FSRS strength: map the new
        // interval to the nearest Leitner box so LevelDot, the box histogram, and
        // mastery counts stay meaningful regardless of the active algorithm.
        next.level = intervalToLeitnerLevel(next.interval);
        await query.updateFlashcardFsrs(cardId, next);
        await query.insertReviewLog({
            flashcardId: cardId,
            timestamp,
            outcome: rating > 1 ? 1 : 0,   // keep the binary flag for legacy stats
            easeFactor: null,
            level: next.level,             // snapshot so undo can restore the level too
            algorithm: 'fsrs',
            rating,
            fsrsStability: next.stability,
            fsrsDifficulty: next.difficulty,
            fsrsDue: next.due,
            fsrsState: next.state,
            ...ordering,
        });
        return next;
    }

    // Returns { documentId, fsrs } — fsrs is the computed state for FSRS reviews,
    // null for Leitner/SM-2. opts carries { rating, requestRetention } for FSRS, plus an
    // optional `ordering` ({ sessionId, sessionPosition, prevDistance, nearestSiblingLag })
    // describing how the card was PRESENTED. That is composed at the route layer by
    // sequencer.measureOrdering and arrives here as plain numbers — this module stays
    // ignorant of the graph, exactly as it stays ignorant of the card-health classifier.
    // Absent for every non-trainer caller, and stored as NULL rather than 0 (see
    // migrations/009_session_ordering.js).
    async submitReview(flashcardHash, outcome, easeFactor, newLevel, algorithm = 'leitner', opts = {}) {
        const timestamp = new Date().toISOString();
        const ordering = opts.ordering ?? {};

        return await db.transaction(async () => {
            const fc = await query.getFlashcardByHash(flashcardHash);
            if (!fc) throw new Error(`Flashcard ${flashcardHash} not found.`);

            if (algorithm === 'fsrs') {
                const next = await this._applyFsrs(
                    fc.id, opts.rating, timestamp, opts.requestRetention, ordering,
                );
                return { documentId: fc.document_id, fsrs: next };
            }

            await query.updateFlashcardReview(fc.id, timestamp, newLevel, algorithm);
            await query.insertReviewLog({
                flashcardId: fc.id,
                timestamp,
                outcome,
                easeFactor,
                level: newLevel,
                algorithm,
                ...ordering,
            });

            return { documentId: fc.document_id, fsrs: null };
        })();
    }

    // Reverse a card's most recent review (a misgraded result). Removes the last
    // ReviewLog and restores the card's SRS progress to the review before it — or
    // to a never-reviewed state when no reviews remain. Returns the document id
    // and the restored state ({ value, easeFactor, lastRecall }) so the caller can
    // mirror it into the sidecar; `restored` is null when there was nothing to undo.
    async undoReview(flashcardHash, algorithm = 'leitner') {
        return await db.transaction(async () => {
            const fc = await query.getFlashcardByHash(flashcardHash);
            if (!fc) throw new Error(`Flashcard ${flashcardHash} not found.`);

            const removed = await query.deleteLatestReviewLog(fc.id);
            if (!removed) return { document_id: fc.document_id, restored: null };

            const prev = await query.getLatestReviewLog(fc.id);

            if (algorithm === 'fsrs') {
                // Restore the FSRS state snapshotted on the now-latest log; if none
                // remain the card reverts to new. reps/lapses aren't snapshotted per
                // log, so reps is decremented best-effort (they don't affect scheduling).
                const cur = await query.getFlashcardFsrsState(fc.id);
                const reps = Math.max(0, (cur?.reps ?? 1) - 1);
                const restored = prev ? {
                    stability: prev.fsrs_stability,
                    difficulty: prev.fsrs_difficulty,
                    due: prev.fsrs_due,
                    state: prev.fsrs_state,
                    reps,
                    lapses: cur?.lapses ?? 0,
                    level: prev.level ?? 0,   // restore the display-strength scalar too
                    lastRecall: prev.timestamp,
                } : null;
                await query.updateFlashcardFsrs(fc.id, restored
                    ? { ...restored, last_review: restored.lastRecall }
                    : { stability: null, difficulty: null, due: null, state: 0, reps: 0, lapses: 0, level: 0, last_review: null });
                return { document_id: fc.document_id, restored };
            }

            const restored = {
                value: prev ? prev.level : 0,
                easeFactor: prev ? prev.ease_factor : 2.5,
                lastRecall: prev ? prev.timestamp : null,
            };
            await query.undoFlashcardReview(fc.id, restored.value, restored.lastRecall, algorithm);

            return { document_id: fc.document_id, restored };
        })();
    }

    async getLeitnerStats() {
        const boxes = await query.getLeitnerBoxes();
        const total = await query.getFlashcardCount();
        const mastered = await query.getMasteredFlashcardCount(5);

        return {
            boxes,
            totalCards: total,
            masteryPercentage: total > 0 ? (mastered / total) * 100 : 0
        };
    }

    // Fit the vault's FSRS weights from its own rated review history and persist
    // them (only when there is enough data). Returns the optimizer report so the
    // caller can show before/after loss and review counts. requestRetention does
    // not affect the fit (the loss depends only on stability/difficulty), so it is
    // accepted for API symmetry but ignored by the math.
    async optimizeParameters() {
        const histories = await query.getAllReviewHistories();
        const result = fsrs.optimize(histories);
        if (result.optimized) {
            await query.setFsrsWeights(JSON.stringify(result.weights), result.reviewCount);
        }
        return result;
    }

    // Optimizer status for the Config panel: how many rated reviews exist, whether
    // the weights have been fitted, and when. optimizedAt === null ⇒ still on the
    // published defaults.
    async getFsrsInfo() {
        const stored = await query.getFsrsWeights();
        return {
            optimized: !!stored?.optimizedAt,
            optimizedAt: stored?.optimizedAt ?? null,
            weightReviewCount: stored?.reviewCount ?? null,
            reviewCount: (await query.getAllReviewHistories()).length,
            minReviews: fsrs.MIN_OPTIMIZE_REVIEWS,
        };
    }

    // Vault-wide analytics for the Stats view. Algorithm-aware because a card's
    // interval/maturity/next-due are derived differently per scheduler; the active
    // algorithm is passed from the client (like getDue), and inferred from review
    // history when the caller has no browser to read it from. All read-only.
    //
    // Returns { algorithm, totals, acquisition, maturity, forecast, overdue, activity,
    // streak }. `totals.retention*` covers the review phase only; `acquisition` reports
    // the learning phase separately (see LEARNING_REVIEWS). The returned `algorithm` is
    // the one actually used, so an MCP client can trust what it reads back.
    async getStatistics({ algorithm: requested = null } = {}) {
        const algorithm = requested ?? await this.detectAlgorithm();
        const DAY = 86400000;
        const MATURE_DAYS = 21;      // Anki's convention: interval ≥ 21d ⇒ "mature"
        const FORECAST_DAYS = 14;

        const cards = await query.getAllFlashcardSrsState();
        const efMap = algorithm === 'sm2' ? await query.getLatestEaseFactors() : null;

        // Scheduled interval / due date for a card under the active algorithm
        // (shared with getCardInsights — see the module-scope helpers).
        const efOf = (c) => efMap?.get(c.global_hash) ?? 2.5;
        const intervalOf = (c) => intervalOfCard(c, algorithm, efOf(c));
        const isReviewed = (c) => isReviewedCard(c, algorithm);
        const dueDateOf = (c) => dueDateOfCard(c, algorithm, efOf(c));

        const now = new Date();
        // Day keys are the user's LOCAL calendar days, matching SQLite's
        // date(timestamp, 'localtime') in query.js — a session at 21:00 belongs to the
        // day the user just spent, not to tomorrow in Greenwich. dayStr() is indexed in
        // whole days from today and builds each key from local calendar components
        // (rather than adding 86400000ms), so a DST shift can't duplicate or skip a day.
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const todayMs = startOfToday.getTime();
        const pad = (n) => String(n).padStart(2, '0');
        const dayStr = (offsetDays) => {
            const d = new Date(startOfToday.getFullYear(), startOfToday.getMonth(),
                startOfToday.getDate() + offsetDays);
            return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        };

        let neu = 0, young = 0, mature = 0, overdue = 0;
        const forecast = new Array(FORECAST_DAYS).fill(0);
        for (const c of cards) {
            if (!isReviewed(c)) { neu++; continue; }
            if (intervalOf(c) >= MATURE_DAYS) mature++; else young++;

            const due = dueDateOf(c);
            if (!due) continue;
            const offset = Math.floor((due.getTime() - todayMs) / DAY);
            if (offset < 0) overdue++;
            else if (offset < FORECAST_DAYS) forecast[offset]++;
        }

        const since30 = dayStr(-30);
        const since365 = dayStr(-364);
        const allTotals = await query.getReviewTotals();
        const activity = await query.getReviewActivity(since365);
        const retention = (t) => (t && t.total > 0 ? t.correct / t.total : null);

        // Retention is measured on the review phase only; the learning phase is
        // reported separately as acquisition (see LEARNING_REVIEWS).
        const phaseAll = await query.getReviewTotalsByPhase(LEARNING_REVIEWS);
        const phase30 = await query.getReviewTotalsByPhase(LEARNING_REVIEWS, since30);
        const firstAll = await query.getFirstExposureTotals();
        const first30 = await query.getFirstExposureTotals(since30);

        // Attempts each card needed before its first correct recall — the cost of
        // acquiring one card. Median alongside the mean because the distribution is
        // long-tailed (a handful of stubborn cards would otherwise dominate).
        const attempts = (await query.getReviewsToFirstRecall()).map(r => r.attempts).sort((a, b) => a - b);
        const median = attempts.length === 0 ? null
            : attempts.length % 2
                ? attempts[(attempts.length - 1) / 2]
                : (attempts[attempts.length / 2 - 1] + attempts[attempts.length / 2]) / 2;
        const reviewsToRecall = {
            avg: attempts.length ? attempts.reduce((a, b) => a + b, 0) / attempts.length : null,
            median,
            cards: attempts.length,
        };

        // Study streaks from the activity days (ordered ASC, local 'YYYY-MM-DD').
        const daySet = new Set(activity.filter(a => a.total > 0).map(a => a.day));
        let current = 0;
        // Walk backwards in whole days. A streak that ran up to yesterday still counts
        // today (the day isn't over), so start at -1 when today has no reviews yet.
        let cursor = daySet.has(dayStr(0)) ? 0 : -1;
        while (daySet.has(dayStr(cursor))) { current++; cursor -= 1; }
        let longest = 0, run = 0, prev = null;
        for (const a of activity) {
            if (a.total <= 0) continue;
            const ms = Date.parse(a.day);
            run = (prev !== null && ms - prev === DAY) ? run + 1 : 1;
            prev = ms;
            if (run > longest) longest = run;
        }

        return {
            algorithm,
            totals: {
                cards: cards.length,
                reviews: allTotals.total ?? 0,
                reviewsToday: activity.find(a => a.day === dayStr(0))?.total ?? 0,
                retentionAll: retention(phaseAll.review),
                retention30: retention(phase30.review),
                retentionReviews: phaseAll.review.total,
                daysStudied: daySet.size,
            },
            acquisition: {
                learningReviews: LEARNING_REVIEWS,
                retentionAll: retention(phaseAll.learning),
                retention30: retention(phase30.learning),
                reviews: phaseAll.learning.total,
                firstExposureAll: retention(firstAll),
                firstExposure30: retention(first30),
                firstExposureCards: firstAll.total,
                reviewsToRecall,
            },
            maturity: { new: neu, young, mature },
            forecast: forecast.map((due, i) => ({ date: dayStr(i), due })),
            overdue,
            activity,
            streak: { current, longest },
        };
    }

    /**
     * Everything the card detail view shows about ONE card: its current schedule,
     * its full review ledger, and a retention curve.
     *
     * `algorithm` follows the same contract as getStatistics/getDue — the caller
     * sends the browser's preference when it has one, we detect it otherwise, and
     * the value actually used is echoed back so a client without a browser can
     * trust what it reads.
     *
     * Returns { algorithm, srs, history, curve }; `curve` is null for a card that
     * has never been reviewed (there is no memory state to model yet).
     */
    async getCardInsights(hash, { algorithm: requested = null } = {}) {
        const algorithm = requested ?? await this.detectAlgorithm();
        const state = await query.getFlashcardSrsStateByHash(hash);
        if (!state) throw new Error(`Card not found: ${hash}`);

        // Same guard as the SQL: a missing or degenerate ease factor means 2.5.
        const easeFactor = state.ease_factor != null && state.ease_factor >= 1.3
            ? state.ease_factor : 2.5;

        const history = (await query.getFlashcardReviewHistory(state.id)).map(r => ({
            id: r.id,
            at: r.timestamp,
            // Pre-migration-006 rows carry no algorithm. FSRS is still identifiable
            // (it's the only scheduler that writes a rating), but Leitner and SM-2
            // are genuinely indistinguishable there — so we say null, not a guess.
            algorithm: r.algorithm ?? (r.rating != null ? 'fsrs' : null),
            outcome: r.outcome,
            rating: r.rating,
            easeFactor: r.ease_factor,
            level: r.level,
            stability: r.fsrs_stability,
            difficulty: r.fsrs_difficulty,
            due: r.fsrs_due,
            state: r.fsrs_state,
            synthetic: r.outcome === null,
        }));

        const real = history.filter(h => !h.synthetic);
        const correct = real.filter(h => h.outcome === 1).length;
        const reviewed = isReviewedCard(state, algorithm);
        const dueAt = dueDateOfCard(state, algorithm, easeFactor);
        const intervalDays = intervalOfCard(state, algorithm, easeFactor);
        const overdueMs = dueAt ? Date.now() - dueAt.getTime() : 0;

        return {
            algorithm,
            srs: {
                state: reviewed ? 'review' : 'new',
                level: state.level ?? 0,
                sm2Reps: state.sm2_reps ?? 0,
                easeFactor,
                lastRecall: state.last_recall ?? null,
                dueAt: dueAt ? dueAt.toISOString() : null,
                intervalDays,
                overdueDays: overdueMs > 0 ? overdueMs / DAY_MS : 0,
                fsrs: state.fsrs_stability != null ? {
                    stability: state.fsrs_stability,
                    difficulty: state.fsrs_difficulty,
                    state: state.fsrs_state ?? 0,
                    reps: state.fsrs_reps ?? 0,
                    lapses: state.fsrs_lapses ?? 0,
                } : null,
                reviews: real.length,
                correct,
                lapses: real.length - correct,
                retention: real.length ? correct / real.length : null,
                syntheticEntries: history.length - real.length,
            },
            history,
            curve: await this._buildCurve(state, algorithm, easeFactor, reviewed, intervalDays, dueAt),
        };
    }

    /**
     * Samples the card's predicted retention from its last review out past its due
     * date. Server-side so the client needs no scheduler knowledge — it receives
     * {t, r} points and draws them.
     *
     * Under FSRS this is honest: the same retrievability() that produced the card's
     * schedule, with the vault's own fitted weights. Leitner and SM-2 have no memory
     * model, so we draw their own premise instead — the scheduled interval is the
     * point where recall has fallen to DEFAULT_REQUEST_RETENTION, which is exactly
     * `stability := interval` (retrievability(I, I) ≡ 0.9). That's the same
     * equivalence migrateProgress uses to seed FSRS stability, so a card migrated
     * into FSRS keeps the curve it had. `model` tells the UI to say so.
     */
    async _buildCurve(state, algorithm, easeFactor, reviewed, intervalDays, dueAt) {
        if (!reviewed) return null;

        const originAt = state.last_recall
            ?? (dueAt ? new Date(dueAt.getTime() - intervalDays * DAY_MS).toISOString() : null);
        if (!originAt) return null;

        // A lapsed Leitner card sits in box 0 (interval 0) — floor stability at a day
        // rather than dividing by zero.
        const stabilityDays = algorithm === 'fsrs'
            ? state.fsrs_stability
            : Math.max(intervalDays, 1);
        if (!(stabilityDays > 0)) return null;

        const weights = await this.getWeights();
        const elapsedNow = Math.max(0, (Date.now() - new Date(originAt).getTime()) / DAY_MS);
        const horizonDays = Math.max(intervalDays * 2, elapsedNow * 1.15, 1);

        const SAMPLES = 64;
        const points = [];
        for (let i = 0; i < SAMPLES; i++) {
            const t = (horizonDays * i) / (SAMPLES - 1);
            points.push({
                t: Math.round(t * 1000) / 1000,
                r: Math.round(fsrs.retrievability(t, stabilityDays, weights) * 10000) / 10000,
            });
        }

        return {
            model: algorithm === 'fsrs' ? 'fsrs' : 'approximated',
            requestRetention: DEFAULT_REQUEST_RETENTION,
            stabilityDays,
            originAt,
            dueAt: dueAt ? dueAt.toISOString() : null,
            intervalDays,
            horizonDays,
            nowT: Math.round(elapsedNow * 1000) / 1000,
            nowR: Math.round(fsrs.retrievability(elapsedNow, stabilityDays, weights) * 10000) / 10000,
            points,
        };
    }

    async migrateProgress(from, to) {
        if (from === to) return 0;

        const cards = await query.getAllFlashcardSrsState();
        if (cards.length === 0) return 0;

        if (from === 'leitner' && to === 'sm2') {
            const translated = cards.map(c => ({
                global_hash: c.global_hash,
                sm2_reps: leitnerToSm2Reps(c.level ?? 0),
            }));
            await query.batchSetSm2Reps(translated);
            return translated.length;
        }

        if (from === 'sm2' && to === 'leitner') {
            const efMap = await query.getLatestEaseFactors();
            const translated = cards.map(c => ({
                global_hash: c.global_hash,
                level: sm2RepsToLeitnerLevel(c.sm2_reps ?? 0, efMap.get(c.global_hash) ?? 2.5),
            }));
            await query.batchSetLeitnerLevel(translated);
            return translated.length;
        }

        // Into FSRS: seed each card's stability from its current interval under the
        // previous algorithm (stability ≈ the interval that yields ~90% retention),
        // difficulty at a neutral default. Best-effort — the optimizer refines later.
        if (to === 'fsrs') {
            const efMap = from === 'sm2' ? await query.getLatestEaseFactors() : null;
            const seeded = cards.map(c => {
                const interval = from === 'sm2'
                    ? sm2Interval(c.sm2_reps ?? 0, efMap.get(c.global_hash) ?? 2.5)
                    : leitnerInterval(c.level ?? 0);
                const reviewed = interval > 0 && !!c.last_recall;
                const dueBase = c.last_recall ? new Date(c.last_recall) : new Date();
                return {
                    global_hash: c.global_hash,
                    fsrsStability: reviewed ? Math.max(0.01, interval) : null,
                    fsrsDifficulty: reviewed ? 5 : null,
                    fsrsDue: reviewed ? new Date(dueBase.getTime() + interval * 86400000).toISOString() : null,
                    fsrsState: reviewed ? 2 : 0,   // 2 = review
                    fsrsReps: reviewed ? 1 : 0,
                    fsrsLapses: 0,
                    level: reviewed ? intervalToLeitnerLevel(interval) : 0,
                    lastRecall: c.last_recall ?? null,
                };
            });
            await query.batchSetFsrsState(seeded);
            return seeded.length;
        }

        // Out of FSRS: convert stability → interval → the target scalar.
        if (from === 'fsrs') {
            const toInterval = (c) => (c.fsrs_stability != null
                ? fsrs.intervalFromStability(c.fsrs_stability, 0.9)
                : 0);
            if (to === 'leitner') {
                const translated = cards.map(c => ({
                    global_hash: c.global_hash,
                    level: intervalToLeitnerLevel(toInterval(c)),
                }));
                await query.batchSetLeitnerLevel(translated);
                return translated.length;
            }
            if (to === 'sm2') {
                const translated = cards.map(c => ({
                    global_hash: c.global_hash,
                    sm2_reps: intervalToSm2Reps(toInterval(c)),
                }));
                await query.batchSetSm2Reps(translated);
                return translated.length;
            }
        }

        return 0;
    }

    // `algorithm` decides how dueness is computed; when the caller can't supply it
    // (no browser, so no localStorage) it's inferred from review history rather than
    // assumed — see detectAlgorithm. The echoed `algorithm` is the one actually used.
    async getDue({ algorithm: requested = null, folder = null, deck = null, tags = null, maxNew = 20, minPriority = 0 } = {}) {
        const algorithm = requested ?? await this.detectAlgorithm();
        const result = await query.getDueFlashcards({ algorithm, folder, deck, tags, maxNew, minPriority });
        return {
            algorithm,
            due: result.due,
            new: result.newCards,
            counts: { due: result.due.length, new: result.newCards.length },
            nextDue: result.nextDue
        };
    }
}

export default new SRSService();
