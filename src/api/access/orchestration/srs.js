/**
 * SRS.js
 * Spaced Repetition System service.
 */

import query from '../resources/query.js';
import db from '../primitives/database.js';
import { currentScope } from '../../requestContext.js';
import * as fsrs from './fsrs.js';

export const LEARNING_REVIEWS = 3;

/** The level at which a card counts as mastered, for the Flashcards sidebar's summary of its own box histogram. */
export const MASTERY_LEVEL = 5;

const DEFAULT_ALGORITHM = 'leitner';

const DEFAULT_REQUEST_RETENTION = 0.9;

function sm2Interval(reps, ef) {
    if (reps <= 1) return 1;
    if (reps === 2) return 6;
    return Math.min(365, Math.round(6 * Math.pow(ef, reps - 2)));
}

function leitnerInterval(level) {
    if (level <= 0) return 0;
    return Math.min(365, Math.pow(2, level - 1));
}

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

const DAY_MS = 86400000;

function intervalOfCard(card, algorithm, easeFactor = 2.5) {
    if (algorithm === 'fsrs') {
        return card.fsrs_stability != null
            ? fsrs.intervalFromStability(card.fsrs_stability, DEFAULT_REQUEST_RETENTION)
            : 0;
    }
    if (algorithm === 'sm2') return sm2Interval(card.sm2_reps ?? 0, easeFactor ?? 2.5);
    return leitnerInterval(card.level ?? 0);
}

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
    /** Whose schedule this call is about. */
    _scope(explicit) {
        return explicit ?? currentScope();
    }

    /** The scheduler this vault is actually being reviewed with. */
    async detectAlgorithm(scope) {
        const last = await query.getLatestReviewAlgorithm(this._scope(scope));
        if (!last) return DEFAULT_ALGORITHM;
        if (last.algorithm) return last.algorithm;
        return last.rating != null ? 'fsrs' : DEFAULT_ALGORITHM;
    }

    /** This person's FSRS weight vector, falling back to the defaults. */
    async getWeights(scope) {
        return (await query.getFsrsWeights(this._scope(scope)))?.weights ?? fsrs.DEFAULT_WEIGHTS;
    }

    async _applyFsrs(cardId, rating, timestamp, requestRetention = 0.9, ordering = {}, scope) {
        const current = await query.getFlashcardFsrsState(cardId, scope);
        const next = fsrs.nextState(current, rating, new Date(timestamp), await this.getWeights(scope), requestRetention);
        next.level = intervalToLeitnerLevel(next.interval);
        await query.updateFlashcardFsrs(cardId, next, scope);
        await query.insertReviewLog({
            flashcardId: cardId,
            accountId: scope,
            timestamp,
            outcome: rating > 1 ? 1 : 0,
            easeFactor: null,
            level: next.level,
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

    /** Grades a card, writing the schedule and, for the owner, the sidecar. */
    async submitReview(flashcardHash, outcome, easeFactor, newLevel, algorithm = 'leitner', opts = {}) {
        const timestamp = new Date().toISOString();
        const ordering = opts.ordering ?? {};
        const scope = this._scope(opts.scope);

        return await db.transaction(async () => {
            const fc = await query.getFlashcardByHash(flashcardHash);
            if (!fc) throw new Error(`Flashcard ${flashcardHash} not found.`);

            if (algorithm === 'fsrs') {
                const next = await this._applyFsrs(
                    fc.id, opts.rating, timestamp, opts.requestRetention, ordering, scope,
                );
                return { documentId: fc.document_id, fsrs: next, scope };
            }

            await query.updateFlashcardReview(fc.id, timestamp, newLevel, algorithm, scope);
            await query.insertReviewLog({
                flashcardId: fc.id,
                accountId: scope,
                timestamp,
                outcome,
                easeFactor,
                level: newLevel,
                algorithm,
                ...ordering,
            });
            return { documentId: fc.document_id, fsrs: null, scope };
        })();
    }

    /** Reverts the caller's last grade on a card. */
    async undoReview(flashcardHash, algorithm = 'leitner', scopeArg) {
        const scope = this._scope(scopeArg);
        return await db.transaction(async () => {
            const fc = await query.getFlashcardByHash(flashcardHash);
            if (!fc) throw new Error(`Flashcard ${flashcardHash} not found.`);

            const removed = await query.deleteLatestReviewLog(fc.id, scope);
            if (!removed) return { document_id: fc.document_id, restored: null, scope };

            const prev = await query.getLatestReviewLog(fc.id, scope);

            if (algorithm === 'fsrs') {
                const cur = await query.getFlashcardFsrsState(fc.id, scope);
                const reps = Math.max(0, (cur?.reps ?? 1) - 1);
                const restored = prev ? {
                    stability: prev.fsrs_stability,
                    difficulty: prev.fsrs_difficulty,
                    due: prev.fsrs_due,
                    state: prev.fsrs_state,
                    reps,
                    lapses: cur?.lapses ?? 0,
                    level: prev.level ?? 0,
                    lastRecall: prev.timestamp,
                } : null;
                await query.updateFlashcardFsrs(fc.id, restored
                    ? { ...restored, last_review: restored.lastRecall }
                    : { stability: null, difficulty: null, due: null, state: 0, reps: 0, lapses: 0, level: 0, last_review: null },
                    scope);
                return { document_id: fc.document_id, restored, scope };
            }

            const restored = {
                value: prev ? prev.level : 0,
                easeFactor: prev ? prev.ease_factor : 2.5,
                lastRecall: prev ? prev.timestamp : null,
            };
            await query.undoFlashcardReview(fc.id, restored.value, restored.lastRecall, algorithm, scope);
            return { document_id: fc.document_id, restored, scope };
        })();
    }

    /** This person's Leitner box distribution and mastery summary. */
    async getLeitnerStats(scopeArg) {
        const scope = this._scope(scopeArg);
        const boxes = await query.getLeitnerBoxes(scope);
        const total = await query.getFlashcardCount();
        const mastered = await query.getMasteredFlashcardCount(MASTERY_LEVEL, scope);

        return {
            boxes,
            total,
            mastered,
            masteryLevel: MASTERY_LEVEL,
            masteryPercentage: total > 0 ? (mastered / total) * 100 : 0,
        };
    }

    /** Fits FSRS weights to this person's own rated history. */
    async optimizeParameters(scopeArg) {
        const scope = this._scope(scopeArg);
        const histories = await query.getAllReviewHistories(scope);
        const result = fsrs.optimize(histories);
        if (result.optimized) {
            await query.setFsrsWeights(JSON.stringify(result.weights), result.reviewCount, scope);
        }
        return result;
    }

    /** This person's fitted weights and what they were fitted from. */
    async getFsrsInfo(scopeArg) {
        const scope = this._scope(scopeArg);
        const stored = await query.getFsrsWeights(scope);
        return {
            optimized: !!stored?.optimizedAt,
            optimizedAt: stored?.optimizedAt ?? null,
            weightReviewCount: stored?.reviewCount ?? null,
            reviewCount: (await query.getAllReviewHistories(scope)).length,
            minReviews: fsrs.MIN_OPTIMIZE_REVIEWS,
        };
    }

    /** This person's review analytics over the whole vault. */
    async getStatistics({ algorithm: requested = null, scope: scopeArg = null } = {}) {
        const scope = this._scope(scopeArg);
        const algorithm = requested ?? await this.detectAlgorithm(scope);
        const DAY = 86400000;
        const MATURE_DAYS = 21;
        const FORECAST_DAYS = 14;

        const cards = await query.getAllFlashcardSrsState(scope);
        const efMap = algorithm === 'sm2' ? await query.getLatestEaseFactors(scope) : null;

        const efOf = (c) => efMap?.get(c.global_hash) ?? 2.5;
        const intervalOf = (c) => intervalOfCard(c, algorithm, efOf(c));
        const isReviewed = (c) => isReviewedCard(c, algorithm);
        const dueDateOf = (c) => dueDateOfCard(c, algorithm, efOf(c));

        const now = new Date();
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
        const allTotals = await query.getReviewTotals(null, scope);
        const activity = await query.getReviewActivity(since365, scope);
        const retention = (t) => (t && t.total > 0 ? t.correct / t.total : null);

        const phaseAll = await query.getReviewTotalsByPhase(LEARNING_REVIEWS, null, scope);
        const phase30 = await query.getReviewTotalsByPhase(LEARNING_REVIEWS, since30, scope);
        const firstAll = await query.getFirstExposureTotals(null, scope);
        const first30 = await query.getFirstExposureTotals(since30, scope);

        const attempts = (await query.getReviewsToFirstRecall(scope)).map(r => r.attempts).sort((a, b) => a - b);
        const median = attempts.length === 0 ? null
            : attempts.length % 2
                ? attempts[(attempts.length - 1) / 2]
                : (attempts[attempts.length / 2 - 1] + attempts[attempts.length / 2]) / 2;
        const reviewsToRecall = {
            avg: attempts.length ? attempts.reduce((a, b) => a + b, 0) / attempts.length : null,
            median,
            cards: attempts.length,
        };

        const daySet = new Set(activity.filter(a => a.total > 0).map(a => a.day));
        let current = 0;
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

    /** Everything the card detail view shows about ONE card: its current schedule, its full review ledger, and a retention curve. */
    async getCardInsights(hash, { algorithm: requested = null, scope: scopeArg = null } = {}) {
        const scope = this._scope(scopeArg);
        const algorithm = requested ?? await this.detectAlgorithm(scope);
        const state = await query.getFlashcardSrsStateByHash(hash, scope);
        if (!state) throw new Error(`Card not found: ${hash}`);

        const easeFactor = state.ease_factor != null && state.ease_factor >= 1.3
            ? state.ease_factor : 2.5;

        const history = (await query.getFlashcardReviewHistory(state.id, scope)).map(r => ({
            id: r.id,
            at: r.timestamp,
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
            curve: await this._buildCurve(state, algorithm, easeFactor, reviewed, intervalDays, dueAt, scope),
        };
    }

    /** Samples the card's predicted retention from its last review out past its due date. */
    async _buildCurve(state, algorithm, easeFactor, reviewed, intervalDays, dueAt, scope) {
        if (!reviewed) return null;

        const originAt = state.last_recall
            ?? (dueAt ? new Date(dueAt.getTime() - intervalDays * DAY_MS).toISOString() : null);
        if (!originAt) return null;

        const stabilityDays = algorithm === 'fsrs'
            ? state.fsrs_stability
            : Math.max(intervalDays, 1);
        if (!(stabilityDays > 0)) return null;

        const weights = await this.getWeights(scope);
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

    /** Translates this person's progress between scheduling algorithms. */
    async migrateProgress(from, to, scopeArg) {
        const scope = this._scope(scopeArg);
        if (from === to) return 0;

        const cards = await query.getAllFlashcardSrsState(scope);
        if (cards.length === 0) return 0;

        if (from === 'leitner' && to === 'sm2') {
            const translated = cards.map(c => ({
                global_hash: c.global_hash,
                sm2_reps: leitnerToSm2Reps(c.level ?? 0),
            }));
            await query.batchSetSm2Reps(translated, scope);
            return translated.length;
        }

        if (from === 'sm2' && to === 'leitner') {
            const efMap = await query.getLatestEaseFactors(scope);
            const translated = cards.map(c => ({
                global_hash: c.global_hash,
                level: sm2RepsToLeitnerLevel(c.sm2_reps ?? 0, efMap.get(c.global_hash) ?? 2.5),
            }));
            await query.batchSetLeitnerLevel(translated, scope);
            return translated.length;
        }

        if (to === 'fsrs') {
            const efMap = from === 'sm2' ? await query.getLatestEaseFactors(scope) : null;
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
                    fsrsState: reviewed ? 2 : 0,
                    fsrsReps: reviewed ? 1 : 0,
                    fsrsLapses: 0,
                    level: reviewed ? intervalToLeitnerLevel(interval) : 0,
                    lastRecall: c.last_recall ?? null,
                };
            });
            await query.batchSetFsrsState(seeded, scope);
            return seeded.length;
        }

        if (from === 'fsrs') {
            const toInterval = (c) => (c.fsrs_stability != null
                ? fsrs.intervalFromStability(c.fsrs_stability, 0.9)
                : 0);
            if (to === 'leitner') {
                const translated = cards.map(c => ({
                    global_hash: c.global_hash,
                    level: intervalToLeitnerLevel(toInterval(c)),
                }));
                await query.batchSetLeitnerLevel(translated, scope);
                return translated.length;
            }
            if (to === 'sm2') {
                const translated = cards.map(c => ({
                    global_hash: c.global_hash,
                    sm2_reps: intervalToSm2Reps(toInterval(c)),
                }));
                await query.batchSetSm2Reps(translated, scope);
                return translated.length;
            }
        }

        return 0;
    }

    /** Which cards are due for this person, from due dates alone; ordering happens elsewhere. */
    async getDue({
        algorithm: requested = null, folder = null, document = null, deck = null, tags = null,
        maxNew = 20, minPriority = 0, readGate = null,
        excludeFolders = null, excludeDocuments = null, excludeDecks = null, excludeTags = null,
        scope: scopeArg = null,
    } = {}) {
        const scope = this._scope(scopeArg);
        const algorithm = requested ?? await this.detectAlgorithm(scope);
        const result = await query.getDueFlashcards({
            algorithm, folder, document, deck, tags, maxNew, minPriority,
            readDocuments: readGate?.documents ?? null,
            readExcludeCards: readGate?.excludeCards ?? null,
            excludeFolders, excludeDocuments, excludeDecks, excludeTags,
        }, scope);
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
