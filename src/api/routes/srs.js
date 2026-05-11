import { Router } from 'express';
import path from 'path';
import Documents from '../access/documents.js';

const router = Router();
const docs = new Documents();
const norm = (p) => p ? path.normalize(p) : p;
const catchError = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// POST /api/srs/review
// Body: { path, flashcardHash, outcome, easeFactor, newLevel }
router.post('/review', catchError(async (req, res) => {
    const relPath = norm(req.body.path);
    const { flashcardHash, outcome, easeFactor, newLevel } = req.body;
    if (!relPath || !flashcardHash || outcome == null || easeFactor == null || newLevel == null) {
        return res.status(400).json({ error: 'path, flashcardHash, outcome, easeFactor, and newLevel required' });
    }
    await docs.submitReview(relPath, flashcardHash, outcome, easeFactor, newLevel);
    res.json({ ok: true });
}));

// GET /api/srs/stats
router.get('/stats', catchError((req, res) => {
    const boxes = docs.query.getLeitnerBoxes();
    const total = docs.query.getFlashcardCount();
    res.json({ boxes, total });
}));

export default router;
