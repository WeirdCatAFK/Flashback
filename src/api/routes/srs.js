import { Router } from 'express';
import path from 'path';
import Documents from '../access/documents.js';
import SRS from '../access/srs.js';

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

// GET /api/srs/due
// Query params (all optional, user preferences come from browser storage):
//   algorithm=leitner|sm2  — SRS scheduling algorithm (stored in localStorage by the frontend)
//   maxNew=<n>             — new cards to introduce per session (stored in localStorage)
//   folder=<relPath>       — restrict to a folder subtree
//   tag=<name>             — restrict to cards tagged with this name
router.get('/due', catchError((req, res) => {
    const algorithm = req.query.algorithm || undefined;
    const folder = req.query.folder ? norm(req.query.folder) : null;
    const deck = req.query.deck || null;
    const rawTags = req.query.tag;
    const tags = rawTags ? [].concat(rawTags).filter(Boolean) : null;
    const maxNew = req.query.maxNew != null ? parseInt(req.query.maxNew, 10) : undefined;

    const result = SRS.getDue({ algorithm, folder, deck, tags: tags?.length ? tags : null, maxNew });
    res.json(result);
}));

export default router;
