import { Router } from 'express';
import multer from 'multer';
import * as Decks from '../access/modules/decks.js';
import { COVER_TYPES, MAX_COVER_BYTES } from '../../shared/covers.js';
import * as Documents from '../access/modules/documents.js';
import { FLAG_KINDS } from '../access/modules/cardHealth.js';
import { GAP_BANDS } from '../access/modules/srs.js';
import { isDeckColor } from '../../shared/deckColors.js';

const router = Router();
const coverUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_COVER_BYTES, fieldNestingDepth: 0 } });

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

const sourceFrom = (q) => {
    if (q.source === 'standalone') return { kind: 'standalone' };
    if ((q.source === 'folder' || q.source === 'document') && q.sourcePath) {
        return { kind: q.source, path: String(q.sourcePath).replace(/\\/g, '/').replace(/\/+$/, '') };
    }
    return null;
};

const algorithmFrom = (q) => (['leitner', 'sm2', 'fsrs'].includes(q.algorithm) ? q.algorithm : null);

router.get('/', catchError(async (req, res) => {
    res.json(await Decks.listDecks({ algorithm: algorithmFrom(req.query) }));
}));

router.post('/', catchError(async (req, res) => {
    const { name, description = '' } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const globalHash = await Decks.createDeck(name, description);
    res.status(201).json({ globalHash });
}));

router.get('/cards', catchError(async (req, res) => {
    const search = req.query.search || null;
    const level = req.query.level !== undefined ? parseInt(req.query.level) : null;
    const cardType = req.query.cardType || null;
    const origin = ['ai', 'human', 'import'].includes(req.query.origin) ? req.query.origin : null;
    const flagKind = FLAG_KINDS.includes(req.query.flagKind) ? req.query.flagKind : null;
    const flagged = flagKind !== null || req.query.flagged === '1' || req.query.flagged === 'true';
    const sortBy = req.query.sortBy || 'level';
    const sortDir = req.query.sortDir || 'desc';
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    const offset = parseInt(req.query.offset) || 0;
    const band = GAP_BANDS.some((b) => b.id === req.query.band) ? req.query.band : null;
    const tag = req.query.tag ? String(req.query.tag) : null;
    const categoryId = /^\d+$/.test(String(req.query.category ?? '')) ? Number(req.query.category) : null;
    const algorithm = ['leitner', 'sm2', 'fsrs'].includes(req.query.algorithm) ? req.query.algorithm : null;
    const source = sourceFrom(req.query);
    const groupBy = ['gap', 'source'].includes(req.query.groupBy) ? req.query.groupBy : null;
    const anchor = ['highlight', 'missing', 'none'].includes(req.query.anchor) ? req.query.anchor : null;
    const filters = { search, level, cardType, origin, flagged, flagKind, source, tag, categoryId, anchor };
    const { cards, total, groups } = await Decks.searchCards({ ...filters, band, algorithm, groupBy, sortBy, sortDir, limit, offset });
    res.json({ cards, total, limit, offset, ...(groups ? { groups } : {}) });
}));

router.get('/cards/summary', catchError(async (req, res) => {
    const algorithm = ['leitner', 'sm2', 'fsrs'].includes(req.query.algorithm) ? req.query.algorithm : null;
    res.json(await Decks.catalogueSummary({ algorithm }));
}));

router.get('/:hash', catchError(async (req, res) => {
    res.json(await Decks.getDeck(req.params.hash, { algorithm: algorithmFrom(req.query) }));
}));

router.put('/:hash', catchError(async (req, res) => {
    const { name, description, color } = req.body;
    if (color !== undefined && color !== null && !isDeckColor(color)) {
        return res.status(400).json({ error: `Unknown deck colour: ${color}` });
    }
    await Decks.updateDeck(req.params.hash, { name, description, color });
    res.json({ ok: true });
}));

router.get('/:hash/cover', catchError(async (req, res) => {
    const { absPath, mime } = await Decks.coverImage(req.params.hash);
    res.type(mime).sendFile(absPath);
}));

router.post('/:hash/cover', (req, res, next) => coverUpload.single('file')(req, res, (err) => {
    if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Cover image too large' });
    return err ? next(err) : next();
}), catchError(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'file required' });
    if (!COVER_TYPES[req.file.mimetype]) return res.status(400).json({ error: `Unsupported cover type: ${req.file.mimetype}` });
    res.status(201).json({ cover: await Decks.uploadCover(req.params.hash, req.file.buffer, req.file.mimetype) });
}));

router.put('/:hash/cover', catchError(async (req, res) => {
    const { pattern, y } = req.body ?? {};
    if (pattern === undefined && y === undefined) return res.status(400).json({ error: 'pattern or y required' });
    res.json({ cover: await Decks.setCover(req.params.hash, pattern !== undefined ? { pattern } : { y }) });
}));

router.delete('/:hash/cover', catchError(async (req, res) => {
    await Decks.setCover(req.params.hash, null);
    res.json({ ok: true });
}));

router.delete('/:hash', catchError(async (req, res) => {
    await Decks.deleteDeck(req.params.hash);
    res.json({ ok: true });
}));

router.get('/:hash/contents', catchError(async (req, res) => {
    res.json(await Decks.getContentsSummary(req.params.hash));
}));

router.post('/:hash/purge', catchError(async (req, res) => {
    const includeShared = req.body?.includeShared === true;
    const { hash } = req.params;

    const { standalone, anchored, kept } = await Decks.getPurgeTargets(hash, { includeShared });

    for (const cardHash of standalone) {
        await Decks.deleteStandaloneCard(cardHash);
    }
    for (const { hash: cardHash, documentPath } of anchored) {
        await Decks.removeCardEverywhere(cardHash);
        await Documents.deleteFlashcard(documentPath, cardHash);
    }

    await Decks.deleteDeck(hash);
    res.json({ ok: true, deleted: standalone.length + anchored.length, kept });
}));

router.put('/:hash/tags', catchError(async (req, res) => {
    const tags = Array.isArray(req.body?.tags) ? req.body.tags : [];
    const saved = await Decks.setTags(req.params.hash, tags);
    res.json({ ok: true, tags: saved });
}));

router.post('/:hash/entries', catchError(async (req, res) => {
    const { cardHash, documentPath, inlineCard } = req.body;
    if (!cardHash) return res.status(400).json({ error: 'cardHash required' });
    await Decks.addEntry(req.params.hash, { cardHash, documentPath, inlineCard });
    res.status(201).json({ ok: true });
}));

router.delete('/:hash/entries/:cardHash', catchError(async (req, res) => {
    await Decks.removeEntry(req.params.hash, req.params.cardHash);
    res.json({ ok: true });
}));

export default router;
