/**
 * SRS.js
 * Spaced Repetition System service.
 */

import query from './query.js';
import db from './database.js';
import * as fsrs from './fsrs.js';

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

class SRSService {
    // The vault's active FSRS weight vector, falling back to published defaults
    // until the optimizer has run (Phase B seeds FsrsParameters).
    getWeights() {
        return query.getFsrsWeights()?.weights ?? fsrs.DEFAULT_WEIGHTS;
    }

    // Compute + persist one FSRS review. Returns the new FSRS state so callers
    // (documents.js) can mirror it into the sidecar. Must run inside a transaction.
    _applyFsrs(cardId, rating, timestamp, requestRetention = 0.9) {
        const current = query.getFlashcardFsrsState(cardId);
        const next = fsrs.nextState(current, rating, new Date(timestamp), this.getWeights(), requestRetention);
        query.updateFlashcardFsrs(cardId, next);
        query.insertReviewLog({
            flashcardId: cardId,
            timestamp,
            outcome: rating > 1 ? 1 : 0,   // keep the binary flag for legacy stats
            easeFactor: null,
            level: null,
            rating,
            fsrsStability: next.stability,
            fsrsDifficulty: next.difficulty,
            fsrsDue: next.due,
            fsrsState: next.state,
        });
        return next;
    }

    // Returns { documentId, fsrs } — fsrs is the computed state for FSRS reviews,
    // null for Leitner/SM-2. opts carries { rating, requestRetention } for FSRS.
    submitReview(flashcardHash, outcome, easeFactor, newLevel, algorithm = 'leitner', opts = {}) {
        const timestamp = new Date().toISOString();

        return db.transaction(() => {
            const fc = query.getFlashcardByHash(flashcardHash);
            if (!fc) throw new Error(`Flashcard ${flashcardHash} not found.`);

            if (algorithm === 'fsrs') {
                const next = this._applyFsrs(fc.id, opts.rating, timestamp, opts.requestRetention);
                return { documentId: fc.document_id, fsrs: next };
            }

            query.updateFlashcardReview(fc.id, timestamp, newLevel, algorithm);
            query.insertReviewLog({
                flashcardId: fc.id,
                timestamp,
                outcome,
                easeFactor,
                level: newLevel
            });

            return { documentId: fc.document_id, fsrs: null };
        })();
    }

    // Reverse a card's most recent review (a misgraded result). Removes the last
    // ReviewLog and restores the card's SRS progress to the review before it — or
    // to a never-reviewed state when no reviews remain. Returns the document id
    // and the restored state ({ value, easeFactor, lastRecall }) so the caller can
    // mirror it into the sidecar; `restored` is null when there was nothing to undo.
    undoReview(flashcardHash, algorithm = 'leitner') {
        return db.transaction(() => {
            const fc = query.getFlashcardByHash(flashcardHash);
            if (!fc) throw new Error(`Flashcard ${flashcardHash} not found.`);

            const removed = query.deleteLatestReviewLog(fc.id);
            if (!removed) return { document_id: fc.document_id, restored: null };

            const prev = query.getLatestReviewLog(fc.id);

            if (algorithm === 'fsrs') {
                // Restore the FSRS state snapshotted on the now-latest log; if none
                // remain the card reverts to new. reps/lapses aren't snapshotted per
                // log, so reps is decremented best-effort (they don't affect scheduling).
                const cur = query.getFlashcardFsrsState(fc.id);
                const reps = Math.max(0, (cur?.reps ?? 1) - 1);
                const restored = prev ? {
                    stability: prev.fsrs_stability,
                    difficulty: prev.fsrs_difficulty,
                    due: prev.fsrs_due,
                    state: prev.fsrs_state,
                    reps,
                    lapses: cur?.lapses ?? 0,
                    lastRecall: prev.timestamp,
                } : null;
                query.updateFlashcardFsrs(fc.id, restored
                    ? { ...restored, last_review: restored.lastRecall }
                    : { stability: null, difficulty: null, due: null, state: 0, reps: 0, lapses: 0, last_review: null });
                return { document_id: fc.document_id, restored };
            }

            const restored = {
                value: prev ? prev.level : 0,
                easeFactor: prev ? prev.ease_factor : 2.5,
                lastRecall: prev ? prev.timestamp : null,
            };
            query.undoFlashcardReview(fc.id, restored.value, restored.lastRecall, algorithm);

            return { document_id: fc.document_id, restored };
        })();
    }

    getLeitnerStats() {
        const boxes = query.getLeitnerBoxes();
        const total = query.getFlashcardCount();
        const mastered = query.getMasteredFlashcardCount(5);

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
    optimizeParameters() {
        const histories = query.getAllReviewHistories();
        const result = fsrs.optimize(histories);
        if (result.optimized) {
            query.setFsrsWeights(JSON.stringify(result.weights), result.reviewCount);
        }
        return result;
    }

    // Optimizer status for the Config panel: how many rated reviews exist, whether
    // the weights have been fitted, and when. optimizedAt === null ⇒ still on the
    // published defaults.
    getFsrsInfo() {
        const stored = query.getFsrsWeights();
        return {
            optimized: !!stored?.optimizedAt,
            optimizedAt: stored?.optimizedAt ?? null,
            weightReviewCount: stored?.reviewCount ?? null,
            reviewCount: query.getAllReviewHistories().length,
            minReviews: fsrs.MIN_OPTIMIZE_REVIEWS,
        };
    }

    migrateProgress(from, to) {
        if (from === to) return 0;

        const cards = query.getAllFlashcardSrsState();
        if (cards.length === 0) return 0;

        if (from === 'leitner' && to === 'sm2') {
            const translated = cards.map(c => ({
                global_hash: c.global_hash,
                sm2_reps: leitnerToSm2Reps(c.level ?? 0),
            }));
            query.batchSetSm2Reps(translated);
            return translated.length;
        }

        if (from === 'sm2' && to === 'leitner') {
            const efMap = query.getLatestEaseFactors();
            const translated = cards.map(c => ({
                global_hash: c.global_hash,
                level: sm2RepsToLeitnerLevel(c.sm2_reps ?? 0, efMap.get(c.global_hash) ?? 2.5),
            }));
            query.batchSetLeitnerLevel(translated);
            return translated.length;
        }

        // Into FSRS: seed each card's stability from its current interval under the
        // previous algorithm (stability ≈ the interval that yields ~90% retention),
        // difficulty at a neutral default. Best-effort — the optimizer refines later.
        if (to === 'fsrs') {
            const efMap = from === 'sm2' ? query.getLatestEaseFactors() : null;
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
                    lastRecall: c.last_recall ?? null,
                };
            });
            query.batchSetFsrsState(seeded);
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
                query.batchSetLeitnerLevel(translated);
                return translated.length;
            }
            if (to === 'sm2') {
                const translated = cards.map(c => ({
                    global_hash: c.global_hash,
                    sm2_reps: intervalToSm2Reps(toInterval(c)),
                }));
                query.batchSetSm2Reps(translated);
                return translated.length;
            }
        }

        return 0;
    }

    getDue({ algorithm = 'leitner', folder = null, deck = null, tags = null, maxNew = 20, minPriority = 0 } = {}) {
        const result = query.getDueFlashcards({ algorithm, folder, deck, tags, maxNew, minPriority });
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
