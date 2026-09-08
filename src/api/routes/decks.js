import { Router } from 'express';
import Decks from '../access/orchestration/decks.js';
import Documents from '../access/orchestration/documents.js';
import { FLAG_KINDS } from '../access/orchestration/cardHealth.js';

const router = Router();
const decks = new Decks();
const docs = new Documents();

const catchError = (fn) => (req, res, next) =>
    Promise.resolve().then(() => fn(req, res, next)).catch((err) => {
        if (err.message?.includes('already in deck')) return res.status(409).json({ error: err.message });
        if (err.message?.includes('not found')) return res.status(404).json({ error: err.message });
        if (err.message?.includes('system deck')) return res.status(403).json({ error: err.message });
        if (err.code === 'ENOENT' || err.code === 'EACCES' || err.code === 'EPERM') {
            return res.status(500).json({ error: 'Deck storage is temporarily unavailable — try again.' });
        }
        next(err);
    });

/** Every deck with its entry count. */
router.get('/', catchError(async (req, res) => {
    res.json(await decks.listDecks());
}));

/** Creates a deck. */
router.post('/', catchError(async (req, res) => {
    const { name, description = '' } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const globalHash = await decks.createDeck(name, description);
    res.status(201).json({ globalHash });
}));

/** The card browser: a filtered, sorted, paged view of every card in the vault. */
router.get('/cards', catchError(async (req, res) => {
    const search = req.query.search || null;
    const level = req.query.level !== undefined ? parseInt(req.query.level) : null;
    const cardType = req.query.cardType || null;
    const origin = ['ai', 'human'].includes(req.query.origin) ? req.query.origin : null;
    const flagKind = FLAG_KINDS.includes(req.query.flagKind) ? req.query.flagKind : null;
    const flagged = flagKind !== null || req.query.flagged === '1' || req.query.flagged === 'true';
    const sortBy = req.query.sortBy || 'level';
    const sortDir = req.query.sortDir || 'desc';
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const filters = { search, level, cardType, origin, flagged, flagKind };
    const cards = await decks.searchCards({ ...filters, sortBy, sortDir, limit, offset });
    const total = await decks.getCardCount(filters);
    res.json({ cards, total, limit, offset });
}));

/** One deck's metadata. */
router.get('/:hash', catchError(async (req, res) => {
    res.json(await decks.getDeck(req.params.hash));
}));

/** Updates a deck's name, description or tags. */
router.put('/:hash', catchError(async (req, res) => {
    const { name, description } = req.body;
    await decks.updateDeck(req.params.hash, { name, description });
    res.json({ ok: true });
}));

/** Deletes a deck, leaving its cards in place. */
router.delete('/:hash', catchError(async (req, res) => {
    await decks.deleteDeck(req.params.hash);
    res.json({ ok: true });
}));

/** A deck's cards with the caller's schedule joined on. */
router.get('/:hash/contents', catchError(async (req, res) => {
    res.json(await decks.getContentsSummary(req.params.hash));
}));

/** Deletes a deck and every card that lives only in it. */
router.post('/:hash/purge', catchError(async (req, res) => {
    const includeShared = req.body?.includeShared === true;
    const { hash } = req.params;

    const { standalone, anchored, kept } = await decks.getPurgeTargets(hash, { includeShared });

    for (const cardHash of standalone) {
        await decks.deleteStandaloneCard(cardHash);
    }
    for (const { hash: cardHash, documentPath } of anchored) {
        await decks.removeCardEverywhere(cardHash);
        await docs.deleteFlashcard(documentPath, cardHash);
    }

    await decks.deleteDeck(hash);
    res.json({ ok: true, deleted: standalone.length + anchored.length, kept });
}));

/** Replaces a deck's tags, re-flowing them to its cards. */
router.put('/:hash/tags', catchError(async (req, res) => {
    const tags = Array.isArray(req.body?.tags) ? req.body.tags : [];
    const saved = await decks.setTags(req.params.hash, tags);
    res.json({ ok: true, tags: saved });
}));

/** Adds a card to a deck. */
router.post('/:hash/entries', catchError(async (req, res) => {
    const { cardHash, documentPath, inlineCard } = req.body;
    if (!cardHash) return res.status(400).json({ error: 'cardHash required' });
    await decks.addEntry(req.params.hash, { cardHash, documentPath, inlineCard });
    res.status(201).json({ ok: true });
}));

/** Removes a card from a deck. */
router.delete('/:hash/entries/:cardHash', catchError(async (req, res) => {
    await decks.removeEntry(req.params.hash, req.params.cardHash);
    res.json({ ok: true });
}));

export default router;
