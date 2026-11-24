import { Router } from 'express';
import * as Doctor from '../access/modules/doctor.js';

const router = Router();
const catchError = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.get('/check', catchError(async (req, res) => {
    res.json(await Doctor.checkIndex());
}));

router.post('/sync', catchError(async (req, res) => {
    const { sealDrift = true } = req.body ?? {};
    const result = await Doctor.syncIndex({ sealDrift });
    res.json({ ok: true, ...result });
}));

router.post('/rebuild', catchError(async (req, res) => {
    if (req.body?.confirm !== 'REBUILD') {
        return res.status(400).json({ error: "Rebuild requires body { confirm: 'REBUILD' }" });
    }
    const result = await Doctor.rebuildIndex();
    res.json({ ok: true, ...result });
}));

export default router;
