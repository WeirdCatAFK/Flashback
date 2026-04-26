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

// GET /api/media?hash=
// Streams the raw file for a registered media asset. Used by the renderer to
// display images/audio without knowing the workspace path.
router.get('/', (req, res) => {
    const { hash } = req.query;
    if (!hash) return res.status(400).json({ error: 'hash required' });
    try {
        const entry = media.serve(hash);
        res.sendFile(entry.absolute_path);
    } catch {
        res.status(404).json({ error: 'Media not found' });
    }
});

// GET /api/media/list?path=
// Lists all media files inside a folder's media/ subdirectory.
// Each entry includes { name, relativePath, absolutePath, hash|null }.
router.get('/list', (req, res) => {
    const folderPath = norm(req.query.path ?? '');
    res.json(media.list(folderPath));
});

// POST /api/media/vanilla
// Multipart: file field + body { docPath, flashcardHash, name, type, position }
// Adds a vanilla media asset (image/sound) to the front or back of a flashcard.
router.post('/vanilla', upload.single('file'), async (req, res) => {
    const { docPath, flashcardHash, name, type, position } = req.body;
    if (!req.file || !docPath || !flashcardHash || !name || !type || !position) {
        return res.status(400).json({ error: 'file, docPath, flashcardHash, name, type, and position required' });
    }
    await media.addVanillaMedia(norm(docPath), flashcardHash, req.file.buffer, name, type, position);
    res.status(201).json({ ok: true });
});

// POST /api/media/custom
// Multipart: file field + body { docPath, flashcardHash, name }
// Adds a custom media asset to a flashcard's customData (for HTML-engine flashcards).
router.post('/custom', upload.single('file'), async (req, res) => {
    const { docPath, flashcardHash, name } = req.body;
    if (!req.file || !docPath || !flashcardHash || !name) {
        return res.status(400).json({ error: 'file, docPath, flashcardHash, and name required' });
    }
    await docs.addMediaToFlashcard(norm(docPath), flashcardHash, req.file.buffer, name);
    res.status(201).json({ ok: true });
});

// DELETE /api/media
// Body: { docPath, mediaName }
// Removes a media file from disk, cleans all sidecar references, and drops the DB entry.
router.delete('/', async (req, res) => {
    const { docPath, mediaName } = req.body;
    if (!docPath || !mediaName) return res.status(400).json({ error: 'docPath and mediaName required' });
    await media.removeMedia(norm(docPath), mediaName);
    res.json({ ok: true });
});

// POST /api/media/reconcile
// Body: { folderPath }
// Drops DB entries for media files that no longer exist on disk in the given folder.
router.post('/reconcile', (req, res) => {
    const folderPath = norm(req.body.folderPath ?? '');
    const orphans = media.reconcile(folderPath);
    res.json({ removed: orphans.length, orphans });
});

export default router;
