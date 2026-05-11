import { Router } from 'express';
import { sealTools } from '../seal/seal.js';

const router = Router();
const catchError = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// GET /api/seal/log?limit=20
router.get('/log', catchError(async (req, res) => {
    const limit = parseInt(req.query.limit, 10) || 20;
    const log = await sealTools.log(limit);
    res.json(log);
}));

// GET /api/seal/inspect
router.get('/inspect', catchError(async (req, res) => {
    const diff = await sealTools.inspect();
    res.json(diff);
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
