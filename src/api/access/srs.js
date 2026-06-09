/**
 * SRS.js
 * Spaced Repetition System service.
 */

import query from './query.js';
import db from './database.js';

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

class SRSService {
    submitReview(flashcardHash, outcome, easeFactor, newLevel, algorithm = 'leitner') {
        const timestamp = new Date().toISOString();

        return db.transaction(() => {
            const fc = query.getFlashcardByHash(flashcardHash);
            if (!fc) throw new Error(`Flashcard ${flashcardHash} not found.`);

            query.updateFlashcardReview(fc.id, timestamp, newLevel, algorithm);
            query.insertReviewLog({
                flashcardId: fc.id,
                timestamp,
                outcome,
                easeFactor,
                level: newLevel
            });

            return fc.document_id;
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
