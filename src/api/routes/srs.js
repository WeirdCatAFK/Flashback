import { Router } from 'express';
import path from 'path';
import Documents from '../access/documents.js';
import SRS from '../access/SRS.js';

const router = Router();
const docs = new Documents();
const norm = (p) => p ? path.normalize(p) : p;
const catchError = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// POST /api/srs/review
// Body: { path?, flashcardHash, outcome, easeFactor, newLevel }
// path is optional: document-linked cards include it so the sidecar is updated;
// standalone cards (no document) omit it and only the DB is updated.
router.post('/review', catchError(async (req, res) => {
    const relPath = norm(req.body.path);
    const { flashcardHash, outcome, easeFactor, newLevel, algorithm } = req.body;
    if (!flashcardHash || outcome == null || easeFactor == null || newLevel == null) {
        return res.status(400).json({ error: 'flashcardHash, outcome, easeFactor, and newLevel required' });
    }
    if (relPath) {
        await docs.submitReview(relPath, flashcardHash, outcome, easeFactor, newLevel, algorithm);
    } else {
        SRS.submitReview(flashcardHash, outcome, easeFactor, newLevel, algorithm);
    }
    res.json({ ok: true });
}));

// GET /api/srs/stats
router.get('/stats', catchError((req, res) => {
    const boxes = docs.query.getLeitnerBoxes();
    const total = docs.query.getFlashcardCount();
    res.json({ boxes, total });
}));

// POST /api/srs/migrate
// Body: { from: 'leitner'|'sm2', to: 'leitner'|'sm2' }
// Translates all card progress from one algorithm's scale to the other using
// interval-matched mapping, so the review schedule is preserved as closely as possible.
router.post('/migrate', catchError((req, res) => {
    const { from, to } = req.body;
    if (!from || !to || from === to) {
        return res.status(400).json({ error: 'from and to are required and must differ' });
    }
    if (!['leitner', 'sm2'].includes(from) || !['leitner', 'sm2'].includes(to)) {
        return res.status(400).json({ error: 'from and to must be leitner or sm2' });
    }
    const count = SRS.migrateProgress(from, to);
    res.json({ ok: true, count });
}));

// GET /api/srs/due
// Query params (all optional, user preferences come from browser storage):
//   algorithm=leitner|sm2  — SRS scheduling algorithm (stored in localStorage by the frontend)
//   maxNew=<n>             — new cards to introduce per session (stored in localStorage)
//   minPriority=<n>        — only include cards whose pedagogical category priority >= n
//   folder=<relPath>       — restrict to a folder subtree
//   deck=<hash>            — restrict to cards in a specific deck
//   tag=<name>             — restrict to cards tagged with this name (repeatable)
router.get('/due', catchError((req, res) => {
    const algorithm = req.query.algorithm || undefined;
    const folder = req.query.folder ? norm(req.query.folder) : null;
    const deck = req.query.deck || null;
    const rawTags = req.query.tag;
    const tags = rawTags ? [].concat(rawTags).filter(Boolean) : null;
    const maxNew = req.query.maxNew != null ? parseInt(req.query.maxNew, 10) : undefined;
    const minPriority = req.query.minPriority != null ? parseInt(req.query.minPriority, 10) : undefined;

    const result = SRS.getDue({ algorithm, folder, deck, tags: tags?.length ? tags : null, maxNew, minPriority });
    res.json(result);
}));

export default router;
