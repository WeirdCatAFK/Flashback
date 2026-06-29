import { Router } from 'express';
import Decks from '../access/decks.js';

const router = Router();
const decks = new Decks();

const catchError = (fn) => (req, res, next) =>
    Promise.resolve().then(() => fn(req, res, next)).catch((err) => {
        if (err.message?.includes('not found')) return res.status(404).json({ error: err.message });
        if (err.message?.includes('document')) return res.status(400).json({ error: err.message });
        next(err);
    });

// POST /api/flashcards — create standalone card
router.post('/', catchError((req, res) => {
    const { frontText, backText, name, cardType = 'basic', category, customHtml } = req.body;
    const globalHash = decks.createStandaloneCard({ frontText, backText, name, cardType, category, customHtml });
    res.status(201).json({ globalHash });
}));

// PUT /api/flashcards/:hash — update standalone card content
router.put('/:hash', catchError((req, res) => {
    const { frontText, backText, name, cardType, category } = req.body;
    decks.updateStandaloneCard(req.params.hash, { frontText, backText, name, cardType, category });
    res.json({ ok: true });
}));

// DELETE /api/flashcards/:hash — delete standalone card
router.delete('/:hash', catchError((req, res) => {
    decks.deleteStandaloneCard(req.params.hash);
    res.json({ ok: true });
}));

export default router;
