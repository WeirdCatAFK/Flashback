import { Router } from 'express';
import { sealTools } from '../seal/seal.js';

const router = Router();

// GET /api/seal/log?limit=20
// Returns recent Seal commits in reverse chronological order.
router.get('/log', async (req, res) => {
    const limit = parseInt(req.query.limit, 10) || 20;
    const log = await sealTools.log(limit);
    res.json(log);
});

// GET /api/seal/inspect
// Compares the workspace against HEAD and returns any uncommitted sidecar changes.
router.get('/inspect', async (req, res) => {
    const diff = await sealTools.inspect();
    res.json(diff);
});

// POST /api/seal/rollback
// Body: { ref, keepSrsProgress? }
// Rolls the canonical layer back to the given commit ref.
// keepSrsProgress=true (default) snapshots SRS state before checkout and restores it after.
// After rollback the caller should call GET /api/seal/inspect to reconcile the derived layer.
router.post('/rollback', async (req, res) => {
    const { ref, keepSrsProgress = true } = req.body;
    if (!ref) return res.status(400).json({ error: 'ref required' });
    await sealTools.rollback(ref, keepSrsProgress);
    res.json({ ok: true });
});

export default router;
