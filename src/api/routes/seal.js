import { Router } from 'express';
import { sealTools } from '../seal/seal.js';

const router = Router();
const catchError = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const MAX_LOG_LIMIT = 200;
/** The workspace's commit history. */
router.get('/log', catchError(async (req, res) => {
    const requested = parseInt(req.query.limit, 10) || 20;
    const limit = Math.min(Math.max(requested, 1), MAX_LOG_LIMIT);
    const cursor = req.query.cursor || null;
    const log = await sealTools.log(limit, cursor);
    res.json(log);
}));

/** Working-tree drift against the last commit. */
router.get('/inspect', catchError(async (req, res) => {
    const diff = await sealTools.inspect();
    res.json(diff);
}));

/** Which files one commit touched. */
router.get('/commit/:oid/files', catchError(async (req, res) => {
    const files = await sealTools.commitFiles(req.params.oid);
    res.json(files);
}));

/** Rewinds the workspace to a commit, preserving SRS progress by default. */
router.post('/rollback', catchError(async (req, res) => {
    const { ref, keepSrsProgress = true } = req.body;
    if (!ref) return res.status(400).json({ error: 'ref required' });
    await sealTools.rollback(ref, keepSrsProgress);
    res.json({ ok: true });
}));

export default router;
