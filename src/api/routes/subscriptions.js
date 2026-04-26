import { Router } from 'express';
import multer from 'multer';
import Subscriptions from '../access/subscriptions.js';
import query from '../access/query.js';

const router = Router();
const subs = new Subscriptions();
const upload = multer({ storage: multer.memoryStorage() });

// POST /api/subscriptions/import
// Multipart: file field (the issue zip) + body { magazineId, targetPath? }
// Imports and merges a magazine issue into the local workspace.
router.post('/import', upload.single('file'), async (req, res) => {
    const { magazineId, targetPath = '' } = req.body;
    if (!req.file || !magazineId) {
        return res.status(400).json({ error: 'file and magazineId required' });
    }
    await subs.importIssue(magazineId, req.file.buffer, targetPath);
    res.status(201).json({ ok: true });
});

// GET /api/subscriptions/:magazineId
// Returns the stored subscription record for a magazine, or 404 if not subscribed.
router.get('/:magazineId', (req, res) => {
    const sub = query.getSubscription(req.params.magazineId);
    if (!sub) return res.status(404).json({ error: 'Subscription not found' });
    res.json(sub);
});

export default router;
