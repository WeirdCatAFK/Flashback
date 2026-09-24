import { Router } from 'express';
import multer from 'multer';
import Decks, { COVER_TYPES, MAX_COVER_BYTES } from '../access/orchestration/decks.js';
import Documents from '../access/orchestration/documents.js';
import { FLAG_KINDS } from '../access/orchestration/cardHealth.js';
import { GAP_BANDS } from '../access/orchestration/srs.js';
import { isDeckColor } from '../../shared/deckColors.js';

const router = Router();
const coverUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_COVER_BYTES } });
const decks = new Decks();
const docs = new Documents();

const catchError = (fn) => (req, res, next) =>
    Promise.resolve().then(() => fn(req, res, next)).catch((err) => {
        if (err.code === 'LIMIT_FILE_SIZE' || err.message === 'Cover image too large') {
            return res.status(413).json({ error: 'Cover image too large' });
        }
        if (err.message?.startsWith('Unsupported cover type') || err.message?.startsWith('Unknown cover pattern')) {
            return res.status(400).json({ error: err.message });
        }
        if (err.message?.includes('already in deck')) return res.status(409).json({ error: err.message });
        if (err.message?.includes('not found')) return res.status(404).json({ error: err.message });
        if (err.message?.includes('system deck')) return res.status(403).json({ error: err.message });
        if (err.code === 'ENOENT' || err.code === 'EACCES' || err.code === 'EPERM') {
            return res.status(500).json({ error: 'Deck storage is temporarily unavailable — try again.' });
        }
        next(err);
    });

/**
 * The card browser's source filter: `source=standalone` (the default deck's own
 * cards), or `source=folder|document` with `sourcePath`, compared with forward
 * slashes whatever the platform stored.
 */
const sourceFrom = (q) => {
    if (q.source === 'standalone') return { kind: 'standalone' };
    if ((q.source === 'folder' || q.source === 'document') && q.sourcePath) {
        return { kind: q.source, path: String(q.sourcePath).replace(/\\/g, '/').replace(/\/+$/, '') };
    }
    return null;
};

const algorithmFrom = (q) => (['leitner', 'sm2', 'fsrs'].includes(q.algorithm) ? q.algorithm : null);

/** Every deck with its entry count, colour and how its cards stand for the caller. */
router.get('/', catchError(async (req, res) => {
    res.json(await decks.listDecks({ algorithm: algorithmFrom(req.query) }));
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
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    const offset = parseInt(req.query.offset) || 0;
    const band = GAP_BANDS.some((b) => b.id === req.query.band) ? req.query.band : null;
    const algorithm = ['leitner', 'sm2', 'fsrs'].includes(req.query.algorithm) ? req.query.algorithm : null;
    const source = sourceFrom(req.query);
    const groupBy = ['gap', 'source'].includes(req.query.groupBy) ? req.query.groupBy : null;
    const filters = { search, level, cardType, origin, flagged, flagKind, source };
    const { cards, total, groups } = await decks.searchCards({ ...filters, band, algorithm, groupBy, sortBy, sortDir, limit, offset });
    res.json({ cards, total, limit, offset, ...(groups ? { groups } : {}) });
}));

/** The card browser's sidebar: cards per document and per gap band, and health counts. */
router.get('/cards/summary', catchError(async (req, res) => {
    const algorithm = ['leitner', 'sm2', 'fsrs'].includes(req.query.algorithm) ? req.query.algorithm : null;
    res.json(await decks.catalogueSummary({ algorithm }));
}));

/** One deck: its metadata, colour, entries and standing. */
router.get('/:hash', catchError(async (req, res) => {
    res.json(await decks.getDeck(req.params.hash, { algorithm: algorithmFrom(req.query) }));
}));

/** Updates a deck's name, description or box colour (a palette id, or null for the default). */
router.put('/:hash', catchError(async (req, res) => {
    const { name, description, color } = req.body;
    if (color !== undefined && color !== null && !isDeckColor(color)) {
        return res.status(400).json({ error: `Unknown deck colour: ${color}` });
    }
    await decks.updateDeck(req.params.hash, { name, description, color });
    res.json({ ok: true });
}));

/** The deck's cover image, for an <img>. 404 when its cover is a pattern or there is none. */
router.get('/:hash/cover', catchError(async (req, res) => {
    const { absPath, mime } = await decks.coverImage(req.params.hash);
    res.type(mime).sendFile(absPath);
}));

/** Uploads an image (`file`, multipart) as the deck's cover. */
router.post('/:hash/cover', (req, res, next) => coverUpload.single('file')(req, res, (err) => {
    if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Cover image too large' });
    return err ? next(err) : next();
}), catchError(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'file required' });
    if (!COVER_TYPES[req.file.mimetype]) return res.status(400).json({ error: `Unsupported cover type: ${req.file.mimetype}` });
    res.status(201).json({ cover: await decks.uploadCover(req.params.hash, req.file.buffer, req.file.mimetype) });
}));

/** Sets a drawn cover (`{ pattern }`) or repositions the image one (`{ y }`, 0..1). */
router.put('/:hash/cover', catchError(async (req, res) => {
    const { pattern, y } = req.body ?? {};
    if (pattern === undefined && y === undefined) return res.status(400).json({ error: 'pattern or y required' });
    res.json({ cover: await decks.setCover(req.params.hash, pattern !== undefined ? { pattern } : { y }) });
}));

/** Removes the deck's cover, deleting its image. */
router.delete('/:hash/cover', catchError(async (req, res) => {
    await decks.setCover(req.params.hash, null);
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
