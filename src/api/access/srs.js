/**
 * SRS.js
 * Spaced Repetition System service.
 */

import query from './query.js';
import db from './database.js';

class SRSService {
    /**
     * Logs a review and updates flashcard level.
     */
    submitReview(flashcardHash, outcome, easeFactor, newLevel) {
        const timestamp = new Date().toISOString();

        const transaction = db.transaction(() => {
            const fc = db.prepare('SELECT id, document_id FROM Flashcards WHERE global_hash = ?').get(flashcardHash);
            if (!fc) throw new Error(`Flashcard ${flashcardHash} not found.`);

            // 1. Update Flashcard
            db.prepare('UPDATE Flashcards SET last_recall = ?, level = ? WHERE id = ?')
                .run(timestamp, newLevel, fc.id);

            // 2. Log Entry
            db.prepare(`
                INSERT INTO ReviewLogs (flashcard_id, timestamp, outcome, ease_factor, level)
                VALUES (?, ?, ?, ?, ?)
            `).run(fc.id, timestamp, outcome, easeFactor, newLevel);

            return fc.document_id;
        });

        return transaction();
    }

    /**
     * Gets stats for the Leitner system.
     */
    getLeitnerStats() {
        const boxes = db.prepare(`SELECT level, COUNT(*) as count FROM Flashcards GROUP BY level ORDER BY level ASC`).all();
        const total = db.prepare('SELECT COUNT(*) as c FROM Flashcards').get().c;
        const mastered = db.prepare('SELECT COUNT(*) as c FROM Flashcards WHERE level >= 5').get().c;
        
        return { 
            boxes, 
            totalCards: total, 
            masteryPercentage: total > 0 ? (mastered / total) * 100 : 0 
        };
    }
}

export default new SRSService();
