import { Router } from 'express';
import path from 'path';
import reader from '../access/orchestration/mcpReader.js';
import readProgress from '../access/orchestration/readProgress.js';

// Paginated, read-only text extraction for documents whose bodies are not decodable
// text — PDF, EPUB, saved web clips — plus char-window reads of ordinary text files,
// and the media those documents carry (an EPUB's figures, a clip's downloaded
// pictures and sound). Built for the MCP server (which has no renderer), though the
// route is not gated to it; the media half has two clients from the start, the card
// form's pickers and the MCP server.
// See src/api/access/orchestration/mcpReader.js for the addressing model.
const router = Router();
const norm = (p) => (p ? path.normalize(p) : p);

// Errors from the access layer carry an HTTP status (404 missing, 415 no text,
// 400 bad addressing); anything else is a real fault and goes to the error handler.
const catchError = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch((err) => {
        if (err.status) return res.status(err.status).json({ error: err.message });
        next(err);
    });

// GET /api/reader/info?path=
// What the document is and how much of it there is: { format, unit, total, extractable }.
router.get('/info', catchError(async (req, res) => {
    const relPath = norm(req.query.path);
    if (!relPath) return res.status(400).json({ error: 'path required' });
    res.json(await reader.info(relPath));
}));

// GET /api/reader/read?path=&index=&count=&offset=&limit=&charOffset=&at=&upTo=
// One window of text. index/count address pages and sections (1-based); offset/limit
// address character windows in text formats; at=<seconds> jumps to a YouTube
// transcript moment.
//
// upTo=progress clamps the window to the caller's own furthest reading position, which is
// what makes "make cards for everything I've read" a well-formed request: the assistant
// cannot be handed a page past the mark. Composed HERE rather than inside mcpReader, which
// ACCESS.md forbids from importing anything but files.js — the same reason routes/srs.js
// composes the sequencer instead of folding it into the scheduler.
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
        bound = await readProgress.readingBound(relPath, { readerInfo: await reader.info(relPath) });
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
            // `at` addresses by time and would jump straight past the mark.
            if (opts.at != null) delete opts.at;
        }
    }

    const data = await reader.read(relPath, opts);
    if (bound) {
        data.boundedBy = bound;
        // Past the mark there is no more to read, whatever the document's real length says.
        const reached = bound.maxOffset != null
            ? (data.index + data.text.length) >= bound.maxOffset
            : (data.index + (Number(opts.count ?? 1) - 1)) >= bound.maxIndex;
        if (reached && !data.truncated) { data.hasMore = false; data.next = null; }
    }
    res.json(data);
}));

// GET /api/reader/images?path=
// Every image an EPUB declares, in reading order, as metadata only:
// { href, name, mediaType, bytes, alt, caption, section, sectionIndex, isCover }.
router.get('/images', catchError(async (req, res) => {
    const relPath = norm(req.query.path);
    if (!relPath) return res.status(400).json({ error: 'path required' });
    res.json(await reader.images(relPath));
}));

// GET /api/reader/image?path=&href=
// One image's bytes. Loaded by <img> in the book-image picker, which cannot set an
// Authorization header — it authenticates with the ?token= query param api.js accepts
// for exactly these browser-initiated loads. `href` must be one the manifest declares
// (see mcpReader.imageBuffer); anything else is a 400, not a file read.
router.get('/image', catchError(async (req, res) => {
    const relPath = norm(req.query.path);
    const { href } = req.query;
    if (!relPath || !href) return res.status(400).json({ error: 'path and href required' });
    const { buffer, mediaType, name } = await reader.imageBuffer(relPath, href);
    res.type(mediaType || 'application/octet-stream');
    // The bytes cannot change without the file changing, and the picker re-requests
    // every thumbnail on each open. Private: this is vault content.
    res.set('Cache-Control', 'private, max-age=3600');
    res.set('Content-Disposition', `inline; filename="${encodeURIComponent(name)}"`);
    res.send(buffer);
}));

// GET /api/reader/media?path=
// Every asset a document carries, whatever kind of document it is: an EPUB's figures
// or a saved clip's downloaded pictures and sound. Metadata only, each entry tagged
// with `kind` ("image" | "audio"). Clip entries add `cached` and a real `path`;
// EPUB entries add `section`/`sectionIndex`/`isCover`.
router.get('/media', catchError(async (req, res) => {
    const relPath = norm(req.query.path);
    if (!relPath) return res.status(400).json({ error: 'path required' });
    res.json(await reader.media(relPath));
}));

// GET /api/reader/media-file?path=&href=
// One asset's bytes — the general form of /image, and the endpoint an <audio src>
// points at. Same browser-load authentication story as /image (the ?token= query
// param, since neither <img> nor <audio> can set an Authorization header) and the
// same allow-list: `href` must be one the document declares, or it is a 400.
router.get('/media-file', catchError(async (req, res) => {
    const relPath = norm(req.query.path);
    const { href } = req.query;
    if (!relPath || !href) return res.status(400).json({ error: 'path and href required' });
    const { buffer, mediaType, name } = await reader.mediaBuffer(relPath, href);
    res.type(mediaType || 'application/octet-stream');
    res.set('Cache-Control', 'private, max-age=3600');
    res.set('Content-Disposition', `inline; filename="${encodeURIComponent(name)}"`);
    res.send(buffer);
}));

export default router;
