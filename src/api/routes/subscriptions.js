import { Router } from 'express';
import multer from 'multer';
import Subscriptions from '../access/orchestration/subscriptions.js';
import query from '../access/resources/query.js';

const router = Router();
const subs = new Subscriptions();
const upload = multer({ storage: multer.memoryStorage() });
const catchError = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Imports a magazine or course issue, merging it into the subscription. */
router.post('/import', upload.single('file'), catchError(async (req, res) => {
    const { magazineId, targetPath = '' } = req.body;
    if (!req.file || !magazineId) {
        return res.status(400).json({ error: 'file and magazineId required' });
    }
    await subs.importIssue(magazineId, req.file.buffer, targetPath);
    res.status(201).json({ ok: true });
}));

/** One subscription's tracked issues. */
router.get('/:magazineId', catchError(async (req, res) => {
    const sub = await query.getSubscription(req.params.magazineId);
    if (!sub) return res.status(404).json({ error: 'Subscription not found' });
    res.json(sub);
}));

export default router;
