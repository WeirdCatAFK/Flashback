import { Router } from 'express';
import path from 'path';
import highlightsService from '../access/orchestration/highlights.js';

const router = Router();
const norm = (p) => p ? path.normalize(p) : p;
const catchError = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** One document's highlights. */
router.get('/', catchError((req, res) => {
    const relPath = norm(req.query.path);
    if (!relPath) return res.status(400).json({ error: 'path required' });
    const highlights = highlightsService.getHighlights(relPath);
    res.json({ highlights });
}));

/** Every highlight enriched with the context needed to act on it. */
router.get('/annotated', catchError(async (req, res) => {
    const relPath = norm(req.query.path) || null;
    const color = req.query.color || null;
    const uncardedOnly = req.query.uncarded === 'true' || req.query.uncarded === '1';
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const all = await highlightsService.listAnnotated({ path: relPath, color, uncardedOnly });
    res.json({ highlights: all.slice(0, limit), total: all.length });
}));

/** Creates a highlight and anchors it in the sidecar. */
router.post('/', catchError(async (req, res) => {
    const relPath = norm(req.body.path);
    if (!relPath) return res.status(400).json({ error: 'path required' });
    const highlight = await highlightsService.createHighlight(relPath, req.body);
    res.status(201).json({ ok: true, highlight });
}));

/** Updates a highlight's colour, note or anchor. */
router.put('/:hash', catchError(async (req, res) => {
    const relPath = norm(req.body.path);
    if (!relPath) return res.status(400).json({ error: 'path required' });
    const highlight = await highlightsService.updateHighlight(relPath, req.params.hash, req.body, { ifMatch: req.body.ifMatch });
    res.json({ ok: true, highlight });
}));

/** Deletes a highlight. */
router.delete('/:hash', catchError(async (req, res) => {
    const relPath = norm(req.query.path);
    if (!relPath) return res.status(400).json({ error: 'path required' });
    await highlightsService.deleteHighlight(relPath, req.params.hash);
    res.json({ ok: true });
}));

export default router;
