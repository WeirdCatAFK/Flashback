import { Router } from 'express';
import path from 'path';
import query from '../access/resources/query.js';
import { currentScope } from '../requestContext.js';

const router = Router();
const norm = (p) => p ? path.normalize(p) : p;

// GET /api/search?q=&tag=&deck=&document=&folder=&limit=
// Global mode (q only): returns { folders, documents, flashcards, tags, decks }
// Filter mode (tag/deck/document/folder): returns { flashcards } matching all filters
router.get('/', async (req, res) => {
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

    // Search hits carry each card's level, so the results are the CALLER's view of the
    // vault. This route reaches query.js directly rather than through an orchestrator, so
    // it is one of the few places that has to name the scope itself.
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
