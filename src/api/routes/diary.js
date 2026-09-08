import { Router } from 'express';
import diary from '../access/orchestration/diary.js';
import { getMcpDiaryAccess } from '../access/primitives/config.js';
import { normalizePath } from '../auth/permissions.js';

const router = Router();
const catchError = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

router.use((req, res, next) => {
    if (req.get('X-Flashback-Client') !== 'mcp') return next();
    const access = getMcpDiaryAccess();
    if (access === 'none') {
        return res.status(403).json({
            error: 'Diary access for AI assistants is disabled. Enable it in Flashback → Config → AI Assistant.',
        });
    }
    if (access === 'summaries' && normalizePath(req.path).startsWith('/entry')) {
        return res.status(403).json({
            error: 'AI assistants can read your daily summaries but not your written diary entries. Change this in Flashback → Config → AI Assistant.',
        });
    }
    next();
});

/** Derives the caller's daily summary from their review logs; idempotent. */
router.post('/summary', catchError(async (req, res) => {
    const date = req.body?.date;
    if (date != null && !DATE_RE.test(date)) {
        return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    }
    const summary = await diary.generateSummary(date || undefined);
    res.json({ ok: true, summary });
}));

/** Re-derives a range of daily summaries. */
router.post('/rebuild', catchError(async (req, res) => {
    const count = await diary.rebuildAll();
    res.json({ ok: true, count });
}));

/** The caller's diary days, newest first. */
router.get('/', catchError(async (req, res) => {
    const from = req.query.from && DATE_RE.test(req.query.from) ? req.query.from : null;
    const to = req.query.to && DATE_RE.test(req.query.to) ? req.query.to : null;
    res.json(await diary.list({ from, to }));
}));

/** One day's derived study summary. */
router.get('/summary/:date', catchError((req, res) => {
    const { date } = req.params;
    if (!DATE_RE.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    const summary = diary.getSummary(date);
    if (!summary) return res.status(404).json({ error: 'no summary for that date' });
    res.json(summary);
}));

/** One day's written entry. */
router.get('/entry/:date', catchError((req, res) => {
    const { date } = req.params;
    if (!DATE_RE.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    res.json({ date, content: diary.getEntry(date) ?? '' });
}));

/** Writes one day's entry. */
router.put('/entry/:date', catchError(async (req, res) => {
    const { date } = req.params;
    if (!DATE_RE.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    const result = await diary.saveEntry(date, String(req.body?.content ?? ''));
    res.json({ ok: true, ...result });
}));

export default router;
