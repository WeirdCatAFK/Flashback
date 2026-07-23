import { Router } from 'express';
import path from 'path';
import reader from '../access/mcpReader.js';

// Paginated, read-only text extraction for documents whose bodies are not decodable
// text — PDF, EPUB, saved web clips — plus char-window reads of ordinary text files.
// Built for the MCP server (which has no renderer and cannot receive bytes); the
// route is not gated to it, so an in-app "search inside this PDF" could reuse it.
// See src/api/access/mcpReader.js for the addressing model.
const router = Router();
const norm = (p) => (p ? path.normalize(p) : p);

// Errors from the access layer carry an HTTP status (404 missing, 415 no text,
// 400 bad addressing); anything else is a real fault and goes to the error handler.
const catchError = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch((err) => {
        if (err.status) return res.status(err.status).json({ error: err.message });
        next(err);
    });

// GET /api/reader/info?path=
// What the document is and how much of it there is: { format, unit, total, extractable }.
router.get('/info', catchError(async (req, res) => {
    const relPath = norm(req.query.path);
    if (!relPath) return res.status(400).json({ error: 'path required' });
    res.json(await reader.info(relPath));
}));

// GET /api/reader/read?path=&index=&count=&offset=&limit=&charOffset=&at=
// One window of text. index/count address pages and sections (1-based); offset/limit
// address character windows in text formats; at=<seconds> jumps to a YouTube
// transcript moment.
router.get('/read', catchError(async (req, res) => {
    const relPath = norm(req.query.path);
    if (!relPath) return res.status(400).json({ error: 'path required' });
    res.json(await reader.read(relPath, {
        index: req.query.index,
        count: req.query.count,
        offset: req.query.offset,
        limit: req.query.limit,
        charOffset: req.query.charOffset,
        at: req.query.at,
    }));
}));

export default router;
