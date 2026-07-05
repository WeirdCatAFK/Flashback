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
const CLIENT_ERROR_PHRASES = ['Cannot create .flashback', 'Invalid YouTube URL', 'Invalid URL', 'Failed to fetch', 'File not found'];
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

// GET /api/documents/raw?path= — serve the file as binary (PDF, images, etc.)
router.get(
  "/raw",
  catchError((req, res) => {
    const relPath = norm(req.query.path);
    if (!relPath) return res.status(400).json({ error: "path required" });
    const absPath = docs.files.safePath(relPath);
    res.sendFile(absPath);
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

// GET /api/documents/tags
router.get(
  "/tags",
  catchError((req, res) => {
    res.json({ tags: docs.query.getAllTags() });
  }),
);

// GET /api/documents/tags/usage
// Returns [{ name, count }] — every tag and how many entities apply it directly.
router.get(
  "/tags/usage",
  catchError((req, res) => {
    res.json({ tags: docs.query.getTagsWithCounts() });
  }),
);

// GET /api/documents/tags/entity?path=&isFolder=
// Returns { direct, inherited, excluded } for a specific file or folder.
router.get(
  "/tags/entity",
  catchError((req, res) => {
    const relPath = norm(req.query.path);
    if (!relPath) return res.status(400).json({ error: "path required" });
    const isFolder = req.query.isFolder === "true";

    const entity = isFolder
      ? docs.query.getFolderByPath(relPath)
      : docs.query.getDocumentByPath(relPath);
    if (!entity) return res.status(404).json({ error: "entity not found" });

    const inherited = docs.query.getInheritedTagNames(entity.node_id);
    const direct    = docs.query.getDirectTagNames(entity.node_id);
    const sidecar   = docs.files.getMetadata(relPath, isFolder) || {};
    const excluded  = sidecar.excludedTags || [];

    res.json({ direct, inherited, excluded });
  }),
);

// GET /api/documents/sidecar?path=&isFolder=
// Returns the raw sidecar JSON for a file or folder.
router.get(
  "/sidecar",
  catchError((req, res) => {
    const relPath = norm(req.query.path);
    if (!relPath) return res.status(400).json({ error: "path required" });
    const isFolder = req.query.isFolder === "true";
    const sidecar = docs.files.getMetadata(relPath, isFolder);
    if (!sidecar) return res.status(404).json({ error: "sidecar not found" });
    res.json(sidecar);
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

// POST /api/documents/youtube
// JSON body { url, parentPath? } — captures a YouTube URL as a .youtube reference doc
router.post(
  "/youtube",
  catchError(async (req, res) => {
    const { url, parentPath = "" } = req.body ?? {};
    if (!url) return res.status(400).json({ error: "url required" });
    const result = await docs.createYoutube(url, norm(parentPath));
    res.status(201).json(result);
  }),
);

// POST /api/documents/clip
// JSON body { url, parentPath? } — fetches a web page and stores a readable .clip snapshot
router.post(
  "/clip",
  catchError(async (req, res) => {
    const { url, parentPath = "" } = req.body ?? {};
    if (!url) return res.status(400).json({ error: "url required" });
    const result = await docs.createClip(url, norm(parentPath));
    res.status(201).json(result);
  }),
);

// PUT /api/documents/youtube
// JSON body { path, url } — populates an existing (blank) .youtube file from a URL
router.put(
  "/youtube",
  catchError(async (req, res) => {
    const { path: relPath, url } = req.body ?? {};
    if (!relPath || !url) return res.status(400).json({ error: "path and url required" });
    const result = await docs.setYoutubeSource(norm(relPath), url);
    res.json(result);
  }),
);

// PUT /api/documents/clip
// JSON body { path, url } — populates an existing (blank) .clip file from a URL
router.put(
  "/clip",
  catchError(async (req, res) => {
    const { path: relPath, url } = req.body ?? {};
    if (!relPath || !url) return res.status(400).json({ error: "path and url required" });
    const result = await docs.setClipSource(norm(relPath), url);
    res.json(result);
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
      `flashback_${crypto.randomUUID()}_import.zip`,
    );
    await fs.writeFile(tempPath, req.file.buffer);
    try {
      // Auto-detect package type by inspecting Zip content
      const { default: AdmZip } = await import("adm-zip");
      const zip = new AdmZip(tempPath);
      let isAnki = false;
      let isObsidian = false;
      let isFlashback = false;

      const entries = zip.getEntries();
      for (const entry of entries) {
        const name = entry.entryName.toLowerCase();
        if (name.includes("collection.anki2") || name.includes("collection.anki21")) {
          isAnki = true;
          break;
        }
        if (name.includes(".flashback")) {
          isFlashback = true;
        }
      }

      if (isAnki) {
        const { default: AnkiImport } = await import("../access/ankiImport.js");
        const importer = new AnkiImport();
        const result = await importer.importApkg(req.file.buffer, targetPath);
        return res.status(201).json(result);
      }

      if (!isFlashback) {
        const hasMd = entries.some(e => e.entryName.toLowerCase().endsWith(".md"));
        if (hasMd) {
          isObsidian = true;
        }
      }

      if (isObsidian) {
        const { default: ObsidianImport } = await import("../access/obsidianImport.js");
        const importer = new ObsidianImport();
        const result = await importer.importVault(req.file.buffer, targetPath);
        return res.status(201).json(result);
      }

      // Default to Flashback ZIP package
      await docs.processZipPackage(tempPath, targetPath);
      res.status(201).json({ ok: true });
    } finally {
      await fs.rm(tempPath, { force: true });
    }
  }),
);

// POST /api/documents/import/anki
// Multipart: file field + body { targetPath? }
router.post(
  "/import/anki",
  upload.single("file"),
  catchError(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "file required" });
    const targetPath = norm(req.body.targetPath ?? "");
    const { default: AnkiImport } = await import("../access/ankiImport.js");
    const importer = new AnkiImport();
    const result = await importer.importApkg(req.file.buffer, targetPath);
    res.status(201).json(result);
  }),
);

// POST /api/documents/import/obsidian
// Multipart: file field + body { targetPath? }
router.post(
  "/import/obsidian",
  upload.single("file"),
  catchError(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "file required" });
    const targetPath = norm(req.body.targetPath ?? "");
    const { default: ObsidianImport } = await import("../access/obsidianImport.js");
    const importer = new ObsidianImport();
    const result = await importer.importVault(req.file.buffer, targetPath);
    res.status(201).json(result);
  }),
);


// GET /api/documents/by-hash/:hash
// Resolves a globalHash to { relativePath, name } — used by the renderer to
// navigate flashback:// links on click.
router.get(
  '/by-hash/:hash',
  catchError(async (req, res) => {
    const doc = docs.query.getDocumentByHash(req.params.hash);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    res.json({ relativePath: doc.relative_path, name: doc.name });
  }),
);

// POST /api/documents/links/sync
// Manually re-syncs flashback:// link connections for a document.
router.post(
  '/links/sync',
  catchError(async (req, res) => {
    const relPath = norm(req.body.path);
    if (!relPath) return res.status(400).json({ error: 'path required' });
    await docs.syncDocumentLinks(relPath);
    res.json({ ok: true });
  }),
);

export default router;
