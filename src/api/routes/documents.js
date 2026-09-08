import { Router } from "express";
import multer from "multer";
import os from "os";
import path from "path";
import fs from "fs/promises";
import crypto from "crypto";
import Documents from "../access/orchestration/documents.js";
import { EDITABLE_BODY_EXTENSIONS } from "../access/resources/files.js";

const router = Router();
const docs = new Documents();
const upload = multer({ storage: multer.memoryStorage() });

const norm = (p) => (p ? path.normalize(p) : p);

const EDITABLE_EXTENSIONS = EDITABLE_BODY_EXTENSIONS;
const isEditableBody = (relPath) => EDITABLE_EXTENSIONS.has(path.extname(relPath).toLowerCase());

const CONFLICT_PHRASES = ['already exists', 'already in use'];
const CLIENT_ERROR_PHRASES = ['Cannot create .flashback', 'Cannot overwrite the binary file', 'Invalid YouTube URL', 'Invalid URL', 'Failed to fetch', 'File not found'];
const isConflict = (err) => CONFLICT_PHRASES.some(p => err.message?.includes(p));
const isClientError = (err) => CLIENT_ERROR_PHRASES.some(p => err.message?.includes(p));

const catchError = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch((err) => {
    if (err.status) {
      const body = { error: err.message };
      if (err.code) body.code = err.code;
      if (err.etag !== undefined) body.etag = err.etag;
      if (err.retryAfter) res.set('Retry-After', String(err.retryAfter));
      return res.status(err.status).json(body);
    }
    if (isConflict(err)) return res.status(409).json({ error: err.message });
    if (isClientError(err)) return res.status(400).json({ error: err.message });
    next(err);
  });

/** One folder's documents and subfolders. */
router.get(
  "/list",
  catchError(async (req, res) => {
    const folderPath = norm(req.query.path ?? "");
    res.json(await docs.listFolder(folderPath));
  }),
);

/** A document's body and sidecar. */
router.get(
  "/read",
  catchError((req, res) => {
    const relPath = norm(req.query.path);
    if (!relPath) return res.status(400).json({ error: "path required" });
    const { content, encoding, binary, size } = docs.files.readFile(relPath);
    const metadata = docs.files.getMetadata(relPath);
    res.json({ content, encoding, binary, size, metadata, etag: docs.files.etag(relPath) });
  }),
);

/** A document's bytes, for the renderer to decode. */
router.get(
  "/raw",
  catchError((req, res) => {
    const relPath = norm(req.query.path);
    if (!relPath) return res.status(400).json({ error: "path required" });
    const absPath = docs.files.safePath(relPath);
    res.sendFile(absPath);
  }),
);

/** Searches names and metadata across the workspace. */
router.get(
  "/search",
  catchError(async (req, res) => {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: "q required" });
    res.json(await docs.search(q));
  }),
);

/** Searches document bodies, returning matching snippets. */
router.get(
  "/search/content",
  catchError(async (req, res) => {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: "q required" });
    const limit = Math.min(parseInt(req.query.limit ?? "20", 10), 100);
    res.json(await docs.searchContent(q, limit));
  }),
);

/** A document's outgoing links and backlinks. */
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

/** Nodes and edges for the graph view. */
router.get(
  "/graph",
  catchError(async (req, res) => {
    res.json(await docs.getGraphData());
  }),
);

/** Every tag in the vault. */
router.get(
  "/tags",
  catchError(async (req, res) => {
    res.json({ tags: await docs.query.getAllTags() });
  }),
);

/** How many documents and cards carry each tag. */
router.get(
  "/tags/usage",
  catchError(async (req, res) => {
    res.json({ tags: await docs.query.getTagsWithCounts() });
  }),
);

/** The effective tags on one document or folder. */
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

/** A document's raw `.flashback` sidecar. */
router.get(
  "/sidecar",
  catchError((req, res) => {
    const relPath = norm(req.query.path);
    if (!relPath) return res.status(400).json({ error: "path required" });
    const isFolder = req.query.isFolder === "true";
    const sidecar = docs.files.getMetadata(relPath, isFolder);
    if (!sidecar) return res.status(404).json({ error: "sidecar not found" });
    const etag = docs.files.etag(relPath, isFolder);
    if (etag) res.set("ETag", etag);
    res.json(sidecar);
  }),
);

/** Streams a document and its media as a package. */
router.get(
  "/export",
  catchError((req, res) => {
    const relPath = norm(req.query.path);
    if (!relPath) return res.status(400).json({ error: "path required" });
    const zipPath = docs.exportPackage(relPath);
    res.download(zipPath, path.basename(zipPath));
  }),
);

/** Creates a folder and its sidecar. */
router.post(
  "/folder",
  catchError(async (req, res) => {
    const { name, parentPath = "" } = req.body;
    if (!name) return res.status(400).json({ error: "name required" });
    await docs.createFolder(name, norm(parentPath));
    res.status(201).json({ ok: true });
  }),
);

/** Creates a document. */
router.post(
  "/file",
  catchError(async (req, res) => {
    const { name, parentPath = "" } = req.body;
    if (!name) return res.status(400).json({ error: "name required" });
    await docs.createFile(name, norm(parentPath));
    res.status(201).json({ ok: true });
  }),
);

/** Writes a document's body; text formats only. */
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
    const { etag } = await docs.updateFile(
      relPath, req.body.content, req.body.metadata, { ifMatch: req.body.ifMatch });
    res.json({ ok: true, etag });
  }),
);

/** Writes a document's sidecar metadata. */
router.put(
  "/metadata",
  catchError(async (req, res) => {
    const relPath = norm(req.body.path);
    if (!relPath) return res.status(400).json({ error: "path required" });
    const { etag } = await docs.updateMetadata(
      relPath,
      req.body.metadata,
      req.body.isFolder ?? false,
      { ifMatch: req.body.ifMatch },
    );
    res.json({ ok: true, etag });
  }),
);

/** Deletes a document or folder and its index rows. */
router.delete(
  "/",
  catchError(async (req, res) => {
    const relPath = norm(req.body.path);
    if (!relPath) return res.status(400).json({ error: "path required" });
    await docs.delete(relPath, req.body.isFolder ?? false);
    res.json({ ok: true });
  }),
);

/** Moves a document or folder, re-pointing media and inherited tags. */
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

/** Copies a document or folder, assigning fresh identities to the copy. */
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

/** Renames a document or folder in place. */
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

/** Imports a file from disk into the workspace. */
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

/** Creates a `.youtube` document from a video URL. */
router.post(
  "/youtube",
  catchError(async (req, res) => {
    const { url, parentPath = "" } = req.body ?? {};
    if (!url) return res.status(400).json({ error: "url required" });
    const result = await docs.createYoutube(url, norm(parentPath));
    res.status(201).json(result);
  }),
);

/** Clips a web page into a `.clip` document. */
router.post(
  "/clip",
  catchError(async (req, res) => {
    const { url, parentPath = "" } = req.body ?? {};
    if (!url) return res.status(400).json({ error: "url required" });
    const result = await docs.createClip(url, norm(parentPath));
    res.status(201).json(result);
  }),
);

/** Re-points a `.youtube` document at a different video. */
router.put(
  "/youtube",
  catchError(async (req, res) => {
    const { path: relPath, url } = req.body ?? {};
    if (!relPath || !url) return res.status(400).json({ error: "path and url required" });
    const result = await docs.setYoutubeSource(norm(relPath), url);
    res.json(result);
  }),
);

/** Fetches a video's captions into the sidecar's `source.transcript`. */
router.post(
  "/youtube/transcript",
  catchError(async (req, res) => {
    const { path: relPath, lang } = req.body ?? {};
    if (!relPath) return res.status(400).json({ error: "path required" });
    const result = await docs.fetchYoutubeTranscript(norm(relPath), { lang });
    res.json(result);
  }),
);

/** Re-clips a `.clip` document from its source URL. */
router.put(
  "/clip",
  catchError(async (req, res) => {
    const { path: relPath, url } = req.body ?? {};
    if (!relPath || !url) return res.status(400).json({ error: "path and url required" });
    const result = await docs.setClipSource(norm(relPath), url);
    res.json(result);
  }),
);

/** Downloads one of a clip's remote assets into the vault. */
router.post(
  "/clip/asset",
  catchError(async (req, res) => {
    const { path: relPath, href } = req.body ?? {};
    if (!relPath || !href) return res.status(400).json({ error: "path and href required" });
    const result = await docs.saveClipAsset(norm(relPath), href);
    res.json(result);
  }),
);

/** Imports a `.zip` package exported by this app. */
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

      await docs.processZipPackage(tempPath, targetPath);
      res.status(201).json({ ok: true });
    } finally {
      await fs.rm(tempPath, { force: true });
    }
  }),
);

/** Inspects an `.apkg` and suggests a field-to-slot mapping, holding the extraction under a session id. */
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

/** Serves one media file from a held Anki extraction. */
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

/** Applies an analyzed `.apkg` import with the caller's field mapping. */
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

/** Imports an Obsidian vault directory. */
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

/** Resolves a document `globalHash` to its path. */
router.get(
  '/by-hash/:hash',
  catchError(async (req, res) => {
    const doc = await docs.query.getDocumentByHash(req.params.hash);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    res.json({ relativePath: doc.relative_path, name: doc.name });
  }),
);

/** Re-derives a document's `flashback://` links from its body. */
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
