import { Router } from 'express';
import Decks from '../access/orchestration/decks.js';
import Documents from '../access/orchestration/documents.js';
import { FLAG_KINDS } from '../access/orchestration/cardHealth.js';

const router = Router();
const decks = new Decks();
// Needed only by /:hash/purge, to delete document-anchored cards out of their source
// sidecar. Composed here rather than inside decks.js, which never imports documents.js
// — the same arrangement routes/flashcards.js uses to delete a single card.
const docs = new Documents();

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
router.get('/', catchError(async (req, res) => {
    res.json(await decks.listDecks());
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
router.get('/cards', catchError(async (req, res) => {
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
    const cards = await decks.searchCards({ ...filters, sortBy, sortDir, limit, offset });
    const total = await decks.getCardCount(filters);
    res.json({ cards, total, limit, offset });
}));

// GET /api/decks/:hash
router.get('/:hash', catchError(async (req, res) => {
    res.json(await decks.getDeck(req.params.hash));
}));

// PUT /api/decks/:hash
// Body: { name?, description? }
router.put('/:hash', catchError(async (req, res) => {
    const { name, description } = req.body;
    await decks.updateDeck(req.params.hash, { name, description });
    res.json({ ok: true });
}));

// DELETE /api/decks/:hash — removes the deck only. The cards survive as standalone
// cards in the system deck. To destroy them too, use POST /:hash/purge below.
router.delete('/:hash', catchError(async (req, res) => {
    await decks.deleteDeck(req.params.hash);
    res.json({ ok: true });
}));

// GET /api/decks/:hash/contents
// What erasing this deck *and its cards* would destroy — counts split by standalone
// vs document-anchored, plus how many cards another (non-system) deck also holds.
// Read-only; exists so a client can say exactly what it is about to delete.
router.get('/:hash/contents', catchError(async (req, res) => {
    res.json(await decks.getContentsSummary(req.params.hash));
}));

// POST /api/decks/:hash/purge
// Body: { includeShared?: boolean }
//
// Deletes the deck AND its cards. Deliberately a separate route rather than a flag on
// DELETE /:hash, so the non-destructive delete can never become destructive by accident.
//
// Cards are deleted before the deck: card deletions go through sealEmitter.edit(), which
// is debounced, and deleteDeck()'s sealEmitter.delete() then flushes them — so the whole
// erase lands in one commit instead of one per card.
router.post('/:hash/purge', catchError(async (req, res) => {
    const includeShared = req.body?.includeShared === true;
    const { hash } = req.params;

    const { standalone, anchored, kept } = await decks.getPurgeTargets(hash, { includeShared });

    for (const cardHash of standalone) {
        await decks.deleteStandaloneCard(cardHash);
    }
    // Document-anchored cards live in their source sidecar, so they need the same
    // unlink-then-delete pair routes/flashcards.js uses for a single card.
    for (const { hash: cardHash, documentPath } of anchored) {
        await decks.removeCardEverywhere(cardHash);
        await docs.deleteFlashcard(documentPath, cardHash);
    }

    await decks.deleteDeck(hash);
    res.json({ ok: true, deleted: standalone.length + anchored.length, kept });
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
