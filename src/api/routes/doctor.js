import { Router } from 'express';
import Doctor from '../access/doctor.js';

const router = Router();
const doctor = new Doctor();
const catchError = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// GET /api/doctor/check — read-only whole-vault consistency report
router.get('/check', catchError(async (req, res) => {
    res.json(await doctor.checkIndex());
}));

// POST /api/doctor/sync
// Body: { sealDrift?: boolean } — apply the check report (disk is truth)
router.post('/sync', catchError(async (req, res) => {
    const { sealDrift = true } = req.body ?? {};
    const result = await doctor.syncIndex({ sealDrift });
    res.json({ ok: true, ...result });
}));

// POST /api/doctor/rebuild
// Body: { confirm: 'REBUILD' } — wipe the index and re-index the canonical layer.
// Destructive to ReviewLogs history; the exact confirm token is required.
router.post('/rebuild', catchError(async (req, res) => {
    if (req.body?.confirm !== 'REBUILD') {
        return res.status(400).json({ error: "Rebuild requires body { confirm: 'REBUILD' }" });
    }
    const result = await doctor.rebuildIndex();
    res.json({ ok: true, ...result });
}));

export default router;
