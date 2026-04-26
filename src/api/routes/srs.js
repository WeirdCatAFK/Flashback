import { Router } from 'express';
import path from 'path';
import Documents from '../access/documents.js';

const router = Router();
const docs = new Documents();
const norm = (p) => p ? path.normalize(p) : p;

// POST /api/srs/review
// Body: { path, flashcardHash, outcome, easeFactor, newLevel }
// Submits a spaced-repetition review for a flashcard. Updates the SRS level
// in both the sidecar and the DB, and logs the review event.
router.post('/review', async (req, res) => {
    const relPath = norm(req.body.path);
    const { flashcardHash, outcome, easeFactor, newLevel } = req.body;
    if (!relPath || !flashcardHash || outcome == null || easeFactor == null || newLevel == null) {
        return res.status(400).json({ error: 'path, flashcardHash, outcome, easeFactor, and newLevel required' });
    }
    await docs.submitReview(relPath, flashcardHash, outcome, easeFactor, newLevel);
    res.json({ ok: true });
});

// GET /api/srs/stats
// Returns Leitner box distribution and aggregate mastery stats.
router.get('/stats', (req, res) => {
    const boxes = docs.query.getLeitnerBoxes();
    const total = docs.query.getFlashcardCount();
    res.json({ boxes, total });
});

export default router;
