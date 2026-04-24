/**
 * SRS.js
 * Spaced Repetition System service.
 */

import query from './query.js';
import db from './database.js';

class SRSService {
    submitReview(flashcardHash, outcome, easeFactor, newLevel) {
        const timestamp = new Date().toISOString();

        return db.transaction(() => {
            const fc = query.getFlashcardByHash(flashcardHash);
            if (!fc) throw new Error(`Flashcard ${flashcardHash} not found.`);

            query.updateFlashcardReview(fc.id, timestamp, newLevel);
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
}

export default new SRSService();
