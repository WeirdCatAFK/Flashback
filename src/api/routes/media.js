import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import * as Media from '../access/modules/media.js';
import * as Documents from '../access/modules/documents.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

const norm = (p) => p ? path.normalize(p) : p;
const isNotFound = (err) => err.message?.toLowerCase().includes('not found');
const catchError = fn => (req, res, next) =>
    Promise.resolve().then(() => fn(req, res, next)).catch(err => {
        if (isNotFound(err)) return res.status(404).json({ error: err.message });
        if (err.message?.startsWith('Unknown category')) return res.status(400).json({ error: err.message });
        if (err.message?.startsWith('Invalid media name')) return res.status(400).json({ error: err.message });
        next(err);
    });

router.get('/', catchError(async (req, res) => {
    const { hash } = req.query;
    if (!hash) return res.status(400).json({ error: 'hash required' });
    const entry = await Media.serve(hash);
    res.sendFile(entry.absolute_path);
}));

router.get('/list', catchError(async (req, res) => {
    const folderPath = norm(req.query.path ?? '');
    const items = await Media.list(folderPath);
    // eslint-disable-next-line no-unused-vars
    res.json(items.map(({ absolutePath, ...rest }) => rest));
}));

router.get('/file', catchError((req, res) => {
    const docPath = norm(req.query.docPath);
    const { name } = req.query;
    if (!docPath || !name) return res.status(400).json({ error: 'docPath and name required' });
    res.sendFile(Media.serveByPath(docPath, name));
}));

const VANILLA_MEDIA_FIELDS = {
    front_img:   { type: 'image', position: 'front' },
    back_img:    { type: 'image', position: 'back'  },
    front_sound: { type: 'sound', position: 'front' },
    back_sound:  { type: 'sound', position: 'back'  },
};

const vanillaUpload = upload.fields([
    { name: 'file',       maxCount: 1 },
    ...Object.keys(VANILLA_MEDIA_FIELDS).map((name) => ({ name, maxCount: 1 })),
]);

router.post('/vanilla', vanillaUpload, catchError(async (req, res) => {
    const files = req.files || {};
    const { docPath } = req.body;
    if (!docPath) return res.status(400).json({ error: 'docPath required' });

    if (req.body.card != null) {
        let cardData;
        try { cardData = JSON.parse(req.body.card); }
        catch { return res.status(400).json({ error: 'card must be valid JSON' }); }

        const mediaItems = [];
        for (const [field, meta] of Object.entries(VANILLA_MEDIA_FIELDS)) {
            const f = files[field]?.[0];
            if (f) mediaItems.push({ buffer: f.buffer, originalName: f.originalname, ...meta });
        }

        const card = await Documents.createFlashcard(norm(docPath), cardData, mediaItems);
        return res.status(201).json({ ok: true, card });
    }

    const { flashcardHash, name, type, position } = req.body;
    const file = files.file?.[0];
    if (!file || !flashcardHash || !name || !type || !position) {
        return res.status(400).json({ error: 'file, docPath, flashcardHash, name, type, and position required' });
    }
    await Media.addVanillaMedia(norm(docPath), flashcardHash, file.buffer, name, type, position);
    res.status(201).json({ ok: true });
}));

router.post('/custom', upload.single('file'), catchError(async (req, res) => {
    const { docPath, flashcardHash, name } = req.body;
    if (!req.file || !docPath || !flashcardHash || !name) {
        return res.status(400).json({ error: 'file, docPath, flashcardHash, and name required' });
    }
    await Documents.addMediaToFlashcard(norm(docPath), flashcardHash, req.file.buffer, name);
    res.status(201).json({ ok: true });
}));

router.delete('/', catchError(async (req, res) => {
    const { docPath, mediaName } = req.body;
    if (!docPath || !mediaName) return res.status(400).json({ error: 'docPath and mediaName required' });
    await Media.removeMedia(norm(docPath), mediaName);
    res.json({ ok: true });
}));

router.post('/reconcile', catchError(async (req, res) => {
    const folderPath = norm(req.body.folderPath ?? '');
    const orphans = await Media.reconcile(folderPath);
    res.json({ removed: orphans.length, orphans });
}));

export default router;
