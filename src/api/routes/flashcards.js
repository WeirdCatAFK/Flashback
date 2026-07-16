import { Router } from 'express';
import Decks from '../access/decks.js';

const router = Router();
const decks = new Decks();

const catchError = (fn) => (req, res, next) =>
    Promise.resolve().then(() => fn(req, res, next)).catch((err) => {
        if (err.message?.includes('not found')) return res.status(404).json({ error: err.message });
        if (err.message?.includes('document')) return res.status(400).json({ error: err.message });
        if (err.message?.startsWith('Unknown category')) return res.status(400).json({ error: err.message });
        next(err);
    });

// GET /api/flashcards/:hash — resolve any card (standalone or anchored) to its
// content + source document path, so clients can route edits correctly.
router.get('/:hash', catchError((req, res) => {
    const card = decks.getCard(req.params.hash);
    res.json(card);
}));

// POST /api/flashcards — create standalone card
// `origin` marks provenance ('ai' = created by an AI assistant); set once at
// creation, never editable afterwards — the PUT below deliberately ignores it.
router.post('/', catchError(async (req, res) => {
    const { frontText, backText, name, cardType = 'basic', category, customHtml } = req.body;
    const origin = req.body.origin === 'ai' ? 'ai' : null;
    const globalHash = await decks.createStandaloneCard({ frontText, backText, name, cardType, category, customHtml, origin });
    res.status(201).json({ globalHash });
}));

// PUT /api/flashcards/:hash — update standalone card content (partial: omitted
// fields keep their stored values)
router.put('/:hash', catchError(async (req, res) => {
    const { frontText, backText, name, cardType, category, customHtml } = req.body;
    await decks.updateStandaloneCard(req.params.hash, { frontText, backText, name, cardType, category, customHtml });
    res.json({ ok: true });
}));

// DELETE /api/flashcards/:hash — delete standalone card
router.delete('/:hash', catchError(async (req, res) => {
    await decks.deleteStandaloneCard(req.params.hash);
    res.json({ ok: true });
}));

export default router;
