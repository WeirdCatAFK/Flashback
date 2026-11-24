import { Router } from 'express';
import multer from 'multer';
import * as Subscriptions from '../access/modules/subscriptions.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fieldNestingDepth: 0 } });
const catchError = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.post('/import', upload.single('file'), catchError(async (req, res) => {
    const { magazineId, targetPath = '' } = req.body;
    if (!req.file || !magazineId) {
        return res.status(400).json({ error: 'file and magazineId required' });
    }
    await Subscriptions.importIssue(magazineId, req.file.buffer, targetPath);
    res.status(201).json({ ok: true });
}));

router.get('/:magazineId', catchError(async (req, res) => {
    const sub = await Subscriptions.get(req.params.magazineId);
    if (!sub) return res.status(404).json({ error: 'Subscription not found' });
    res.json(sub);
}));

export default router;
