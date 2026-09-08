import { Router } from 'express';
import Doctor from '../access/orchestration/doctor.js';

const router = Router();
const doctor = new Doctor();
const catchError = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Reports drift between the canonical files and the derived index; changes nothing. */
router.get('/check', catchError(async (req, res) => {
    res.json(await doctor.checkIndex());
}));

/** Repairs the index against the canonical files. */
router.post('/sync', catchError(async (req, res) => {
    const { sealDrift = true } = req.body ?? {};
    const result = await doctor.syncIndex({ sealDrift });
    res.json({ ok: true, ...result });
}));

/** Rebuilds the derived index from the canonical files, losing review history. */
router.post('/rebuild', catchError(async (req, res) => {
    if (req.body?.confirm !== 'REBUILD') {
        return res.status(400).json({ error: "Rebuild requires body { confirm: 'REBUILD' }" });
    }
    const result = await doctor.rebuildIndex();
    res.json({ ok: true, ...result });
}));

export default router;
