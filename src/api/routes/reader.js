import { Router } from 'express';
import path from 'path';
import * as McpReader from '../access/modules/mcpReader.js';
import * as ReadProgress from '../access/modules/readProgress.js';

const router = Router();
const norm = (p) => (p ? path.normalize(p) : p);

const catchError = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch((err) => {
        if (err.status) return res.status(err.status).json({ error: err.message });
        next(err);
    });

router.get('/info', catchError(async (req, res) => {
    const relPath = norm(req.query.path);
    if (!relPath) return res.status(400).json({ error: 'path required' });
    res.json(await McpReader.info(relPath));
}));

router.get('/read', catchError(async (req, res) => {
    const relPath = norm(req.query.path);
    if (!relPath) return res.status(400).json({ error: 'path required' });

    const opts = {
        index: req.query.index,
        count: req.query.count,
        offset: req.query.offset,
        limit: req.query.limit,
        charOffset: req.query.charOffset,
        at: req.query.at,
    };

    let bound = null;
    if (req.query.upTo === 'progress') {
        bound = await ReadProgress.readingBound(relPath, { readerInfo: await McpReader.info(relPath) });
        if (bound.maxOffset != null) {
            const from = Number(opts.offset ?? 0);
            if (from >= bound.maxOffset) {
                return res.status(400).json({
                    error: `You have only read to character ${bound.maxOffset} of ${relPath}.`,
                    code: 'past_progress', bound,
                });
            }
            const want = opts.limit != null ? Number(opts.limit) : (bound.maxOffset - from);
            opts.limit = Math.min(want, bound.maxOffset - from);
        } else if (bound.maxIndex != null) {
            const from = Number(opts.index ?? 1);
            if (from > bound.maxIndex) {
                return res.status(400).json({
                    error: `You have only read to ${bound.unit} ${bound.maxIndex} of ${relPath}.`,
                    code: 'past_progress', bound,
                });
            }
            opts.count = Math.min(Number(opts.count ?? 1), bound.maxIndex - from + 1);
            if (opts.at != null) delete opts.at;
        }
    }

    const data = await McpReader.read(relPath, opts);
    if (bound) {
        data.boundedBy = bound;
        const reached = bound.maxOffset != null
            ? (data.index + data.text.length) >= bound.maxOffset
            : (data.index + (Number(opts.count ?? 1) - 1)) >= bound.maxIndex;
        if (reached && !data.truncated) { data.hasMore = false; data.next = null; }
    }
    res.json(data);
}));

router.get('/images', catchError(async (req, res) => {
    const relPath = norm(req.query.path);
    if (!relPath) return res.status(400).json({ error: 'path required' });
    res.json(await McpReader.images(relPath));
}));

router.get('/image', catchError(async (req, res) => {
    const relPath = norm(req.query.path);
    const { href } = req.query;
    if (!relPath || !href) return res.status(400).json({ error: 'path and href required' });
    const { buffer, mediaType, name } = await McpReader.imageBuffer(relPath, href);
    res.type(mediaType || 'application/octet-stream');
    res.set('Cache-Control', 'private, max-age=3600');
    res.set('Content-Disposition', `inline; filename="${encodeURIComponent(name)}"`);
    res.send(buffer);
}));

router.get('/media', catchError(async (req, res) => {
    const relPath = norm(req.query.path);
    if (!relPath) return res.status(400).json({ error: 'path required' });
    res.json(await McpReader.media(relPath));
}));

router.get('/media-file', catchError(async (req, res) => {
    const relPath = norm(req.query.path);
    const { href } = req.query;
    if (!relPath || !href) return res.status(400).json({ error: 'path and href required' });
    const { buffer, mediaType, name } = await McpReader.mediaBuffer(relPath, href);
    res.type(mediaType || 'application/octet-stream');
    res.set('Cache-Control', 'private, max-age=3600');
    res.set('Content-Disposition', `inline; filename="${encodeURIComponent(name)}"`);
    res.send(buffer);
}));

export default router;
