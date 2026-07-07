import { Router } from 'express';
import path from 'path';
import Documents from '../access/documents.js';
import SRS from '../access/srs.js';

const router = Router();
const docs = new Documents();
const norm = (p) => p ? path.normalize(p) : p;
const catchError = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// POST /api/srs/review
// Body: { path?, flashcardHash, algorithm, ...algorithm-specific }
//   leitner/sm2: outcome, easeFactor, newLevel (computed client-side)
//   fsrs:        rating (1-4), requestRetention (server computes the schedule)
// path is optional: document-linked cards include it so the sidecar is updated;
// standalone cards (no document) omit it and only the DB is updated.
router.post('/review', catchError(async (req, res) => {
    const relPath = norm(req.body.path);
    const { flashcardHash, outcome, easeFactor, newLevel, algorithm, rating, requestRetention } = req.body;
    if (!flashcardHash) {
        return res.status(400).json({ error: 'flashcardHash required' });
    }
    if (algorithm === 'fsrs') {
        if (rating == null) return res.status(400).json({ error: 'rating (1-4) required for fsrs' });
    } else if (outcome == null || easeFactor == null || newLevel == null) {
        return res.status(400).json({ error: 'outcome, easeFactor, and newLevel required' });
    }
    const opts = { rating, requestRetention };
    if (relPath) {
        await docs.submitReview(relPath, flashcardHash, outcome, easeFactor, newLevel, algorithm, opts);
    } else {
        SRS.submitReview(flashcardHash, outcome, easeFactor, newLevel, algorithm, opts);
    }
    res.json({ ok: true });
}));

// POST /api/srs/undo
// Body: { path?, flashcardHash, algorithm }
// Reverses the card's most recent review (a misgraded result): removes the last
// log and restores the card's prior SRS state. Like /review, `path` is present for
// document-linked cards (so the sidecar is corrected too) and omitted for standalone.
router.post('/undo', catchError(async (req, res) => {
    const relPath = norm(req.body.path);
    const { flashcardHash, algorithm } = req.body;
    if (!flashcardHash) {
        return res.status(400).json({ error: 'flashcardHash required' });
    }
    let restored;
    if (relPath) {
        restored = await docs.undoReview(relPath, flashcardHash, algorithm);
    } else {
        ({ restored } = SRS.undoReview(flashcardHash, algorithm));
    }
    res.json({ ok: true, restored });
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
    const ALGS = ['leitner', 'sm2', 'fsrs'];
    if (!ALGS.includes(from) || !ALGS.includes(to)) {
        return res.status(400).json({ error: 'from and to must be leitner, sm2, or fsrs' });
    }
    const count = SRS.migrateProgress(from, to);
    res.json({ ok: true, count });
}));

// POST /api/srs/optimize
// Fits the vault's FSRS weights from its own rated review history and persists
// them (no-op below the minimum-data threshold). Returns before/after loss and
// review counts. No body required.
router.post('/optimize', catchError((req, res) => {
    const result = SRS.optimizeParameters();
    res.json({ ok: true, ...result });
}));

// GET /api/srs/fsrs-info
// Optimizer status for the Config panel: rated-review count, whether the weights
// have been fitted, and when.
router.get('/fsrs-info', catchError((req, res) => {
    res.json(SRS.getFsrsInfo());
}));

// GET /api/srs/statistics?algorithm=leitner|sm2|fsrs
// Vault-wide analytics for the Stats view (retention, maturity, due forecast,
// activity heatmap, streaks). Read-only. Algorithm defaults server-side.
router.get('/statistics', catchError((req, res) => {
    const algorithm = req.query.algorithm || undefined;
    res.json(SRS.getStatistics({ algorithm }));
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
