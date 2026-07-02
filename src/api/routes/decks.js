import { Router } from 'express';
import Decks from '../access/decks.js';

const router = Router();
const decks = new Decks();

const catchError = (fn) => (req, res, next) =>
    Promise.resolve().then(() => fn(req, res, next)).catch((err) => {
        if (err.message?.includes('already in deck')) return res.status(409).json({ error: err.message });
        if (err.message?.includes('not found')) return res.status(404).json({ error: err.message });
        if (err.message?.includes('system deck')) return res.status(403).json({ error: err.message });
        // Belt-and-suspenders: never let a raw fs error (absolute path, username) reach a
        // client. decks.js self-heals a missing deck file (see _readOrRebuild), so this
        // should be rare, but a permissions error or similar could still surface one.
        if (err.code === 'ENOENT' || err.code === 'EACCES' || err.code === 'EPERM') {
            return res.status(500).json({ error: 'Deck storage is temporarily unavailable — try again.' });
        }
        next(err);
    });

// GET /api/decks
router.get('/', catchError((req, res) => {
    res.json(decks.listDecks());
}));

// POST /api/decks
// Body: { name, description? }
router.post('/', catchError((req, res) => {
    const { name, description = '' } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const globalHash = decks.createDeck(name, description);
    res.status(201).json({ globalHash });
}));

// GET /api/decks/cards?search=&level=&cardType=&sortBy=&sortDir=&limit=&offset=
router.get('/cards', catchError((req, res) => {
    const search = req.query.search || null;
    const level = req.query.level !== undefined ? parseInt(req.query.level) : null;
    const cardType = req.query.cardType || null;
    const sortBy = req.query.sortBy || 'level';
    const sortDir = req.query.sortDir || 'desc';
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const cards = decks.searchCards({ search, level, cardType, sortBy, sortDir, limit, offset });
    const total = decks.getCardCount({ search, level, cardType });
    res.json({ cards, total, limit, offset });
}));

// GET /api/decks/:hash
router.get('/:hash', catchError((req, res) => {
    res.json(decks.getDeck(req.params.hash));
}));

// PUT /api/decks/:hash
// Body: { name?, description? }
router.put('/:hash', catchError((req, res) => {
    const { name, description } = req.body;
    decks.updateDeck(req.params.hash, { name, description });
    res.json({ ok: true });
}));

// DELETE /api/decks/:hash
router.delete('/:hash', catchError((req, res) => {
    decks.deleteDeck(req.params.hash);
    res.json({ ok: true });
}));

// POST /api/decks/:hash/entries
// Body: { cardHash, documentPath?, inlineCard? }
router.post('/:hash/entries', catchError((req, res) => {
    const { cardHash, documentPath, inlineCard } = req.body;
    if (!cardHash) return res.status(400).json({ error: 'cardHash required' });
    decks.addEntry(req.params.hash, { cardHash, documentPath, inlineCard });
    res.status(201).json({ ok: true });
}));

// DELETE /api/decks/:hash/entries/:cardHash
router.delete('/:hash/entries/:cardHash', catchError((req, res) => {
    decks.removeEntry(req.params.hash, req.params.cardHash);
    res.json({ ok: true });
}));

export default router;
