import { Router } from 'express';
import path from 'path';
import query from '../access/query.js';

const router = Router();
const norm = (p) => p ? path.normalize(p) : p;

// GET /api/search?q=&tag=&deck=&document=&folder=&limit=
// Global mode (q only): returns { folders, documents, flashcards, tags, decks }
// Filter mode (tag/deck/document/folder): returns { flashcards } matching all filters
router.get('/', (req, res) => {
    const { q, tag, deck } = req.query;
    // document/folder are path-shaped — normalize like every other route does
    // (documents.js's create/read routes all norm() their path params), otherwise
    // a POSIX-style path from a non-Windows-aware caller (an MCP tool, a script)
    // silently matches nothing against the backslash-separated paths stored in the DB.
    const docQ = norm(req.query.document);
    const folder = norm(req.query.folder);
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
