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

// POST /api/media/vanilla
// Multipart: file field + body { docPath, flashcardHash, name, type, position }
router.post('/vanilla', upload.single('file'), catchError(async (req, res) => {
    const { docPath, flashcardHash, name, type, position } = req.body;
    if (!req.file || !docPath || !flashcardHash || !name || !type || !position) {
        return res.status(400).json({ error: 'file, docPath, flashcardHash, name, type, and position required' });
    }
    await media.addVanillaMedia(norm(docPath), flashcardHash, req.file.buffer, name, type, position);
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
