import { Router } from 'express';
import path from 'path';
import readProgress from '../access/orchestration/readProgress.js';

const router = Router();
const norm = (p) => (p ? path.normalize(p) : p);

const catchError = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch((err) => {
        if (err.status) return res.status(err.status).json({ error: err.message });
        next(err);
    });

/** Where the caller has read to in one document. */
router.get('/', catchError(async (req, res) => {
    const relPath = norm(req.query.path);
    if (!relPath) return res.status(400).json({ error: 'path required' });
    res.json(await readProgress.get(relPath));
}));

/** What the caller has started but not finished. */
router.get('/reading', catchError(async (req, res) => {
    res.json(await readProgress.listInProgress({
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        includeFinished: req.query.includeFinished === 'true',
    }));
}));

/** Every position the caller holds. */
router.get('/list', catchError(async (req, res) => {
    const folder = norm(req.query.folder) ?? '';
    const folders = [].concat(req.query.folders ?? []).map(norm).filter(Boolean);
    res.json(await readProgress.listForFolder(folder, { folders }));
}));

/** How much of a folder subtree the caller has read. */
router.get('/rollup', catchError(async (req, res) => {
    const relPath = norm(req.query.path) ?? '';
    res.json(await readProgress.folderRollup(relPath));
}));

/** Per-document read coverage under a folder. */
router.get('/coverage', catchError(async (req, res) => {
    const relPath = norm(req.query.path);
    if (!relPath) return res.status(400).json({ error: 'path required' });
    res.json(await readProgress.coverage(relPath));
}));

/** Records where the caller has read to. */
router.put('/', catchError(async (req, res) => {
    const relPath = norm(req.body.path);
    if (!relPath) return res.status(400).json({ error: 'path required' });
    const progress = await readProgress.set(relPath, {
        unit: req.body.unit,
        position: req.body.position,
        percent: req.body.percent,
        total: req.body.total,
        mode: req.body.mode,
    });
    res.json({ ok: true, progress });
}));

/** Forgets the caller's position in one document. */
router.delete('/', catchError(async (req, res) => {
    const relPath = norm(req.query.path);
    if (!relPath) return res.status(400).json({ error: 'path required' });
    await readProgress.clear(relPath);
    res.json({ ok: true });
}));

export default router;
