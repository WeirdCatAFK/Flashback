import { Router } from 'express';
import path from 'path';
import highlightsService from '../access/highlights.js';

const router = Router();
const norm = (p) => p ? path.normalize(p) : p;
const catchError = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// GET /api/highlights?path=<relPath>
router.get('/', catchError((req, res) => {
    const relPath = norm(req.query.path);
    if (!relPath) return res.status(400).json({ error: 'path required' });
    const highlights = highlightsService.getHighlights(relPath);
    res.json({ highlights });
}));

// GET /api/highlights/annotated?path=&color=&uncarded=&limit=
// Highlights enriched with highlighted text, surrounding document context, and
// the flashcards already anchored to each one. Vault-wide when path is omitted.
router.get('/annotated', catchError((req, res) => {
    const relPath = norm(req.query.path) || null;
    const color = req.query.color || null;
    const uncardedOnly = req.query.uncarded === 'true' || req.query.uncarded === '1';
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const all = highlightsService.listAnnotated({ path: relPath, color, uncardedOnly });
    res.json({ highlights: all.slice(0, limit), total: all.length });
}));

// POST /api/highlights
// Body: { path, type, start, end, page, bbox, color, note }
router.post('/', catchError((req, res) => {
    const relPath = norm(req.body.path);
    if (!relPath) return res.status(400).json({ error: 'path required' });
    const highlight = highlightsService.createHighlight(relPath, req.body);
    res.status(201).json({ ok: true, highlight });
}));

// PUT /api/highlights/:hash
// Body: { path, color, note }
router.put('/:hash', catchError((req, res) => {
    const relPath = norm(req.body.path);
    if (!relPath) return res.status(400).json({ error: 'path required' });
    const highlight = highlightsService.updateHighlight(relPath, req.params.hash, req.body);
    res.json({ ok: true, highlight });
}));

// DELETE /api/highlights/:hash?path=<relPath>
router.delete('/:hash', catchError((req, res) => {
    const relPath = norm(req.query.path);
    if (!relPath) return res.status(400).json({ error: 'path required' });
    highlightsService.deleteHighlight(relPath, req.params.hash);
    res.json({ ok: true });
}));

export default router;
