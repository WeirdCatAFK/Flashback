import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import Media from '../access/media.js';
import Documents from '../access/documents.js';

const router = Router();
const media = new Media();
const docs = new Documents();
const upload = multer({ storage: multer.memoryStorage() });

const norm = (p) => p ? path.normalize(p) : p;
const isNotFound = (err) => err.message?.toLowerCase().includes('not found');
const catchError = fn => (req, res, next) =>
    Promise.resolve().then(() => fn(req, res, next)).catch(err => {
        if (isNotFound(err)) return res.status(404).json({ error: err.message });
        next(err);
    });

// GET /api/media?hash=
router.get('/', catchError((req, res) => {
    const { hash } = req.query;
    if (!hash) return res.status(400).json({ error: 'hash required' });
    const entry = media.serve(hash);
    res.sendFile(entry.absolute_path);
}));

// GET /api/media/list?path=
router.get('/list', catchError((req, res) => {
    const folderPath = norm(req.query.path ?? '');
    res.json(media.list(folderPath));
}));

// GET /api/media/file?docPath=&name=
// Serves a flashcard media asset by its location relative to the owning
// document — vanilla cards store media as `./media/<name>` paths (not hashes),
// so this is how the renderer resolves them to a streamable URL.
router.get('/file', catchError((req, res) => {
    const docPath = norm(req.query.docPath);
    const { name } = req.query;
    if (!docPath || !name) return res.status(400).json({ error: 'docPath and name required' });
    res.sendFile(media.serveByPath(docPath, name));
}));

// Field → { type, position } mapping for the four vanilla media slots.
const VANILLA_MEDIA_FIELDS = {
    front_img:   { type: 'image', position: 'front' },
    back_img:    { type: 'image', position: 'back'  },
    front_sound: { type: 'sound', position: 'front' },
    back_sound:  { type: 'sound', position: 'back'  },
};

const vanillaUpload = upload.fields([
    { name: 'file',       maxCount: 1 }, // legacy attach-to-existing-card slot
    ...Object.keys(VANILLA_MEDIA_FIELDS).map((name) => ({ name, maxCount: 1 })),
]);

// POST /api/media/vanilla
// Two modes on one endpoint:
//   • Create:  body { docPath, card: <JSON> } + optional file fields
//              front_img | back_img | front_sound | back_sound.
//              Creates the card and attaches media in one call → { ok, card }.
//   • Attach:  multipart `file` + body { docPath, flashcardHash, name, type, position }
//              attaches one media file to an already-existing card (legacy).
router.post('/vanilla', vanillaUpload, catchError(async (req, res) => {
    const files = req.files || {};
    const { docPath } = req.body;
    if (!docPath) return res.status(400).json({ error: 'docPath required' });

    // --- Create mode ---
    if (req.body.card != null) {
        let cardData;
        try { cardData = JSON.parse(req.body.card); }
        catch { return res.status(400).json({ error: 'card must be valid JSON' }); }

        const mediaItems = [];
        for (const [field, meta] of Object.entries(VANILLA_MEDIA_FIELDS)) {
            const f = files[field]?.[0];
            if (f) mediaItems.push({ buffer: f.buffer, originalName: f.originalname, ...meta });
        }

        const card = await docs.createFlashcard(norm(docPath), cardData, mediaItems);
        return res.status(201).json({ ok: true, card });
    }

    // --- Attach mode (existing card) ---
    const { flashcardHash, name, type, position } = req.body;
    const file = files.file?.[0];
    if (!file || !flashcardHash || !name || !type || !position) {
        return res.status(400).json({ error: 'file, docPath, flashcardHash, name, type, and position required' });
    }
    await media.addVanillaMedia(norm(docPath), flashcardHash, file.buffer, name, type, position);
    res.status(201).json({ ok: true });
}));

// POST /api/media/custom
// Multipart: file field + body { docPath, flashcardHash, name }
router.post('/custom', upload.single('file'), catchError(async (req, res) => {
    const { docPath, flashcardHash, name } = req.body;
    if (!req.file || !docPath || !flashcardHash || !name) {
        return res.status(400).json({ error: 'file, docPath, flashcardHash, and name required' });
    }
    await docs.addMediaToFlashcard(norm(docPath), flashcardHash, req.file.buffer, name);
    res.status(201).json({ ok: true });
}));

// DELETE /api/media
// Body: { docPath, mediaName }
router.delete('/', catchError(async (req, res) => {
    const { docPath, mediaName } = req.body;
    if (!docPath || !mediaName) return res.status(400).json({ error: 'docPath and mediaName required' });
    await media.removeMedia(norm(docPath), mediaName);
    res.json({ ok: true });
}));

// POST /api/media/reconcile
// Body: { folderPath }
router.post('/reconcile', catchError((req, res) => {
    const folderPath = norm(req.body.folderPath ?? '');
    const orphans = media.reconcile(folderPath);
    res.json({ removed: orphans.length, orphans });
}));

export default router;
