import { Router } from 'express';
import diary from '../access/diary.js';
import { getMcpDiaryAccess } from '../access/config.js';

const router = Router();
const catchError = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// The diary is opt-in on the client (a localStorage preference). The server does
// not gate on that flag — it simply never creates diary/ until a write endpoint is
// called, which only happens when the feature is enabled. See src/api/access/diary.js.

// Privacy gate for AI assistants. The MCP server (a separate process) tags every
// request with `X-Flashback-Client: mcp`; the diary holds personal reflections, so
// the whole namespace is closed to MCP unless the user opted in (config.json
// `mcpDiaryAccess`, toggled in Config → AI Assistant). The React renderer sends no
// such header, so the in-app Diary view is never affected. This is real server-side
// enforcement for our MCP server, not client-side self-censoring.
router.use((req, res, next) => {
    if (req.get('X-Flashback-Client') === 'mcp' && !getMcpDiaryAccess()) {
        return res.status(403).json({
            error: 'Diary access for AI assistants is disabled. Enable it in Flashback → Config → AI Assistant.',
        });
    }
    next();
});

// POST /api/diary/summary
// Body: { date? }  (defaults to today, UTC)
// Regenerates (cumulative, idempotent) the day's summary from ReviewLogs. Called by
// the client when a study session completes. Returns { ok, summary } — summary is
// null when the day had no real reviews (nothing written).
router.post('/summary', catchError(async (req, res) => {
    const date = req.body?.date;
    if (date != null && !DATE_RE.test(date)) {
        return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    }
    const summary = await diary.generateSummary(date || undefined);
    res.json({ ok: true, summary });
}));

// POST /api/diary/rebuild
// Re-derives every summary from ReviewLogs. Idempotent. Returns { ok, count }.
router.post('/rebuild', catchError(async (req, res) => {
    const count = await diary.rebuildAll();
    res.json({ ok: true, count });
}));

// GET /api/diary?from=YYYY-MM-DD&to=YYYY-MM-DD
// Date-descending list of days that have a summary and/or entry.
router.get('/', catchError((req, res) => {
    const from = req.query.from && DATE_RE.test(req.query.from) ? req.query.from : null;
    const to = req.query.to && DATE_RE.test(req.query.to) ? req.query.to : null;
    res.json(diary.list({ from, to }));
}));

// GET /api/diary/summary/:date  → the rendered-from-JSON summary, or 404.
router.get('/summary/:date', catchError((req, res) => {
    const { date } = req.params;
    if (!DATE_RE.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    const summary = diary.getSummary(date);
    if (!summary) return res.status(404).json({ error: 'no summary for that date' });
    res.json(summary);
}));

// GET /api/diary/entry/:date  → { date, content } (content '' when no entry exists).
router.get('/entry/:date', catchError((req, res) => {
    const { date } = req.params;
    if (!DATE_RE.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    res.json({ date, content: diary.getEntry(date) ?? '' });
}));

// PUT /api/diary/entry/:date
// Body: { content }  — saves the user's markdown reflection (lazy: empty content for
// a date with no existing entry is a no-op). Returns { ok, created, empty }.
router.put('/entry/:date', catchError(async (req, res) => {
    const { date } = req.params;
    if (!DATE_RE.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    const result = await diary.saveEntry(date, String(req.body?.content ?? ''));
    res.json({ ok: true, ...result });
}));

export default router;
