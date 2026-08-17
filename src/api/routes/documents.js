import { Router } from "express";
import multer from "multer";
import os from "os";
import path from "path";
import fs from "fs/promises";
import crypto from "crypto";
import Documents from "../access/orchestration/documents.js";

const router = Router();
const docs = new Documents();
const upload = multer({ storage: multer.memoryStorage() });

const norm = (p) => (p ? path.normalize(p) : p);

// Body writes are limited to the formats the app can actually edit — the same set
// DocumentEditor's pickRenderer() gives an editable renderer. Every other format is
// read-only in the app (a viewer), so a body write can only come from outside it,
// and document bodies are not versioned by Seal: an overwrite is unrecoverable.
// Clip/YouTube bodies are written by their own routes through documents.js, not here.
const EDITABLE_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.text']);
const isEditableBody = (relPath) => EDITABLE_EXTENSIONS.has(path.extname(relPath).toLowerCase());

const CONFLICT_PHRASES = ['already exists', 'already in use'];
const CLIENT_ERROR_PHRASES = ['Cannot create .flashback', 'Cannot overwrite the binary file', 'Invalid YouTube URL', 'Invalid URL', 'Failed to fetch', 'File not found'];
const isConflict = (err) => CONFLICT_PHRASES.some(p => err.message?.includes(p));
const isClientError = (err) => CLIENT_ERROR_PHRASES.some(p => err.message?.includes(p));

const catchError = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch((err) => {
    // An explicit status on the error (e.g. 404/422 from the access layer) wins over
    // the message-phrase heuristics below.
    if (err.status) return res.status(err.status).json({ error: err.message });
    if (isConflict(err)) return res.status(409).json({ error: err.message });
    if (isClientError(err)) return res.status(400).json({ error: err.message });
    next(err);
  });

// GET /api/documents/list?path=
router.get(
  "/list",
  catchError(async (req, res) => {
    const folderPath = norm(req.query.path ?? "");
    res.json(await docs.listFolder(folderPath));
  }),
);

// GET /api/documents/read?path=
// Text documents come back decoded in `content`. Binary ones (PDF, EPUB, media)
// come back with `content: null` and `binary: true` — their bytes belong to
// /api/documents/raw — but still carry their sidecar `metadata`, which is what
// the PDF/EPUB renderers actually want from this endpoint.
router.get(
  "/read",
  catchError((req, res) => {
    const relPath = norm(req.query.path);
    if (!relPath) return res.status(400).json({ error: "path required" });
    const { content, encoding, binary, size } = docs.files.readFile(relPath);
    const metadata = docs.files.getMetadata(relPath);
    res.json({ content, encoding, binary, size, metadata });
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
  catchError(async (req, res) => {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: "q required" });
    res.json(await docs.search(q));
  }),
);

// GET /api/documents/search/content?q=&limit=
// Substring search over text document bodies (which live on disk, not in the
// DB) — returns per-document match counts and context snippets.
router.get(
  "/search/content",
  catchError(async (req, res) => {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: "q required" });
    const limit = Math.min(parseInt(req.query.limit ?? "20", 10), 100);
    res.json(await docs.searchContent(q, limit));
  }),
);

// GET /api/documents/links?path=
// flashback:// link edges for one document: outgoing, backlinks, and pending
// (linked hashes whose target document doesn't exist yet).
router.get(
  "/links",
  catchError(async (req, res) => {
    const relPath = norm(req.query.path);
    if (!relPath) return res.status(400).json({ error: "path required" });
    try {
      res.json(await docs.getLinks(relPath));
    } catch (err) {
      if (err.message?.includes("not found")) return res.status(404).json({ error: err.message });
      throw err;
    }
  }),
);

// GET /api/documents/graph
router.get(
  "/graph",
  catchError(async (req, res) => {
    res.json(await docs.getGraphData());
  }),
);

// GET /api/documents/tags
router.get(
  "/tags",
  catchError(async (req, res) => {
    res.json({ tags: await docs.query.getAllTags() });
  }),
);

// GET /api/documents/tags/usage
// Returns [{ name, count }] — every tag and how many entities apply it directly.
router.get(
  "/tags/usage",
  catchError(async (req, res) => {
    res.json({ tags: await docs.query.getTagsWithCounts() });
  }),
);

// GET /api/documents/tags/entity?path=&isFolder=
// Returns { direct, inherited, excluded } for a specific file or folder.
router.get(
  "/tags/entity",
  catchError(async (req, res) => {
    const relPath = norm(req.query.path);
    if (!relPath) return res.status(400).json({ error: "path required" });
    const isFolder = req.query.isFolder === "true";

    const entity = isFolder
      ? await docs.query.getFolderByPath(relPath)
      : await docs.query.getDocumentByPath(relPath);
    if (!entity) return res.status(404).json({ error: "entity not found" });

    const inherited = await docs.query.getInheritedTagNames(entity.node_id);
    const direct    = await docs.query.getDirectTagNames(entity.node_id);
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
// A `content` write is restricted to editable text formats (see EDITABLE_EXTENSIONS);
// metadata-only writes are allowed on any document, which is how the PDF/EPUB
// renderers save their sidecars.
router.put(
  "/file",
  catchError(async (req, res) => {
    const relPath = norm(req.body.path);
    if (!relPath) return res.status(400).json({ error: "path required" });
    if (req.body.content != null && !isEditableBody(relPath)) {
      return res.status(400).json({
        error: `Only ${[...EDITABLE_EXTENSIONS].join(', ')} documents have editable bodies; ` +
          `${path.extname(relPath) || 'this format'} is read-only in the app. ` +
          `Its flashcards, tags and highlights are edited through its sidecar (PUT /api/documents/metadata).`,
      });
    }
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

// POST /api/documents/youtube/transcript
// JSON body { path, lang? } — fetches the video's captions into the .youtube
// document's sidecar so its spoken content becomes readable. 422 when the video
// has no usable captions.
router.post(
  "/youtube/transcript",
  catchError(async (req, res) => {
    const { path: relPath, lang } = req.body ?? {};
    if (!relPath) return res.status(400).json({ error: "path required" });
    const result = await docs.fetchYoutubeTranscript(norm(relPath), { lang });
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

// POST /api/documents/clip/asset
// JSON body { path, href } — downloads one of a clip's remote pictures or sounds
// into the vault and points the clip at the local copy. Clipping itself saves no
// assets; this is what saves the ones a card actually uses. `href` must be a src
// already present in that clip's body, which is what keeps this from being a
// general-purpose downloader. An href that is already local is a no-op success.
router.post(
  "/clip/asset",
  catchError(async (req, res) => {
    const { path: relPath, href } = req.body ?? {};
    if (!relPath || !href) return res.status(400).json({ error: "path and href required" });
    const result = await docs.saveClipAsset(norm(relPath), href);
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
        // An Anki package is not imported here. Its notetypes have arbitrary named
        // fields, so the caller is handed the inventory to map onto card slots and
        // comes back to POST /import/anki with a mapping and this session id.
        const { default: AnkiImport } = await import("../access/orchestration/ankiImport.js");
        const importer = new AnkiImport();
        const report = await importer.analyze(req.file.buffer);
        return res.status(200).json({ ...report, needsMapping: true });
      }

      if (!isFlashback) {
        const hasMd = entries.some(e => e.entryName.toLowerCase().endsWith(".md"));
        if (hasMd) {
          isObsidian = true;
        }
      }

      if (isObsidian) {
        const { default: ObsidianImport } = await import("../access/orchestration/obsidianImport.js");
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

// POST /api/documents/import/anki/analyze
// Multipart: file field
// Reads the package without importing it and returns the notetype inventory —
// fields, sample notes and a suggested field→slot mapping — plus a sessionId that
// keeps the extraction on disk so the apply call needs no second upload.
router.post(
  "/import/anki/analyze",
  upload.single("file"),
  catchError(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "file required" });
    const { default: AnkiImport } = await import("../access/orchestration/ankiImport.js");
    const importer = new AnkiImport();
    res.status(200).json(await importer.analyze(req.file.buffer));
  }),
);

// GET /api/documents/import/anki/media?sessionId=…&name=…
// Streams one asset out of a live analyze() session so the mapping UI can preview
// images and play sounds before anything is imported. Read-only; nothing is written
// to the vault. Loaded by <img>/<audio>, so it authenticates by `?token=` like the
// other media routes rather than an Authorization header.
router.get(
  "/import/anki/media",
  catchError(async (req, res) => {
    const { sessionId, name } = req.query;
    if (!sessionId || !name) return res.status(400).json({ error: "sessionId and name required" });

    const { default: AnkiImport } = await import("../access/orchestration/ankiImport.js");
    const asset = new AnkiImport().readSessionMedia(String(sessionId), String(name));
    if (!asset) return res.status(404).json({ error: "asset not found in import session" });

    res.type(path.extname(asset.filename) || "application/octet-stream").send(asset.buffer);
  }),
);

// POST /api/documents/import/anki
// Multipart: file field + body { targetPath?, mapping?, sessionId? }
// `mapping` is `{ [notetypeId]: { cardType, slots } }` as JSON; notetypes it omits
// fall back to the same suggestion analyze() reported. Supply `sessionId` to reuse
// an earlier analyze() extraction instead of re-uploading the package.
router.post(
  "/import/anki",
  upload.single("file"),
  catchError(async (req, res) => {
    const sessionId = req.body.sessionId || null;
    if (!req.file && !sessionId) return res.status(400).json({ error: "file or sessionId required" });
    const targetPath = norm(req.body.targetPath ?? "");

    let mapping = null;
    if (req.body.mapping) {
      try {
        mapping = typeof req.body.mapping === "string" ? JSON.parse(req.body.mapping) : req.body.mapping;
      } catch {
        return res.status(400).json({ error: "mapping must be valid JSON" });
      }
    }

    const { default: AnkiImport } = await import("../access/orchestration/ankiImport.js");
    const importer = new AnkiImport();
    const result = await importer.importApkg(req.file?.buffer ?? null, targetPath, mapping, sessionId);
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
    const { default: ObsidianImport } = await import("../access/orchestration/obsidianImport.js");
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
    const doc = await docs.query.getDocumentByHash(req.params.hash);
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
