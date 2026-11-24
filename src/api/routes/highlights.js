import { Router } from 'express';
import path from 'path';
import * as Highlights from '../access/modules/highlights.js';

const router = Router();
const norm = (p) => p ? path.normalize(p) : p;
const catchError = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.get('/', catchError((req, res) => {
    const relPath = norm(req.query.path);
    if (!relPath) return res.status(400).json({ error: 'path required' });
    const highlights = Highlights.getHighlights(relPath);
    res.json({ highlights });
}));

router.get('/annotated', catchError(async (req, res) => {
    const relPath = norm(req.query.path) || null;
    const color = req.query.color || null;
    const uncardedOnly = req.query.uncarded === 'true' || req.query.uncarded === '1';
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const all = await Highlights.listAnnotated({ path: relPath, color, uncardedOnly });
    res.json({ highlights: all.slice(0, limit), total: all.length });
}));

router.post('/', catchError(async (req, res) => {
    const relPath = norm(req.body.path);
    if (!relPath) return res.status(400).json({ error: 'path required' });
    const highlight = await Highlights.createHighlight(relPath, req.body);
    res.status(201).json({ ok: true, highlight });
}));

router.put('/:hash', catchError(async (req, res) => {
    const relPath = norm(req.body.path);
    if (!relPath) return res.status(400).json({ error: 'path required' });
    const highlight = await Highlights.updateHighlight(relPath, req.params.hash, req.body, { ifMatch: req.body.ifMatch });
    res.json({ ok: true, highlight });
}));

router.delete('/:hash', catchError(async (req, res) => {
    const relPath = norm(req.query.path);
    if (!relPath) return res.status(400).json({ error: 'path required' });
    await Highlights.deleteHighlight(relPath, req.params.hash);
    res.json({ ok: true });
}));

export default router;
