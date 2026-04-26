import { Router } from 'express';
import multer from 'multer';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import Documents from '../access/documents.js';

const router = Router();
const docs = new Documents();
const upload = multer({ storage: multer.memoryStorage() });

// Normalize a path received from an HTTP client (may use forward slashes on Windows).
const norm = (p) => p ? path.normalize(p) : p;

// GET /api/documents/list?path=
// Returns the contents of a folder (files and subfolders, no sidecars).
router.get('/list', (req, res) => {
    const folderPath = norm(req.query.path ?? '');
    res.json(docs.files.listFolder(folderPath));
});

// GET /api/documents/read?path=
// Returns content + metadata for a single document.
router.get('/read', (req, res) => {
    const relPath = norm(req.query.path);
    if (!relPath) return res.status(400).json({ error: 'path required' });
    const { content, encoding } = docs.files.readFile(relPath);
    const metadata = docs.files.getMetadata(relPath);
    res.json({ content, encoding, metadata });
});

// GET /api/documents/search?q=
// Full-text search across documents, flashcards, and tags.
router.get('/search', (req, res) => {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'q required' });
    res.json(docs.search(q));
});

// GET /api/documents/graph
// Returns the full knowledge graph (nodes + edges).
router.get('/graph', (req, res) => {
    res.json(docs.getGraphData());
});

// GET /api/documents/export?path=
// Streams a zip archive of the given folder.
router.get('/export', (req, res) => {
    const relPath = norm(req.query.path);
    if (!relPath) return res.status(400).json({ error: 'path required' });
    const zipPath = docs.exportPackage(relPath);
    res.download(zipPath, path.basename(zipPath));
});

// POST /api/documents/folder
// Body: { name, parentPath? }
router.post('/folder', async (req, res) => {
    const { name, parentPath = '' } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    await docs.createFolder(name, norm(parentPath));
    res.status(201).json({ ok: true });
});

// POST /api/documents/file
// Body: { name, parentPath? }
router.post('/file', async (req, res) => {
    const { name, parentPath = '' } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    await docs.createFile(name, norm(parentPath));
    res.status(201).json({ ok: true });
});

// PUT /api/documents/file
// Body: { path, content, metadata? }
router.put('/file', async (req, res) => {
    const relPath = norm(req.body.path);
    if (!relPath) return res.status(400).json({ error: 'path required' });
    await docs.updateFile(relPath, req.body.content, req.body.metadata);
    res.json({ ok: true });
});

// PUT /api/documents/metadata
// Body: { path, metadata, isFolder? }
router.put('/metadata', async (req, res) => {
    const relPath = norm(req.body.path);
    if (!relPath) return res.status(400).json({ error: 'path required' });
    await docs.updateMetadata(relPath, req.body.metadata, req.body.isFolder ?? false);
    res.json({ ok: true });
});

// DELETE /api/documents
// Body: { path, isFolder? }
router.delete('/', async (req, res) => {
    const relPath = norm(req.body.path);
    if (!relPath) return res.status(400).json({ error: 'path required' });
    await docs.delete(relPath, req.body.isFolder ?? false);
    res.json({ ok: true });
});

// POST /api/documents/move
// Body: { srcPath, destPath, isFolder? }
router.post('/move', async (req, res) => {
    const srcPath = norm(req.body.srcPath);
    const destPath = norm(req.body.destPath);
    if (!srcPath || !destPath) return res.status(400).json({ error: 'srcPath and destPath required' });
    await docs.move(srcPath, destPath, req.body.isFolder ?? false);
    res.json({ ok: true });
});

// POST /api/documents/copy
// Body: { srcPath, destPath, isFolder? }
router.post('/copy', async (req, res) => {
    const srcPath = norm(req.body.srcPath);
    const destPath = norm(req.body.destPath);
    if (!srcPath || !destPath) return res.status(400).json({ error: 'srcPath and destPath required' });
    await docs.copy(srcPath, destPath, req.body.isFolder ?? false);
    res.json({ ok: true });
});

// POST /api/documents/rename
// Body: { path, newName, isFolder? }
router.post('/rename', async (req, res) => {
    const relPath = norm(req.body.path);
    const { newName, isFolder = false } = req.body;
    if (!relPath || !newName) return res.status(400).json({ error: 'path and newName required' });
    await docs.rename(relPath, newName, isFolder);
    res.json({ ok: true });
});

// POST /api/documents/import
// Multipart: file field + body { name, parentPath? }
// Imports a single text document into the workspace.
router.post('/import', upload.single('file'), async (req, res) => {
    const { name, parentPath = '' } = req.body;
    if (!req.file || !name) return res.status(400).json({ error: 'file and name required' });
    const content = req.file.buffer.toString('utf-8');
    await docs.importFile(name, norm(parentPath), content, {});
    res.status(201).json({ ok: true });
});

// POST /api/documents/import/zip
// Multipart: file field + body { targetPath? }
// Imports a Flashback zip package into the workspace.
router.post('/import/zip', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'file required' });
    const targetPath = norm(req.body.targetPath ?? '');
    const tempPath = path.join(os.tmpdir(), `flashback_${crypto.randomUUID()}.zip`);
    await fs.writeFile(tempPath, req.file.buffer);
    try {
        await docs.processZipPackage(tempPath, targetPath);
        res.status(201).json({ ok: true });
    } finally {
        await fs.rm(tempPath, { force: true });
    }
});

export default router;
