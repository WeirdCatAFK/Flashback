import { Router } from 'express';
import path from 'path';
import query from '../access/resources/query.js';
import { currentScope } from '../requestContext.js';

const router = Router();
const norm = (p) => p ? path.normalize(p) : p;

/** Unified search across folders, documents, cards, tags and decks. */
router.get('/', async (req, res) => {
    const { q, tag, deck } = req.query;
    const docQ = norm(req.query.document);
    const folder = norm(req.query.folder);
    const limit = Math.min(parseInt(req.query.limit ?? '20', 10), 100);
    const hasFilter = tag || deck || docQ || folder;

    if (!q && !hasFilter) {
        return res.status(400).json({ error: 'q or at least one filter required' });
    }

    const results = await query.superSearch({
        q: q || null,
        tag: tag || null,
        deck: deck || null,
        document: docQ || null,
        folder: folder || null,
        limit,
    }, currentScope());

    res.json(results);
});

export default router;
