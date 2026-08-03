import { Router } from 'express';
import Decks from '../access/decks.js';
import { FLAG_KINDS } from '../access/cardHealth.js';

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
router.post('/', catchError(async (req, res) => {
    const { name, description = '' } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const globalHash = await decks.createDeck(name, description);
    res.status(201).json({ globalHash });
}));

// GET /api/decks/cards?search=&level=&cardType=&origin=&flagged=&flagKind=&sortBy=&sortDir=&limit=&offset=
//
// `flagged=1` restricts to cards carrying a live card-health flag, `flagKind` to one
// signature. This is the vault-wide view of what the classifier has raised — a filter on
// the card browser rather than a separate inbox, so flagged cards stay in the one place
// cards are already hunted down. Each row's `flags` is a comma-joined kind list.
router.get('/cards', catchError((req, res) => {
    const search = req.query.search || null;
    const level = req.query.level !== undefined ? parseInt(req.query.level) : null;
    const cardType = req.query.cardType || null;
    // 'ai' → only AI-created cards, 'human' → only cards not created by an AI assistant
    const origin = ['ai', 'human'].includes(req.query.origin) ? req.query.origin : null;
    const flagKind = FLAG_KINDS.includes(req.query.flagKind) ? req.query.flagKind : null;
    const flagged = flagKind !== null || req.query.flagged === '1' || req.query.flagged === 'true';
    const sortBy = req.query.sortBy || 'level';
    const sortDir = req.query.sortDir || 'desc';
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const filters = { search, level, cardType, origin, flagged, flagKind };
    const cards = decks.searchCards({ ...filters, sortBy, sortDir, limit, offset });
    const total = decks.getCardCount(filters);
    res.json({ cards, total, limit, offset });
}));

// GET /api/decks/:hash
router.get('/:hash', catchError((req, res) => {
    res.json(decks.getDeck(req.params.hash));
}));

// PUT /api/decks/:hash
// Body: { name?, description? }
router.put('/:hash', catchError(async (req, res) => {
    const { name, description } = req.body;
    await decks.updateDeck(req.params.hash, { name, description });
    res.json({ ok: true });
}));

// DELETE /api/decks/:hash
router.delete('/:hash', catchError(async (req, res) => {
    await decks.deleteDeck(req.params.hash);
    res.json({ ok: true });
}));

// PUT /api/decks/:hash/tags
// Body: { tags: string[] } — replaces the deck's tags; they flow to member cards.
router.put('/:hash/tags', catchError(async (req, res) => {
    const tags = Array.isArray(req.body?.tags) ? req.body.tags : [];
    const saved = await decks.setTags(req.params.hash, tags);
    res.json({ ok: true, tags: saved });
}));

// POST /api/decks/:hash/entries
// Body: { cardHash, documentPath?, inlineCard? }
router.post('/:hash/entries', catchError(async (req, res) => {
    const { cardHash, documentPath, inlineCard } = req.body;
    if (!cardHash) return res.status(400).json({ error: 'cardHash required' });
    await decks.addEntry(req.params.hash, { cardHash, documentPath, inlineCard });
    res.status(201).json({ ok: true });
}));

// DELETE /api/decks/:hash/entries/:cardHash
router.delete('/:hash/entries/:cardHash', catchError(async (req, res) => {
    await decks.removeEntry(req.params.hash, req.params.cardHash);
    res.json({ ok: true });
}));

export default router;
