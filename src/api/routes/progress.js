import { Router } from 'express';
import path from 'path';
import readProgress from '../access/orchestration/readProgress.js';

// Read progress — where the caller has read to, and how far through a folder they are.
//
// Every endpoint here is about the CALLER's own reading, exactly as every endpoint under
// /api/srs is about the caller's own studying. None of them takes an account parameter and
// none can reach anyone else's positions, which is why the whole mount sits at READER in
// auth/permissions.js: recording where you got to is not an administrative act, and a Reader
// who could not record it could not resume anything.
//
// If cross-person visibility is ever wanted it belongs under /api/accounts, beside
// GET /api/accounts/:id/progress, where an actor and a target can be compared.
const router = Router();
const norm = (p) => (p ? path.normalize(p) : p);

// Access-layer errors carry an HTTP status (404 not indexed, 400 bad unit or mode,
// 409 no globalHash); anything else is a real fault and goes to the error handler.
const catchError = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch((err) => {
        if (err.status) return res.status(err.status).json({ error: err.message });
        next(err);
    });

// GET /api/progress?path=
// Where the caller has read to in one document, or null if they never opened it.
router.get('/', catchError(async (req, res) => {
    const relPath = norm(req.query.path);
    if (!relPath) return res.status(400).json({ error: 'path required' });
    res.json(await readProgress.get(relPath));
}));

// GET /api/progress/reading?limit=&includeFinished=
// What the caller is partway through, most recently touched first.
router.get('/reading', catchError(async (req, res) => {
    res.json(await readProgress.listInProgress({
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        includeFinished: req.query.includeFinished === 'true',
    }));
}));

// GET /api/progress/list?folder=&folders=a&folders=b
// One folder listing's worth of progress in a single call: documents keyed by globalHash,
// plus a subtree rollup for each subfolder named in `folders`. Mirrors listFolder's shape so
// the explorer renders a level at a time without a request per node.
router.get('/list', catchError(async (req, res) => {
    const folder = norm(req.query.folder) ?? '';
    const folders = [].concat(req.query.folders ?? []).map(norm).filter(Boolean);
    res.json(await readProgress.listForFolder(folder, { folders }));
}));

// GET /api/progress/rollup?path=
// How far through one folder the caller is, labelled with the magazine when that folder is a
// subscription's target.
router.get('/rollup', catchError(async (req, res) => {
    const relPath = norm(req.query.path) ?? '';
    res.json(await readProgress.folderRollup(relPath));
}));

// GET /api/progress/coverage?path=
// What the caller has read but has no flashcards for.
router.get('/coverage', catchError(async (req, res) => {
    const relPath = norm(req.query.path);
    if (!relPath) return res.status(400).json({ error: 'path required' });
    res.json(await readProgress.coverage(relPath));
}));

// PUT /api/progress
// Records a position. `mode: auto` never regresses the furthest mark; `mode: manual` may.
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

// DELETE /api/progress?path=
router.delete('/', catchError(async (req, res) => {
    const relPath = norm(req.query.path);
    if (!relPath) return res.status(400).json({ error: 'path required' });
    await readProgress.clear(relPath);
    res.json({ ok: true });
}));

export default router;
