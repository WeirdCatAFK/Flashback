import { Router } from 'express';
import query from '../access/Query.js';

const router = Router();

// GET /api/search?q=&tag=&deck=&document=&folder=&limit=
// Global mode (q only): returns { folders, documents, flashcards, tags, decks }
// Filter mode (tag/deck/document/folder): returns { flashcards } matching all filters
router.get('/', (req, res) => {
    const { q, tag, deck, document: docQ, folder } = req.query;
    const limit = Math.min(parseInt(req.query.limit ?? '20', 10), 100);
    const hasFilter = tag || deck || docQ || folder;

    if (!q && !hasFilter) {
        return res.status(400).json({ error: 'q or at least one filter required' });
    }

    const results = query.superSearch({
        q: q || null,
        tag: tag || null,
        deck: deck || null,
        document: docQ || null,
        folder: folder || null,
        limit,
    });

    res.json(results);
});

export default router;
