import { Router } from "express";
import multer from "multer";
import os from "os";
import path from "path";
import fs from "fs/promises";
import crypto from "crypto";
import Documents from "../access/documents.js";

const router = Router();
const docs = new Documents();
const upload = multer({ storage: multer.memoryStorage() });

const norm = (p) => (p ? path.normalize(p) : p);

const CONFLICT_PHRASES = ['already exists', 'already in use'];
const CLIENT_ERROR_PHRASES = ['Cannot create .flashback'];
const isConflict = (err) => CONFLICT_PHRASES.some(p => err.message?.includes(p));
const isClientError = (err) => CLIENT_ERROR_PHRASES.some(p => err.message?.includes(p));

const catchError = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch((err) => {
    if (isConflict(err)) return res.status(409).json({ error: err.message });
    if (isClientError(err)) return res.status(400).json({ error: err.message });
    next(err);
  });

// GET /api/documents/list?path=
router.get(
  "/list",
  catchError((req, res) => {
    const folderPath = norm(req.query.path ?? "");
    res.json(docs.listFolder(folderPath));
  }),
);

// GET /api/documents/read?path=
router.get(
  "/read",
  catchError((req, res) => {
    const relPath = norm(req.query.path);
    if (!relPath) return res.status(400).json({ error: "path required" });
    const { content, encoding } = docs.files.readFile(relPath);
    const metadata = docs.files.getMetadata(relPath);
    res.json({ content, encoding, metadata });
  }),
);

// GET /api/documents/search?q=
router.get(
  "/search",
  catchError((req, res) => {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: "q required" });
    res.json(docs.search(q));
  }),
);

// GET /api/documents/graph
router.get(
  "/graph",
  catchError((req, res) => {
    res.json(docs.getGraphData());
  }),
);

// GET /api/documents/export?path=
router.get(
  "/export",
  catchError((req, res) => {
    const relPath = norm(req.query.path);
    if (!relPath) return res.status(400).json({ error: "path required" });
    const zipPath = docs.exportPackage(relPath);
    res.download(zipPath, path.basename(zipPath));
  }),
);

// POST /api/documents/folder
// Body: { name, parentPath? }
router.post(
  "/folder",
  catchError(async (req, res) => {
    const { name, parentPath = "" } = req.body;
    if (!name) return res.status(400).json({ error: "name required" });
    await docs.createFolder(name, norm(parentPath));
    res.status(201).json({ ok: true });
  }),
);

// POST /api/documents/file
// Body: { name, parentPath? }
router.post(
  "/file",
  catchError(async (req, res) => {
    const { name, parentPath = "" } = req.body;
    if (!name) return res.status(400).json({ error: "name required" });
    await docs.createFile(name, norm(parentPath));
    res.status(201).json({ ok: true });
  }),
);

// PUT /api/documents/file
// Body: { path, content, metadata? }
router.put(
  "/file",
  catchError(async (req, res) => {
    const relPath = norm(req.body.path);
    if (!relPath) return res.status(400).json({ error: "path required" });
    await docs.updateFile(relPath, req.body.content, req.body.metadata);
    res.json({ ok: true });
  }),
);

// PUT /api/documents/metadata
// Body: { path, metadata, isFolder? }
router.put(
  "/metadata",
  catchError(async (req, res) => {
    const relPath = norm(req.body.path);
    if (!relPath) return res.status(400).json({ error: "path required" });
    await docs.updateMetadata(
      relPath,
      req.body.metadata,
      req.body.isFolder ?? false,
    );
    res.json({ ok: true });
  }),
);

// DELETE /api/documents
// Body: { path, isFolder? }
router.delete(
  "/",
  catchError(async (req, res) => {
    const relPath = norm(req.body.path);
    if (!relPath) return res.status(400).json({ error: "path required" });
    await docs.delete(relPath, req.body.isFolder ?? false);
    res.json({ ok: true });
  }),
);

// POST /api/documents/move
// Body: { srcPath, destPath, isFolder? }
router.post(
  "/move",
  catchError(async (req, res) => {
    const srcPath = norm(req.body.srcPath);
    const destPath = norm(req.body.destPath);
    if (!srcPath || !destPath)
      return res.status(400).json({ error: "srcPath and destPath required" });
    await docs.move(srcPath, destPath, req.body.isFolder ?? false);
    res.json({ ok: true });
  }),
);

// POST /api/documents/copy
// Body: { srcPath, destPath, isFolder? }
router.post(
  "/copy",
  catchError(async (req, res) => {
    const srcPath = norm(req.body.srcPath);
    const destPath = norm(req.body.destPath);
    if (!srcPath || !destPath)
      return res.status(400).json({ error: "srcPath and destPath required" });
    await docs.copy(srcPath, destPath, req.body.isFolder ?? false);
    res.json({ ok: true });
  }),
);

// POST /api/documents/rename
// Body: { path, newName, isFolder? }
router.post(
  "/rename",
  catchError(async (req, res) => {
    const relPath = norm(req.body.path);
    const { newName, isFolder = false } = req.body;
    if (!relPath || !newName)
      return res.status(400).json({ error: "path and newName required" });
    await docs.rename(relPath, newName, isFolder);
    res.json({ ok: true });
  }),
);

// POST /api/documents/import
// Multipart: file field + body { name, parentPath? }
router.post(
  "/import",
  upload.single("file"),
  catchError(async (req, res) => {
    const { name, parentPath = "" } = req.body;
    if (!req.file || !name)
      return res.status(400).json({ error: "file and name required" });
    await docs.importFile(name, norm(parentPath), req.file.buffer, {});
    res.status(201).json({ ok: true });
  }),
);

// POST /api/documents/import/zip
// Multipart: file field + body { targetPath? }
router.post(
  "/import/zip",
  upload.single("file"),
  catchError(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "file required" });
    const targetPath = norm(req.body.targetPath ?? "");
    const tempPath = path.join(
      os.tmpdir(),
      `flashback_${crypto.randomUUID()}.zip`,
    );
    await fs.writeFile(tempPath, req.file.buffer);
    try {
      await docs.processZipPackage(tempPath, targetPath);
      res.status(201).json({ ok: true });
    } finally {
      await fs.rm(tempPath, { force: true });
    }
  }),
);

export default router;
