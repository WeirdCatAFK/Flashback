import { Router } from 'express';
import path from 'path';
import * as ReadProgress from '../access/modules/readProgress.js';

const router = Router();
const norm = (p) => (p ? path.normalize(p) : p);

const catchError = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch((err) => {
        if (err.status) return res.status(err.status).json({ error: err.message });
        next(err);
    });

router.get('/', catchError(async (req, res) => {
    const relPath = norm(req.query.path);
    if (!relPath) return res.status(400).json({ error: 'path required' });
    res.json(await ReadProgress.get(relPath));
}));

router.get('/reading', catchError(async (req, res) => {
    res.json(await ReadProgress.listInProgress({
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        includeFinished: req.query.includeFinished === 'true',
    }));
}));

router.get('/list', catchError(async (req, res) => {
    const folder = norm(req.query.folder) ?? '';
    const folders = [].concat(req.query.folders ?? []).map(norm).filter(Boolean);
    res.json(await ReadProgress.listForFolder(folder, { folders }));
}));

router.get('/rollup', catchError(async (req, res) => {
    const relPath = norm(req.query.path) ?? '';
    res.json(await ReadProgress.folderRollup(relPath));
}));

router.get('/coverage', catchError(async (req, res) => {
    const relPath = norm(req.query.path);
    if (!relPath) return res.status(400).json({ error: 'path required' });
    res.json(await ReadProgress.coverage(relPath));
}));

router.put('/', catchError(async (req, res) => {
    const relPath = norm(req.body.path);
    if (!relPath) return res.status(400).json({ error: 'path required' });
    const progress = await ReadProgress.set(relPath, {
        unit: req.body.unit,
        position: req.body.position,
        percent: req.body.percent,
        total: req.body.total,
        mode: req.body.mode,
    });
    res.json({ ok: true, progress });
}));

router.delete('/', catchError(async (req, res) => {
    const relPath = norm(req.query.path);
    if (!relPath) return res.status(400).json({ error: 'path required' });
    await ReadProgress.clear(relPath);
    res.json({ ok: true });
}));

export default router;
