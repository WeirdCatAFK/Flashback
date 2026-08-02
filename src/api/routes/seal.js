import { Router } from 'express';
import { sealTools } from '../seal/seal.js';

const router = Router();
const catchError = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// GET /api/seal/log?limit=20&cursor=<oid>
// Returns a page of commits, newest first. `cursor` is the oid of the last commit the
// caller already has; the page resumes after it. A page shorter than `limit` means the
// history ended. Capped because every commit in a page costs a tree diff.
const MAX_LOG_LIMIT = 200;
router.get('/log', catchError(async (req, res) => {
    const requested = parseInt(req.query.limit, 10) || 20;
    const limit = Math.min(Math.max(requested, 1), MAX_LOG_LIMIT);
    const cursor = req.query.cursor || null;
    const log = await sealTools.log(limit, cursor);
    res.json(log);
}));

// GET /api/seal/inspect
router.get('/inspect', catchError(async (req, res) => {
    const diff = await sealTools.inspect();
    res.json(diff);
}));

// GET /api/seal/commit/:oid/files
router.get('/commit/:oid/files', catchError(async (req, res) => {
    const files = await sealTools.commitFiles(req.params.oid);
    res.json(files);
}));

// POST /api/seal/rollback
// Body: { ref, keepSrsProgress? }
router.post('/rollback', catchError(async (req, res) => {
    const { ref, keepSrsProgress = true } = req.body;
    if (!ref) return res.status(400).json({ error: 'ref required' });
    await sealTools.rollback(ref, keepSrsProgress);
    res.json({ ok: true });
}));

export default router;
