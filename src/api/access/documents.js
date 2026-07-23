/**
 * Documents.js
 * The Orchestrator. Coordinates File System, Database, and specialized services.
 */

import path from 'path';
import fs from 'fs';
import Files from './files.js';
import query from './query.js';
import srsService from './srs.js';
import db from './database.js';
import crypto from 'crypto';
import os from 'os';
import AdmZip from 'adm-zip';
import { sealEmitter } from '../seal/seal.js';
import highlightsService from './highlights.js';
import newFileMetadata from '../config/defaults/FlashbackFile.js';

/**
 * Extracts the 11-char video id from any common YouTube URL shape
 * (watch?v=, youtu.be/, /embed/, /shorts/, /live/). Returns null if none.
 */
export function extractYoutubeId(url) {
    if (!url) return null;
    const patterns = [
        /[?&]v=([A-Za-z0-9_-]{11})/,
        /youtu\.be\/([A-Za-z0-9_-]{11})/,
        /\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{11})/,
    ];
    for (const re of patterns) {
        const m = url.match(re);
        if (m) return m[1];
    }
    return null;
}

/**
 * Chooses one caption track from a playerResponse's captionTracks[], preferring a
 * manually-authored track in the requested language, then any track in that
 * language, then any manual track, then whatever exists. `kind: 'asr'` marks an
 * auto-generated track. Returns null when the video carries no captions at all.
 */
export function pickCaptionTrack(playerResponse, lang) {
    const tracks =
        playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!Array.isArray(tracks) || tracks.length === 0) return null;
    const want = String(lang || "en").toLowerCase();
    const inLang = tracks.filter((t) => (t.languageCode || "").toLowerCase().startsWith(want));
    const manual = (arr) => arr.find((t) => t.kind !== "asr");
    return manual(inLang) || inLang[0] || manual(tracks) || tracks[0];
}

/**
 * Turns a YouTube timedtext json3 payload (object or raw string) into transcript
 * cues `{ start, dur, text }` in seconds. Events with no `segs` are formatting
 * markers, and blank cues are dropped, so the result is speakable prose only.
 * Pure — the network fetch lives in Documents._fetchYoutubeTranscript.
 */
export function parseJson3Transcript(json) {
    let data = json;
    if (typeof data === "string") {
        try { data = JSON.parse(data); } catch { return []; }
    }
    const events = Array.isArray(data?.events) ? data.events : [];
    const cues = [];
    for (const ev of events) {
        if (!Array.isArray(ev.segs)) continue;
        const text = ev.segs.map((s) => s.utf8 ?? "").join("").replace(/\s+/g, " ").trim();
        if (!text) continue;
        cues.push({
            start: Math.round(((ev.tStartMs ?? 0) / 1000) * 100) / 100,
            dur: Math.round(((ev.dDurationMs ?? 0) / 1000) * 100) / 100,
            text,
        });
    }
    return cues;
}

/**
 * Turns an arbitrary title into a filesystem-safe base name (no extension).
 * Strips characters illegal on Windows, collapses whitespace, caps length,
 * and falls back to "clip" when nothing usable remains.
 */
export function slugifyName(title) {
    const cleaned = String(title || "")
        .replace(/[\\/:*?"<>|]/g, " ")   // Windows-illegal path chars
        .replace(/[\r\n\t]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120)
        .trim();
    return cleaned || "clip";
}

// Best-effort image extension from an HTTP content-type header.
function extFromContentType(ct) {
    if (!ct) return null;
    const type = ct.split(';')[0].trim().toLowerCase();
    const map = {
        'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
        'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg',
        'image/avif': 'avif', 'image/bmp': 'bmp',
    };
    return map[type] || null;
}

// Best-effort image extension from a URL path.
function extFromUrl(u) {
    try {
        const m = new URL(u).pathname.match(/\.([a-z0-9]{1,5})$/i);
        return m ? m[1].toLowerCase() : null;
    } catch { return null; }
}

// Whitelist for stored clip HTML — readable structure only, no scripts/handlers.
// Relative `./media/` image src survive (verified); remote/data src are kept as
// a fallback for images that couldn't be cached locally.
const CLIP_SANITIZE_OPTS = {
    allowedTags: [
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'a', 'ul', 'ol', 'li',
        'blockquote', 'pre', 'code', 'em', 'strong', 'b', 'i', 'u', 's',
        'sub', 'sup', 'br', 'hr', 'img', 'figure', 'figcaption', 'table',
        'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'span',
        'div', 'mark', 'small', 'abbr', 'cite', 'time',
    ],
    allowedAttributes: {
        a: ['href', 'title'],
        img: ['src', 'alt', 'title', 'width', 'height'],
        '*': ['id'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['http', 'https', 'data'] },
    allowProtocolRelative: false,
};

const MAX_CLIP_IMAGES = 40;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export default class Documents {
    constructor() {
        this.files = new Files();
        this.query = query;
        this.srs = srsService;
    }

    // --- Listing ---

    listFolder(relPath) {
        const items = this.files.listFolder(relPath);
        const folder = this.query.getFolderByPath(relPath);

        let fileCountMap = new Map();
        let folderCountMap = new Map();

        if (folder) {
            const counts = this.query.getFlashcardCountsByFolder(folder.id);
            fileCountMap = new Map(counts.map(r => [r.name, r.count]));

            const subfolderNames = [];
            for (const i of items) { if (i.type === 'folder') subfolderNames.push(i.name); }
            if (subfolderNames.length > 0) {
                const childRelPaths = subfolderNames.map(n => path.join(relPath, n));
                const childFolders = this.query.getFoldersByPaths(childRelPaths);
                if (childFolders.length > 0) {
                    const countsByRootId = this.query.getFlashcardCountsInFolderTrees(childFolders.map(f => f.id));
                    for (const cf of childFolders) {
                        folderCountMap.set(cf.relative_path, countsByRootId.get(cf.id) ?? 0);
                    }
                }
            }
        }

        return items.map(item => {
            if (item.type === 'file') {
                return { ...item, flashcardCount: fileCountMap.get(item.name) ?? 0 };
            }
            const childRelPath = path.join(relPath, item.name);
            return { ...item, flashcardCount: folderCountMap.get(childRelPath) ?? 0 };
        });
    }

    // --- Core Operations ---

    async createFile(name, relativePath = "") {
        const { globalHash, name: resolvedName } = this.files.createFile(relativePath, name);
        const fileRelPath = path.join(relativePath, resolvedName);

        try {
            const absPath = this.files.safePath(fileRelPath);
            db.transaction(() => {
                const nodeId = this.query.createNode('Document');
                const folderId = this._ensureFolderPath(relativePath);
                this.query.insertDocument({
                    folderId, nodeId, globalHash,
                    relativePath: fileRelPath, absolutePath: absPath, name: resolvedName,
                    encoding: 'UTF-8'
                });
                const parentFolder = this.query.getFolderById(folderId);
                if (parentFolder?.node_id) this.query.insertInheritance(parentFolder.node_id, nodeId);
            })();
        } catch (err) {
            this.files.delete(fileRelPath, false);
            throw err;
        }
        await sealEmitter.create(fileRelPath + '.flashback', [fileRelPath]);
    }

    async createFolder(name, relativePath = "") {
        const folderRelPath = path.join(relativePath, name);
        const globalHash = this.files.createFolder(relativePath, name);

        try {
            const absPath = this.files.safePath(folderRelPath);
            db.transaction(() => {
                const nodeId = this.query.createNode('Folder');
                const parentId = this._ensureFolderPath(relativePath);
                this.query.insertFolder({
                    nodeId, globalHash, parentId, relativePath: folderRelPath, absolutePath: absPath, name
                });
                const parentFolder = this.query.getFolderById(parentId);
                if (parentFolder?.node_id) this.query.insertInheritance(parentFolder.node_id, nodeId);
            })();
        } catch (err) {
            this.files.delete(folderRelPath, true);
            throw err;
        }
        await sealEmitter.create(path.join(folderRelPath, '.flashback'));
    }

    async rename(relativePath, newName, isFolder = false) {
        const oldAbsPath = this.files.safePath(relativePath);
        const parentDir = path.dirname(relativePath);
        const newRelPath = path.join(parentDir, newName);
        const newAbsPath = this.files.safePath(newRelPath);

        this.files.rename(relativePath, newName, isFolder);

        try {
            db.transaction(() => {
                if (isFolder) {
                    this.query.renameFolderRecord(newName, newRelPath, newAbsPath, oldAbsPath);
                    this.query.cascadeRenameDocumentPaths(relativePath, newRelPath, oldAbsPath, newAbsPath);
                    this.query.cascadeRenameFolderPaths(relativePath, newRelPath, oldAbsPath, newAbsPath);
                } else {
                    this.query.renameDocumentRecord(newName, newRelPath, newAbsPath, oldAbsPath);
                }
            })();
        } catch (err) {
            this.files.rename(newRelPath, path.basename(relativePath), isFolder);
            throw err;
        }
        if (isFolder) {
            const { removed, added } = this._buildMovePaths(relativePath, newRelPath, newAbsPath);
            await sealEmitter.move(relativePath, newRelPath, removed, added);
        } else {
            await sealEmitter.move(relativePath, newRelPath,
                [relativePath, relativePath + '.flashback'],
                [newRelPath, newRelPath + '.flashback']
            );
        }
    }

    async move(relativePath, newRelativePath, isFolder = false) {
        const oldAbsPath = this.files.safePath(relativePath);
        const newAbsPath = this.files.safePath(newRelativePath);
        const oldParentAbsPath = path.dirname(oldAbsPath);
        const newParentAbsPath = path.dirname(newAbsPath);

        this.files.move(relativePath, newRelativePath, isFolder);

        try {
            db.transaction(() => {
                if (!isFolder) {
                    const newFolderId = this._getParentFolderId(newAbsPath);
                    this.query.moveDocumentRecord(newFolderId, newRelativePath, newAbsPath, oldAbsPath);
                    const childNodeId = this.query.getNodeIdByDocumentAbsPath(newAbsPath);
                    if (childNodeId) {
                        const oldParentNodeId = this.query.getNodeIdByFolderAbsPath(oldParentAbsPath);
                        const newParentNodeId = this.query.getNodeIdByFolderAbsPath(newParentAbsPath);
                        if (oldParentNodeId) this.query.deleteInheritance(oldParentNodeId, childNodeId);
                        if (newParentNodeId) this.query.insertInheritance(newParentNodeId, childNodeId);
                    }
                } else {
                    const newParentId = this._getParentFolderId(newAbsPath);
                    this.query.moveFolderRecord(newRelativePath, newAbsPath, oldAbsPath, newParentId);
                    this.query.cascadeRenameDocumentPaths(relativePath, newRelativePath, oldAbsPath, newAbsPath);
                    this.query.cascadeRenameFolderPaths(relativePath, newRelativePath, oldAbsPath, newAbsPath);
                    const childNodeId = this.query.getNodeIdByFolderAbsPath(newAbsPath);
                    if (childNodeId) {
                        const oldParentNodeId = this.query.getNodeIdByFolderAbsPath(oldParentAbsPath);
                        const newParentNodeId = this.query.getNodeIdByFolderAbsPath(newParentAbsPath);
                        if (oldParentNodeId) this.query.deleteInheritance(oldParentNodeId, childNodeId);
                        if (newParentNodeId) this.query.insertInheritance(newParentNodeId, childNodeId);
                    }
                }
            })();
        } catch (err) {
            this.files.move(newRelativePath, relativePath, isFolder);
            throw err;
        }
        if (isFolder) {
            const { removed, added } = this._buildMovePaths(relativePath, newRelativePath, newAbsPath);
            await sealEmitter.move(relativePath, newRelativePath, removed, added);
        } else {
            await sealEmitter.move(relativePath, newRelativePath,
                [relativePath, relativePath + '.flashback'],
                [newRelativePath, newRelativePath + '.flashback']
            );
        }
    }

    async updateFile(relativePath, content, metadata) {
        this.files.updateFile(relativePath, content, metadata);

        if (metadata) {
            const doc = this.query.getDocumentByPath(relativePath);
            if (!doc) throw new Error(`Document ${relativePath} not found in DB`);

            db.transaction(() => {
                if (metadata.tags) this._syncTags(doc.node_id, metadata.tags);
                if (metadata.flashcards) this._syncDocumentFlashcards(doc.id, metadata.flashcards);
                if (metadata.highlights) highlightsService.syncFromSidecar(doc.id, metadata.highlights);

                const folderId = doc.folder_id;
                if (folderId) {
                    const folder = this.query.getFolderById(folderId);
                    if (folder) {
                        const folderRelPath = path.relative(this.files.workspaceRoot, folder.absolute_path);
                        const folderMeta = this.files.getMetadata(folderRelPath, true) || {};
                        this._propagateFolderTags(folder.id, folder.node_id, folderMeta);
                    }
                }
            })();
        }
        await sealEmitter.edit(relativePath + '.flashback', [relativePath]);
        // Sync link connections whenever content changes (not metadata-only saves)
        if (content !== undefined && content !== null) {
            await this.syncDocumentLinks(relativePath);
        }
    }

    // --- Document Links ---

    // Regex that matches [anchor text](flashback://hash) in Markdown content.
    static _LINK_RE = /\[([^\]]*)\]\(flashback:\/\/([a-f0-9-]+)\)/g;

    // Parses flashback:// links out of a document's content. Returns null for
    // non-text files or unreadable content (a signal to skip link handling
    // entirely), otherwise an array (possibly empty) of {anchorText, targetHash}.
    _extractLinks(relPath) {
        const ext = path.extname(relPath).toLowerCase();
        if (!['.md', '.txt', '.markdown'].includes(ext)) return null;
        let content;
        try {
            ({ content } = this.files.readFile(relPath));
        } catch {
            return null;
        }
        const found = [];
        for (const m of (content ?? '').matchAll(Documents._LINK_RE)) {
            found.push({ anchorText: m[1], targetHash: m[2] });
        }
        return found;
    }

    // Writes the sidecar's links array, but only when it actually changed —
    // returns true if a write happened. Does NOT emit a Seal event: callers seal
    // this write themselves, and must do so BEFORE their own create/edit commit
    // so the sealed sidecar matches what is on disk (otherwise a post-seal link
    // write shows up as permanent out-of-band drift). Skips no-op text files so a
    // save with no link changes never touches the sidecar.
    _writeSidecarLinks(relPath, links) {
        if (links === null) return false;
        const sidecar = this.files.getMetadata(relPath, false) ?? {};
        if (JSON.stringify(sidecar.links ?? []) === JSON.stringify(links)) return false;
        sidecar.links = links;
        this.files.writeMetadata(relPath, sidecar, false);
        return true;
    }

    // Materializes a document's outbound links in the derived layer: resolved
    // targets become Connections, unresolved ones queue in DocumentLinks for lazy
    // resolution on a future import. DB-only — never touches disk.
    _writeLinkConnections(doc, links) {
        db.transaction(() => {
            this.query.deleteDocumentLinkConnections(doc.node_id);
            this.query.deleteDocumentLinkQueueBySource(doc.global_hash);
            for (const { anchorText, targetHash } of (links ?? [])) {
                const target = this.query.getDocumentByHash(targetHash);
                if (target) {
                    this.query.insertDocumentLinkConnection(doc.node_id, target.node_id);
                } else {
                    this.query.upsertDocumentLinkQueue(doc.global_hash, targetHash, anchorText);
                }
            }
        })();
    }

    // Write path (real content saves): refresh the sidecar's links array from the
    // document's content and sync the derived layer. The sidecar write is sealed
    // as its own follow-up edit only when the links changed, so link-free saves
    // and metadata-only saves add no drift.
    async syncDocumentLinks(relPath) {
        const links = this._extractLinks(relPath);
        if (links === null) return;
        if (this._writeSidecarLinks(relPath, links)) {
            await sealEmitter.edit(relPath + '.flashback');
        }
        const doc = this.query.getDocumentByPath(relPath);
        if (doc) this._writeLinkConnections(doc, links);
    }

    // Read-only path (Vault Doctor): re-derive a document's link Connections from
    // its content without writing the sidecar or emitting a Seal event.
    indexDocumentLinks(relPath) {
        const links = this._extractLinks(relPath);
        if (links === null) return;
        const doc = this.query.getDocumentByPath(relPath);
        if (doc) this._writeLinkConnections(doc, links);
    }

    // When a document is indexed, resolve any pending DocumentLinks that were
    // waiting for it, then index its own outbound links. DB-only: the caller owns
    // the sidecar's links write (importFile does it before sealing; a live save
    // goes through syncDocumentLinks).
    async _resolvePendingLinks(globalHash, nodeId, relPath) {
        const pending = this.query.getPendingLinksForTarget(globalHash);
        if (pending.length > 0) {
            db.transaction(() => {
                for (const row of pending) {
                    const sourceDoc = this.query.getDocumentByHash(row.source_hash);
                    if (sourceDoc) {
                        this.query.insertDocumentLinkConnection(sourceDoc.node_id, nodeId);
                        this.query.deleteDocumentLinkQueueBySource(row.source_hash);
                        // Re-queue remaining entries from this source that are still unresolved
                        const remaining = this.query.getPendingLinksFromSource(row.source_hash);
                        for (const r of remaining) {
                            this.query.upsertDocumentLinkQueue(r.source_hash, r.target_hash, r.anchor_text);
                        }
                    }
                }
            })();
        }
        // Index this document's own outbound links into the derived layer (DB-only).
        this.indexDocumentLinks(relPath);
    }

    async delete(relativePath, isFolder = false) {
        const absPath = this.files.safePath(relativePath);

        // 1. Gather seal paths from DB before deleting anything
        const sealExtra = isFolder
            ? this._gatherFolderContents(relativePath, absPath)
            : [relativePath];

        // 2. Delete from DB first — if this fails, FS is still intact
        db.transaction(() => {
            if (isFolder) {
                this.query.deleteFolderTree(absPath, path.sep);
            } else {
                this.query.deleteDocumentByAbsPath(absPath);
            }
        })();

        // 3. Delete from FS — DB is already clean; any FS orphan is recoverable via inspect()
        this.files.delete(relativePath, isFolder);

        // 4. Commit to Seal
        const sealSidecar = isFolder ? path.join(relativePath, '.flashback') : relativePath + '.flashback';
        await sealEmitter.delete(sealSidecar, sealExtra);
    }

    async copy(relPath, newRelPath, isFolder = false) {
        const items = this.files.copy(relPath, newRelPath, isFolder);

        db.transaction(() => {
            for (const item of items) {
                const sidecar = this.files.getMetadata(item.relativePath, item.type === 'folder');

                if (item.type === 'folder') {
                    const nodeId = this.query.createNode('Folder');
                    const parentId = this._getParentFolderId(item.absolutePath);
                    this.query.insertFolder({
                        nodeId,
                        globalHash: item.globalHash,
                        parentId,
                        relativePath: item.relativePath,
                        absolutePath: item.absolutePath,
                        name: item.name,
                    });
                    if (sidecar?.tags) this._syncTags(nodeId, sidecar.tags);
                } else {
                    const nodeId = this.query.createNode('Document');
                    const folderId = this._getParentFolderId(item.absolutePath);
                    const info = this.query.insertDocument({
                        folderId,
                        nodeId,
                        globalHash: item.globalHash,
                        relativePath: item.relativePath,
                        absolutePath: item.absolutePath,
                        name: item.name,
                    });
                    if (sidecar?.tags) this._syncTags(nodeId, sidecar.tags);
                    if (sidecar?.flashcards) this._syncDocumentFlashcards(info.lastInsertRowid, sidecar.flashcards);
                    if (sidecar?.highlights) highlightsService.syncFromSidecar(info.lastInsertRowid, sidecar.highlights);
                }
            }
        })();

        const sidecarPaths = items.map(i =>
            i.type === 'folder'
                ? path.join(i.relativePath, '.flashback')
                : i.relativePath + '.flashback'
        );
        const docPaths = [];
        for (const i of items) { if (i.type === 'file') docPaths.push(i.relativePath); }
        const rootSidecar = sidecarPaths[0];
        await sealEmitter.create(rootSidecar, [...sidecarPaths.slice(1), ...docPaths]);
    }

    // --- Metadata Helpers ---

    async updateMetadata(relativePath, metadata, isFolder = false) {
        this.files.writeMetadata(relativePath, metadata, isFolder);

        db.transaction(() => {
            const entity = isFolder ? this.query.getFolderByPath(relativePath) : this.query.getDocumentByPath(relativePath);
            if (!entity) throw new Error(`Entity ${relativePath} not found`);

            if (isFolder) this.query.updateFolderMetadata(entity.id, metadata);
            else this.query.updateDocumentMetadata(entity.id, metadata);

            if (metadata.tags) this._syncTags(entity.node_id, metadata.tags);
            if (!isFolder && metadata.flashcards) this._syncDocumentFlashcards(entity.id, metadata.flashcards);
            if (!isFolder && metadata.highlights) highlightsService.syncFromSidecar(entity.id, metadata.highlights);

            if (!isFolder && metadata.tags !== undefined) {
                // Propagate to flashcards: document's own tags + any inherited from parent folders.
                const inherited = this.query.getInheritedTagNames(entity.node_id);
                const effective = [...new Set([...inherited, ...(metadata.tags || [])])];
                this._propagateTagsToFlashcards(entity.id, entity.node_id, effective);
            }

            if (isFolder) this._propagateFolderTags(entity.id, entity.node_id, metadata);
        })();

        const sidecar = isFolder ? path.join(relativePath, '.flashback') : relativePath + '.flashback';
        await sealEmitter.edit(sidecar);
    }

    // --- Import / Export ---

    async importFile(name, relativePath, content, metadata) {
        const { name: resolvedName } = this.files.createFile(relativePath, name);
        const fileRelPath = path.join(relativePath, resolvedName);
        const encoding = this.files.updateFile(fileRelPath, content, metadata);

        try {
            const absPath = this.files.safePath(fileRelPath);
            // When the caller's metadata carries no identity of its own (a blank
            // template, e.g. webclip/youtube), adopt the real globalHash createFile
            // assigned to the sidecar so the derived row matches the canonical file.
            // Blank ("") hashes would otherwise collide on the second such import.
            const registerMeta = metadata?.globalHash
                ? metadata
                : { ...metadata, globalHash: this.files.getMetadata(fileRelPath)?.globalHash };
            this._registerDocumentDerived({ name, fileRelPath, absPath, encoding, metadata: registerMeta });
        } catch (err) {
            this.files.delete(fileRelPath, false);
            throw err;
        }

        // Fold any flashback:// links into the sidecar BEFORE sealing, so the
        // single create commit captures them — a post-seal link write would leave
        // the sidecar permanently diverged from its sealed version (out-of-band drift).
        this._writeSidecarLinks(fileRelPath, this._extractLinks(fileRelPath));
        await sealEmitter.create(fileRelPath + '.flashback', [fileRelPath]);

        // Resolve any pending DocumentLinks targeting this doc, and index its own outbound links.
        const imported = this.query.getDocumentByPath(fileRelPath);
        if (imported) {
            await this._resolvePendingLinks(imported.global_hash, imported.node_id, fileRelPath);
        }

        // Return the resolved location + canonical (sidecar) identity so callers that
        // synthesize documents (webclip / youtube) can report the created path and hash.
        return { path: fileRelPath, globalHash: this.files.getMetadata(fileRelPath)?.globalHash };
    }

    // Registers a document's full derived-layer state (row, inheritance, tags,
    // flashcards, highlights) from its sidecar payload in one transaction. The
    // DB-only core of importFile, shared with the Vault Doctor's ingest path —
    // it never touches the filesystem and never emits Seal events.
    _registerDocumentDerived({ name, fileRelPath, absPath, encoding, metadata }) {
        const parentAbsPath = path.dirname(absPath);
        return db.transaction(() => {
            const nodeId = this.query.createNode('Document');
            const folderId = this._getParentFolderId(absPath);
            const info = this.query.insertDocument({
                folderId, nodeId, globalHash: metadata.globalHash,
                relativePath: fileRelPath, absolutePath: absPath, name,
                encoding
            });
            const docId = info.lastInsertRowid;

            const parentNodeId = this.query.getNodeIdByFolderAbsPath(parentAbsPath);
            if (parentNodeId) this.query.insertInheritance(parentNodeId, nodeId);

            if (metadata.tags) this._syncTags(nodeId, metadata.tags);
            if (metadata.flashcards) this._syncDocumentFlashcards(docId, metadata.flashcards);
            if (metadata.highlights) highlightsService.syncFromSidecar(docId, metadata.highlights);
            return docId;
        })();
    }

    // --- Custom captured formats (webclip / youtube) ---
    //
    // Both build a full sidecar (default template + a `source` block) plus a
    // body string, then delegate to the importFile pipeline (disk → sidecar →
    // DB → Seal). The DB layer only syncs known sidecar keys; the extra `source`
    // key rides along on disk untouched.

    // Builds the `.youtube` body + `source` block from a URL. Fetches oEmbed
    // metadata (title/author/thumbnail) best-effort — offline just falls back to
    // the video id. Throws on a URL with no extractable id.
    async _buildYoutubeDoc(url) {
        const videoId = extractYoutubeId(url);
        if (!videoId) throw new Error("Invalid YouTube URL");

        let title = "", author = "", thumbnailUrl = "";
        try {
            const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
            const resp = await fetch(oembedUrl);
            if (resp.ok) {
                const data = await resp.json();
                title = data.title || "";
                author = data.author_name || "";
                thumbnailUrl = data.thumbnail_url || "";
            }
        } catch { /* offline / blocked — fall back to the id */ }

        const body = JSON.stringify({ url, videoId, title, author, thumbnailUrl }, null, 2);
        const source = { url, videoId, title, author, clippedAt: new Date().toISOString() };
        return { videoId, title, body, source };
    }

    /**
     * Captures a YouTube URL as a new `.youtube` reference document. The body is
     * a small JSON descriptor the renderer embeds; highlights anchor to
     * timestamps (seconds), not text.
     * @param {string} url
     * @param {string} [relativePath=""] destination folder
     * @returns {Promise<{path: string, globalHash: string}>}
     */
    async createYoutube(url, relativePath = "") {
        const { videoId, title, body, source } = await this._buildYoutubeDoc(url);
        const metadata = { ...newFileMetadata(), source };
        const name = slugifyName(title || videoId) + ".youtube";
        return this.importFile(name, relativePath, body, metadata);
    }

    /**
     * Populates an existing (e.g. blank, hand-created) `.youtube` file from a
     * URL — writes the descriptor body and merges the `source` block into the
     * sidecar, preserving existing highlights/tags. Used by the renderer's
     * empty-state URL form so a `.youtube` created via "New file" isn't a dead end.
     * @param {string} relPath existing `.youtube` file
     * @param {string} url
     */
    async setYoutubeSource(relPath, url) {
        if (!this.files.exists(relPath)) throw new Error("File not found");
        const { body, source } = await this._buildYoutubeDoc(url);
        const existing = this.files.getMetadata(relPath) || newFileMetadata();
        this.files.updateFile(relPath, body, { ...existing, source });
        await sealEmitter.edit(relPath + '.flashback', [relPath]);
        return { path: relPath, globalHash: this.files.getMetadata(relPath)?.globalHash };
    }

    // Fetches a video's caption track from YouTube and returns transcript cues.
    // This is the fragile part — no official API exists for third-party captions.
    // The watch page's own caption URLs now require a proof-of-origin token and come
    // back empty, so we ask the innertube ANDROID player API (its caption URLs still
    // serve content) and force the timedtext json3 format. Isolated here so it can be
    // swapped for a library if the endpoint changes; the parsing steps are pure/exported.
    async _fetchYoutubeTranscript(videoId, lang) {
        const noCaptions = (msg) => Object.assign(new Error(msg), { status: 422 });

        // Public innertube key for the ANDROID client (stable, ships in the app).
        const ANDROID_KEY = 'AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w';
        const player = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${ANDROID_KEY}`, {
            method: 'POST',
            headers: {
                'User-Agent': 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30, hl: lang || 'en', gl: 'US' } },
                videoId,
            }),
        }).then((r) => (r.ok ? r.json() : null)).catch(() => null);

        if (!player) throw noCaptions("Could not reach YouTube to read this video's captions.");
        const status = player.playabilityStatus?.status;
        if (status && status !== 'OK') {
            const reason = player.playabilityStatus?.reason ? `: ${player.playabilityStatus.reason}` : '';
            throw noCaptions(`YouTube won't serve this video (${status}${reason}), so its captions are unavailable.`);
        }

        const track = pickCaptionTrack(player, lang);
        if (!track?.baseUrl) throw noCaptions("This video has no captions to transcribe.");

        // The track URL defaults to srv3 XML and already carries fmt=srv3 — replace it
        // (don't append) so we get json3 JSON that parseJson3Transcript understands.
        let url;
        try { url = new URL(track.baseUrl); } catch { throw noCaptions("This video's caption track URL was malformed."); }
        url.searchParams.set('fmt', 'json3');
        const resp = await fetch(url.href, { headers: { 'User-Agent': 'Mozilla/5.0 (Flashback transcript fetcher)' } });
        if (!resp.ok) throw noCaptions(`Could not download the caption track (${resp.status}).`);
        const cues = parseJson3Transcript(await resp.text());
        if (cues.length === 0) throw noCaptions("The caption track came back empty.");

        return { cues, lang: track.languageCode || (lang ?? 'und'), kind: track.kind === 'asr' ? 'asr' : 'manual' };
    }

    /**
     * Fetches a `.youtube` document's caption transcript from YouTube and stores it
     * in the sidecar's `source` block (`source.transcript` + `source.transcriptMeta`),
     * making the video's spoken content readable via mcpReader / read_document_text
     * and resolvable from its timestamp highlights. Metadata-only — the body descriptor
     * is untouched — so it writes and seals the sidecar directly, like setYoutubeSource.
     * @param {string} relPath existing `.youtube` file
     * @param {object} [opts]
     * @param {string} [opts.lang] preferred caption language code (e.g. "en", "es")
     * @returns {Promise<{path: string, cues: number, lang: string, kind: string}>}
     * @throws {Error & {status:422}} when the video has no usable captions
     */
    async fetchYoutubeTranscript(relPath, { lang } = {}) {
        if (!this.files.exists(relPath)) throw Object.assign(new Error("File not found"), { status: 404 });
        const existing = this.files.getMetadata(relPath) || newFileMetadata();

        // videoId lives in the sidecar source, but fall back to the body descriptor
        // (a hand-created stub may only have it there).
        let videoId = existing.source?.videoId;
        if (!videoId) {
            try { videoId = JSON.parse(this.files.readFile(relPath).content ?? '{}').videoId; } catch { /* no body id */ }
        }
        if (!videoId) throw Object.assign(new Error("This document has no YouTube video id."), { status: 400 });

        const { cues, lang: gotLang, kind } = await this._fetchYoutubeTranscript(videoId, lang);
        const merged = {
            ...existing,
            source: {
                ...existing.source,
                transcript: cues,
                transcriptMeta: { lang: gotLang, kind, fetchedAt: new Date().toISOString() },
            },
        };
        this.files.writeMetadata(relPath, merged);
        await sealEmitter.edit(relPath + '.flashback');
        return { path: relPath, cues: cues.length, lang: gotLang, kind };
    }

    // Fetches a page, extracts its readable article, caches its images into
    // `<mediaFolder>/media/`, and returns the sanitized HTML + `source` block +
    // the cached media rel-paths. `mediaFolder` is the folder the clip lives in
    // (media/ is a sibling of the clip file). Throws on fetch/extraction failure.
    async _buildClipDoc(url, mediaFolder) {
        let html;
        try {
            const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Flashback webclipper)' } });
            if (!resp.ok) throw new Error(`status ${resp.status}`);
            html = await resp.text();
        } catch (err) {
            throw new Error(`Failed to fetch: ${err.message}`);
        }

        const { JSDOM } = await import('jsdom');
        const { Readability } = await import('@mozilla/readability');
        const sanitizeHtml = (await import('sanitize-html')).default;

        const dom = new JSDOM(html, { url });
        const doc = dom.window.document;
        const siteName = doc.querySelector('meta[property="og:site_name"]')?.getAttribute('content') || '';
        const article = new Readability(doc).parse();
        if (!article || !article.content) {
            throw new Error('Could not extract readable content from that page');
        }

        // Re-parse the article fragment with the page URL as base so relative
        // <img> src resolve to absolute URLs we can fetch.
        const contentDom = new JSDOM(`<body>${article.content}</body>`, { url });
        const cdoc = contentDom.window.document;

        const mediaRelPaths = [];
        const seen = new Map(); // absolute src -> ./media/<name>
        for (const img of Array.from(cdoc.querySelectorAll('img')).slice(0, MAX_CLIP_IMAGES)) {
            const raw = img.getAttribute('src') || '';
            let absSrc;
            try { absSrc = new URL(raw, url).href; } catch { continue; }
            if (!/^https?:/i.test(absSrc)) continue; // leave data:/other src untouched
            if (seen.has(absSrc)) { img.setAttribute('src', seen.get(absSrc)); img.removeAttribute('srcset'); continue; }
            try {
                const r = await fetch(absSrc);
                if (!r.ok) continue;
                const buf = Buffer.from(await r.arrayBuffer());
                if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) continue;
                const hash = crypto.createHash('sha256').update(buf).digest('hex');
                const ext = extFromContentType(r.headers.get('content-type')) || extFromUrl(absSrc) || 'img';
                const name = `clip-${hash.slice(0, 12)}.${ext}`;
                const mediaRel = path.join(mediaFolder, 'media', name);
                const mediaAbs = this.files.safePath(mediaRel);
                fs.mkdirSync(path.dirname(mediaAbs), { recursive: true });
                fs.writeFileSync(mediaAbs, buf);
                db.transaction(() => {
                    this.query.insertMedia({ hash, name, relativePath: mediaRel, absolutePath: mediaAbs });
                })();
                const localRef = `./media/${name}`;
                img.setAttribute('src', localRef);
                img.removeAttribute('srcset');
                seen.set(absSrc, localRef);
                mediaRelPaths.push(mediaRel);
            } catch { /* best-effort — leave the remote src in place */ }
        }

        const clean = sanitizeHtml(cdoc.body.innerHTML, CLIP_SANITIZE_OPTS);
        const source = {
            url,
            siteName: siteName || article.siteName || '',
            byline: article.byline || '',
            title: article.title || '',
            excerpt: article.excerpt || '',
            clippedAt: new Date().toISOString(),
        };
        return { html: clean, source, title: article.title || 'clip', mediaRelPaths };
    }

    /**
     * Fetches a web page and stores a readable, image-cached `.clip` snapshot.
     * Highlights anchor by text offset. See _buildClipDoc for the pipeline.
     * @param {string} url
     * @param {string} [relativePath=""] destination folder
     * @returns {Promise<{path: string, globalHash: string}>}
     */
    async createClip(url, relativePath = "") {
        const { html, source, title, mediaRelPaths } = await this._buildClipDoc(url, relativePath);
        const metadata = { ...newFileMetadata(), source };
        const name = slugifyName(title) + ".clip";
        const result = await this.importFile(name, relativePath, html, metadata);

        // importFile only sealed the clip + sidecar; stage the cached images too.
        if (mediaRelPaths.length && result?.path) {
            await sealEmitter.edit(result.path + '.flashback', mediaRelPaths);
        }
        return result;
    }

    /**
     * Populates an existing (e.g. blank, hand-created) `.clip` file from a URL —
     * fetches/parses the page, caches images alongside it, writes the sanitized
     * HTML body, and merges the `source` block into the sidecar (preserving
     * existing highlights/tags). Backs the renderer's empty-state URL form.
     * @param {string} relPath existing `.clip` file
     * @param {string} url
     */
    async setClipSource(relPath, url) {
        if (!this.files.exists(relPath)) throw new Error("File not found");
        const parent = path.dirname(relPath);
        const mediaFolder = parent === '.' ? '' : parent;
        const { html, source, mediaRelPaths } = await this._buildClipDoc(url, mediaFolder);
        const existing = this.files.getMetadata(relPath) || newFileMetadata();
        this.files.updateFile(relPath, html, { ...existing, source });
        await sealEmitter.edit(relPath + '.flashback', [relPath, ...mediaRelPaths]);
        return { path: relPath, globalHash: this.files.getMetadata(relPath)?.globalHash };
    }

    // --- Indexing (Vault Doctor) ---
    //
    // The derived SQLite layer is an index of the canonical files. These
    // methods make that index match what is already on disk. They never write
    // document content, never regenerate identities, and never emit Seal
    // events — sealing reconciled drift is the Doctor's decision, made once at
    // the end of a sync via SealTools.commitDrift().

    /**
     * Indexes a document that exists on disk (file + sidecar) but has no
     * derived-layer row. Reads only; the sidecar's globalHash and SRS state
     * are adopted as-is. Delegates to reindexDocument if the row already
     * exists, so it is safe to call for any on-disk document.
     * @param {string} relPath - document path relative to the workspace root.
     * @returns {Promise<number>} the document's DB id.
     */
    async indexDocument(relPath) {
        if (this.query.getDocumentByPath(relPath)) return this.reindexDocument(relPath);

        const metadata = this.files.getMetadata(relPath, false);
        if (!metadata?.globalHash) throw new Error(`No valid sidecar for ${relPath}`);

        const absPath = this.files.safePath(relPath);
        const parentDir = path.dirname(relPath);
        // _ensureFolderPath registers every missing ancestor folder (DB row +
        // sidecar backfill for ghost directories) so _getParentFolderId resolves.
        this._ensureFolderPath(parentDir === '.' ? '' : parentDir);
        const docId = this._registerDocumentDerived({
            name: path.basename(relPath),
            fileRelPath: relPath,
            absPath,
            encoding: metadata.encoding ?? null,
            metadata,
        });
        await this._resolvePendingLinks(metadata.globalHash, this.query.getDocumentByPath(relPath).node_id, relPath);
        return docId;
    }

    /**
     * Refreshes an existing document's index rows from its sidecar: adopts the
     * sidecar's globalHash (sidecar is canonical), diffs flashcards by hash with
     * max-merge of SRS progress (via _syncDocumentFlashcards — a level lowered
     * out-of-band never regresses the DB), and replaces tags/highlights/links
     * wholesale so out-of-band removals propagate too.
     * @param {string} relPath - document path relative to the workspace root.
     * @returns {Promise<number>} the document's DB id.
     */
    async reindexDocument(relPath) {
        const doc = this.query.getDocumentByPath(relPath);
        if (!doc) return this.indexDocument(relPath);

        const metadata = this.files.getMetadata(relPath, false);
        if (!metadata) throw new Error(`No readable sidecar for ${relPath}`);

        db.transaction(() => {
            if (metadata.globalHash && metadata.globalHash !== doc.global_hash) {
                this.query.updateDocumentMetadata(doc.id, { globalHash: metadata.globalHash });
            }
            this._syncTags(doc.node_id, metadata.tags ?? []);
            this._syncDocumentFlashcards(doc.id, metadata.flashcards ?? []);
            // query-level sync (not highlightsService.syncFromSidecar, which
            // no-ops on an empty array): out-of-band highlight deletions must
            // clear the derived rows as well.
            this.query.syncDocumentHighlights(doc.id, metadata.highlights ?? []);

            if (doc.folder_id) {
                const folder = this.query.getFolderById(doc.folder_id);
                if (folder) {
                    const folderRelPath = path.relative(this.files.workspaceRoot, folder.absolute_path);
                    const folderMeta = this.files.getMetadata(folderRelPath, true) || {};
                    this._propagateFolderTags(folder.id, folder.node_id, folderMeta);
                }
            }
        })();

        // Read-only: re-derive link Connections from content without rewriting the
        // sidecar or sealing — the Doctor reconciles the index, it doesn't mutate files.
        this.indexDocumentLinks(relPath);
        return doc.id;
    }

    /**
     * Indexes a folder that exists on disk (row for every missing ancestor
     * included) and syncs its tags + inheritance from its sidecar. Idempotent
     * for already-indexed folders.
     * @param {string} relPath - folder path relative to the workspace root ('' = root).
     * @returns {number} the folder's DB id.
     */
    indexFolder(relPath) {
        const folderId = this._ensureFolderPath(relPath);
        const folder = this.query.getFolderById(folderId);
        const metadata = this.files.getMetadata(relPath, true) || {};

        db.transaction(() => {
            if (metadata.globalHash && metadata.globalHash !== folder.global_hash) {
                this.query.updateFolderMetadata(folder.id, { globalHash: metadata.globalHash });
            }
            if (folder.node_id) this._syncTags(folder.node_id, metadata.tags ?? []);
            this._propagateFolderTags(folder.id, folder.node_id, metadata);
        })();
        return folderId;
    }

    /**
     * Removes a document's or folder tree's index rows for an item already
     * deleted on disk. DB-only counterpart of delete(): no filesystem call, no
     * Seal event. Folder FK cascades clean up contained documents/flashcards.
     * @param {string} relPath - path relative to the workspace root.
     * @param {boolean} [isFolder=false]
     */
    removeFromIndex(relPath, isFolder = false) {
        const absPath = this.files.safePath(relPath);
        db.transaction(() => {
            if (isFolder) {
                this.query.deleteFolderTree(absPath, path.sep);
            } else {
                this.query.deleteDocumentByAbsPath(absPath);
            }
        })();
    }

    async importPackage(externalPath, targetRelPath = "") {
        const folderName = path.basename(externalPath);
        const folderRelPath = path.join(targetRelPath, folderName);
        
        const nodeId = this.query.createNode('Folder');
        const absPath = this.files.safePath(folderRelPath);
        const globalHash = crypto.randomUUID();
        const parentId = this._getParentFolderId(absPath);

        if (!fs.existsSync(absPath)) fs.mkdirSync(absPath, { recursive: true });

        this.query.insertFolder({
            nodeId, globalHash, parentId, relativePath: folderRelPath, absolutePath: absPath, name: folderName
        });

        // Apply Metadata for Root if exists
        const rootMetaPath = path.join(externalPath, ".flashback");
        if (fs.existsSync(rootMetaPath)) {
            try {
                const raw = fs.readFileSync(rootMetaPath, 'utf-8');
                const meta = JSON.parse(raw);
                delete meta.lastRecall;
                delete meta.level;
                delete meta.easeFactor;
                meta.presence = 0;
                meta.globalHash = globalHash;
                await this.updateMetadata(folderRelPath, meta, true);
            } catch (err) {
                console.warn("Failed to import root metadata:", err);
            }
        }

        const crawl = async (src, destRel) => {
            const entries = fs.readdirSync(src, { withFileTypes: true });
            for (const entry of entries) {
                const srcPath = path.join(src, entry.name);
                const entryRel = path.join(destRel, entry.name);

                if (entry.name === ".flashback" || entry.name.endsWith(".flashback")) continue;

                if (entry.isDirectory()) {
                    if (entry.name === "media") {
                        const mediaDestAbs = this.files.safePath(entryRel);
                        if (!fs.existsSync(mediaDestAbs)) fs.mkdirSync(mediaDestAbs, { recursive: true });
                        for (const mFile of fs.readdirSync(srcPath)) {
                            const mSrc = path.join(srcPath, mFile);
                            const mDest = path.join(mediaDestAbs, mFile);
                            
                            if (fs.lstatSync(mSrc).isFile()) {
                                fs.copyFileSync(mSrc, mDest);
                                const mBuf = fs.readFileSync(mDest);
                                const mHash = crypto.createHash('sha256').update(mBuf).digest('hex');
                                this.query.insertMedia({
                                    hash: mHash, name: mFile, relativePath: path.join(entryRel, mFile), absolutePath: mDest
                                });
                            }
                        }
                    } else {
                        const subNodeId = this.query.createNode('Folder');
                        const subAbs = this.files.safePath(entryRel);
                        if (!fs.existsSync(subAbs)) fs.mkdirSync(subAbs, { recursive: true });
                        const subParentId = this._getParentFolderId(subAbs);
                        this.query.insertFolder({
                            nodeId: subNodeId, globalHash: crypto.randomUUID(), parentId: subParentId, relativePath: entryRel, absolutePath: subAbs, name: entry.name
                        });

                        const metaFile = path.join(srcPath, ".flashback");
                        let meta = { globalHash: crypto.randomUUID() };
                        if (fs.existsSync(metaFile)) {
                            meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
                            delete meta.lastRecall; delete meta.level; delete meta.easeFactor; meta.presence = 0;
                            meta.globalHash = crypto.randomUUID();
                        }
                        await this.updateMetadata(entryRel, meta, true);
                        await crawl(srcPath, entryRel);
                    }
                } else {
                    const content = fs.readFileSync(srcPath, 'utf-8');
                    let meta = { globalHash: crypto.randomUUID() };
                    const metaFile = srcPath + ".flashback";
                    if (fs.existsSync(metaFile)) {
                        meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
                        meta.globalHash = crypto.randomUUID();
                        if (meta.flashcards) {
                            meta.flashcards.forEach(fc => {
                                fc.globalHash = crypto.randomUUID();
                                fc.level = 0;
                                delete fc.lastRecall;
                                delete fc.fsrsStability; delete fc.fsrsDifficulty; delete fc.fsrsDue;
                                delete fc.fsrsState; delete fc.fsrsReps; delete fc.fsrsLapses;
                            });
                        }
                    }
                    await this.importFile(entry.name, destRel, content, meta);
                }
            }
        };
        await crawl(externalPath, folderRelPath);
    }

    async processZipPackage(zipFilePath, targetRelPath = "") {
        const tempId = crypto.randomUUID();
        const zipName = path.basename(zipFilePath, '.zip');
        const tempRoot = path.join(os.tmpdir(), 'flashback_imports', tempId);
        const extractPath = path.join(tempRoot, zipName);

        fs.mkdirSync(extractPath, { recursive: true });
        const zip = new AdmZip(zipFilePath);
        zip.extractAllTo(extractPath, true);

        let pkgPath = extractPath;
        const entries = fs.readdirSync(extractPath, { withFileTypes: true }).filter(e => !e.name.startsWith('.'));
        if (entries.length === 1 && entries[0].isDirectory()) pkgPath = path.join(extractPath, entries[0].name);

        try {
            await this.importPackage(pkgPath, targetRelPath);
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    }

    exportPackage(relativePath) {
        const sourcePath = this.files.safePath(relativePath);
        const zip = new AdmZip();
        zip.addLocalFolder(sourcePath, path.basename(sourcePath));
        const zipPath = path.join(os.tmpdir(), `${path.basename(sourcePath)}_${Date.now()}.zip`);
        zip.writeZip(zipPath);
        return zipPath;
    }

    // --- Flashcards ---

    /**
     * Creates a single vanilla flashcard in a document's sidecar and attaches any
     * provided media in one atomic operation, so the UI never has to sequence
     * "create card → read back hash → upload media". The card's globalHash is
     * API-assigned at write time and returned to the caller.
     *
     * @param {string} relativePath - relative path to the target document.
     * @param {object} cardData - the card object (front/back text, tags, category,
     *   location, …). Any client-supplied globalHash is ignored — the API owns it.
     * @param {Array<{ buffer: Buffer, originalName: string, type: "image"|"sound", position: "front"|"back" }>} [mediaItems=[]]
     * @returns {object} The persisted card, including its assigned globalHash and media refs.
     */
    async createFlashcard(relativePath, cardData, mediaItems = []) {
        const doc = this.query.getDocumentByPath(relativePath);
        if (!doc) throw new Error(`Document ${relativePath} not found in DB`);

        // Reject an unrecognized category up front rather than silently writing it
        // to the sidecar with no matching category_id in the DB — a mismatch here
        // used to persist as a split-brain (sidecar keeps the literal string forever,
        // the derived layer silently links to no category) with no error surfaced.
        if (cardData.category && !this.query.getCategoryByName(cardData.category)) {
            throw new Error(`Unknown category: "${cardData.category}". Call GET /api/categories for valid values.`);
        }

        // 1. Append the card; writeMetadata assigns its immutable globalHash.
        const meta = this.files.getMetadata(relativePath) || {};
        if (!Array.isArray(meta.flashcards)) meta.flashcards = [];
        const card = { ...cardData };
        delete card.globalHash; // API-owned
        // Provenance marker: 'ai' is the only recognized value ("created by an
        // AI assistant", set by the MCP server). Anything else is dropped.
        if (card.origin !== 'ai') delete card.origin;
        meta.flashcards.push(card);
        const cardIndex = meta.flashcards.length - 1;
        this.files.writeMetadata(relativePath, meta, false);

        // 2. Write each media file + patch the card's vanillaData.media (Files layer).
        //    Names are generated server-side to stay collision-free in the shared media/ dir.
        const mediaRels = [];
        const registered = [];
        for (const m of mediaItems) {
            const ext = path.extname(m.originalName || '');
            const base = path.basename(m.originalName || 'media', ext).replace(/[^\w.-]+/g, '_') || 'media';
            const name = `${base}-${crypto.randomUUID().slice(0, 8)}${ext}`;

            this.files.addVanillaData(relativePath, m.buffer, name, m.type, m.position, cardIndex);

            const mediaRel = path.join(path.dirname(relativePath), 'media', name);
            mediaRels.push(mediaRel);
            registered.push({ name, mediaRel, hash: crypto.createHash('sha256').update(m.buffer).digest('hex') });
        }

        // 3. Sync the derived layer (tags + flashcards + media) in one transaction.
        const finalMeta = this.files.getMetadata(relativePath);
        const savedCard = finalMeta.flashcards[cardIndex];
        db.transaction(() => {
            if (finalMeta.tags) this._syncTags(doc.node_id, finalMeta.tags);
            this._syncDocumentFlashcards(doc.id, finalMeta.flashcards);
            for (const r of registered) {
                this.query.insertMedia({
                    hash: r.hash, name: r.name,
                    relativePath: r.mediaRel, absolutePath: this.files.safePath(r.mediaRel),
                });
            }
        })();

        // 4. One Seal commit covering the sidecar and every new media file.
        await sealEmitter.edit(relativePath + '.flashback', mediaRels);
        return savedCard;
    }

    // --- Media ---

    async addMediaToFlashcard(relativePath, flashcardHash, mediaBuffer, mediaName) {
        const meta = this.files.getMetadata(relativePath);
        const cardIdx = meta.flashcards.findIndex(f => f.globalHash === flashcardHash);
        if (cardIdx === -1) throw new Error(`Flashcard ${flashcardHash} not found`);

        this.files.addCustomMedia(relativePath, mediaBuffer, mediaName, cardIdx);

        const mediaRel = path.join(path.dirname(relativePath), "media", mediaName);
        const mediaAbs = this.files.safePath(mediaRel);
        const hash = crypto.createHash('sha256').update(mediaBuffer).digest('hex');

        db.transaction(() => {
            this.query.insertMedia({ hash, name: mediaName, relativePath: mediaRel, absolutePath: mediaAbs });
        })();
        await sealEmitter.edit(relativePath + '.flashback', [mediaRel]);
    }

    // --- SRS Support ---

    async submitReview(relativePath, flashcardHash, outcome, easeFactor, newLevel, algorithm = 'leitner', opts = {}) {
        const metadata = this.files.getMetadata(relativePath);
        const card = metadata?.flashcards?.find(f => f.globalHash === flashcardHash);
        if (!card) throw new Error(`Flashcard ${flashcardHash} not found in sidecar for ${relativePath}`);

        // Persist to the derived layer first. For FSRS the schedule is computed
        // server-side, so we mirror the returned state into the sidecar; for
        // Leitner/SM-2 the client-computed scalar is authoritative.
        const { documentId, fsrs } = this.srs.submitReview(
            flashcardHash, outcome, easeFactor, newLevel, algorithm, opts,
        );

        if (algorithm === 'fsrs' && fsrs) {
            card.fsrsStability = fsrs.stability;
            card.fsrsDifficulty = fsrs.difficulty;
            card.fsrsDue = fsrs.due;
            card.fsrsState = fsrs.state;
            card.fsrsReps = fsrs.reps;
            card.fsrsLapses = fsrs.lapses;
            card.level = fsrs.level;   // display-strength scalar, derived from the interval
            card.lastRecall = fsrs.last_review;
        } else {
            if (algorithm === 'sm2') card.sm2Reps = newLevel; else card.level = newLevel;
            card.easeFactor = easeFactor;
            card.lastRecall = new Date().toISOString();
        }
        this.files.writeMetadata(relativePath, metadata);

        this.propagatePresence(documentId);
        await sealEmitter.edit(relativePath + '.flashback');
    }

    // Reverse the last review of a document-linked card: undo it in the derived
    // layer, then mirror the restored SRS state back into the sidecar and seal the
    // change so the canonical layer stays authoritative. Returns the restored state.
    async undoReview(relativePath, flashcardHash, algorithm = 'leitner') {
        const { document_id, restored } = this.srs.undoReview(flashcardHash, algorithm);

        const metadata = this.files.getMetadata(relativePath);
        const card = metadata?.flashcards?.find(f => f.globalHash === flashcardHash);
        if (card) {
            if (algorithm === 'fsrs') {
                if (restored) {
                    card.fsrsStability = restored.stability;
                    card.fsrsDifficulty = restored.difficulty;
                    card.fsrsDue = restored.due;
                    card.fsrsState = restored.state;
                    card.fsrsReps = restored.reps;
                    card.fsrsLapses = restored.lapses;
                    card.level = restored.level ?? 0;
                    if (restored.lastRecall) card.lastRecall = restored.lastRecall;
                    else delete card.lastRecall;
                } else {
                    delete card.fsrsStability; delete card.fsrsDifficulty; delete card.fsrsDue;
                    delete card.fsrsState; delete card.fsrsReps; delete card.fsrsLapses;
                    card.level = 0;   // card reverts to never-reviewed strength
                    delete card.lastRecall;
                }
            } else {
                const value = restored ? restored.value : 0;
                if (algorithm === 'sm2') card.sm2Reps = value; else card.level = value;
                if (restored) {
                    card.easeFactor = restored.easeFactor;
                } else {
                    delete card.easeFactor;
                }
                if (restored?.lastRecall) card.lastRecall = restored.lastRecall;
                else delete card.lastRecall;
            }
            this.files.writeMetadata(relativePath, metadata);
            await sealEmitter.edit(relativePath + '.flashback');
        }

        if (document_id) this.propagatePresence(document_id);
        return restored;
    }

    // --- Private / Internal ---

    // Ensures every folder segment in relativePath is properly registered — DB row,
    // sidecar, and inheritance edge — auto-creating any that are missing. Used by
    // createFile/createFolder instead of _getParentFolderId, because Files.createFile's
    // recursive mkdirSync can create several levels of plain directories on disk for a
    // multi-level parentPath that doesn't exist yet, none of which _getParentFolderId's
    // single lookup would find — leaving the new document/folder's own parent (and any
    // folders above it) as untracked ghost directories: no sidecar, no Folders row, no
    // tag inheritance, invisible to folder-scoped search/due-card queries, and a 404
    // from any route that reads their metadata (e.g. update_tags). Returns the deepest
    // segment's folder id.
    _ensureFolderPath(relativePath) {
        let root = this.query.getFolderByPath("");
        let parentId;
        let parentAbs = this.files.workspaceRoot;
        if (root) {
            parentId = root.id;
        } else {
            const nodeId = this.query.createNode('Folder');
            const info = this.query.insertFolder({
                nodeId, globalHash: crypto.randomUUID(), parentId: null,
                relativePath: "", absolutePath: parentAbs, name: path.basename(parentAbs),
            });
            parentId = info.lastInsertRowid;
        }
        if (!relativePath) return parentId;

        const segments = relativePath.split(/[\\/]+/).filter(Boolean);
        let builtRel = "";
        for (const seg of segments) {
            const priorRel = builtRel;
            builtRel = builtRel ? path.join(builtRel, seg) : seg;
            let folder = this.query.getFolderByPath(builtRel);
            if (!folder) {
                const globalHash = this.files.ensureFolderMetadata(priorRel, seg);
                const absPath = this.files.safePath(builtRel);
                const nodeId = this.query.createNode('Folder');
                const info = this.query.insertFolder({
                    nodeId, globalHash, parentId, relativePath: builtRel, absolutePath: absPath, name: seg,
                });
                const parentNodeId = this.query.getNodeIdByFolderAbsPath(parentAbs);
                if (parentNodeId) this.query.insertInheritance(parentNodeId, nodeId);
                folder = { id: info.lastInsertRowid };
            }
            parentId = folder.id;
            parentAbs = this.files.safePath(builtRel);
        }
        return parentId;
    }

    _getParentFolderId(absolutePath) {
        const parentDir = path.dirname(absolutePath);
        if (parentDir === this.files.workspaceRoot) {
            const root = this.query.getFolderByPath("");
            if (root) return root.id;

            const nodeId = this.query.createNode('Folder');
            const info = this.query.insertFolder({
                nodeId, globalHash: crypto.randomUUID(), parentId: null,
                relativePath: "", absolutePath: parentDir, name: path.basename(parentDir)
            });
            return info.lastInsertRowid;
        }
        const folder = this.query.getFolderByAbsolutePath(parentDir);
        return folder ? folder.id : null;
    }

    _syncTags(nodeId, tagNames) {
        const tagNodeIds = [];
        for (const name of tagNames) {
            let tag = this.query.getTagByName(name);
            if (!tag) {
                const tNodeId = this.query.createNode('Tag');
                this.query.insertTag(name, tNodeId);
                tagNodeIds.push(tNodeId);
            } else {
                tagNodeIds.push(tag.node_id);
            }
        }
        this.query.syncNodeTags(nodeId, tagNodeIds);
    }

    _syncDocumentFlashcards(documentId, flashcardsData) {
        const existing = this.query.getFlashcardsByDocument(documentId);
        const existingMap = new Map(existing.map(f => [f.global_hash, f]));
        const incomingHashes = new Set();

        flashcardsData.forEach((fcData, index) => {
            incomingHashes.add(fcData.globalHash);
            const match = existingMap.get(fcData.globalHash);

            if (match) {
                const mergedLevel = Math.max(fcData.level ?? 0, match.level ?? 0);
                const mergedSm2Reps = Math.max(fcData.sm2Reps ?? 0, match.sm2_reps ?? 0);
                const mergedRecall = (mergedLevel === (fcData.level ?? 0) && fcData.lastRecall)
                    ? fcData.lastRecall
                    : (match.last_recall ?? fcData.lastRecall);

                // FSRS state isn't a monotonic scalar, so it can't be max-merged.
                // Take it from whichever side carries the more recent review; when
                // the sidecar is newer (or equal) fcData already holds it, otherwise
                // override with the DB row's snapshot.
                const sidecarNewer = fcData.lastRecall
                    && (!match.last_recall || fcData.lastRecall >= match.last_recall);
                const fsrsFromDb = sidecarNewer ? {} : {
                    fsrsStability: match.fsrs_stability,
                    fsrsDifficulty: match.fsrs_difficulty,
                    fsrsDue: match.fsrs_due,
                    fsrsState: match.fsrs_state,
                    fsrsReps: match.fsrs_reps,
                    fsrsLapses: match.fsrs_lapses,
                };

                this.query.updateFlashcard(match.id, {
                    ...fcData,
                    ...fsrsFromDb,
                    level: mergedLevel,
                    sm2Reps: mergedSm2Reps,
                    lastRecall: mergedRecall,
                    fileIndex: index,
                    contentId: match.content_id
                });
                if (Array.isArray(fcData.tags)) this._syncTags(match.node_id, fcData.tags);
            } else {
                const nodeId = this.query.createNode('Flashcard');
                this.query.insertFlashcard({
                    ...fcData, nodeId, documentId, fileIndex: index
                });
                if (Array.isArray(fcData.tags)) this._syncTags(nodeId, fcData.tags);
            }
        });

        for (const [hash, fc] of existingMap) {
            if (!incomingHashes.has(hash)) this.query.deleteFlashcard(fc.id);
        }
    }

    _propagateFolderTags(folderId, parentNodeId, metadata) {
        const childDocs = this.query.getChildDocuments(folderId);
        const childFolders = this.query.getChildFolders(folderId);

        const inheritedFromAbove = this.query.getInheritedTagNames(parentNodeId);
        const myDirectTags = new Set(metadata.tags || []);
        const myExclusions = new Set(metadata.excludedTags || []);
        const effectiveInherited = inheritedFromAbove.filter(t => !myExclusions.has(t));
        const effectiveToChildren = [...new Set([...effectiveInherited, ...myDirectTags])];

        const hierarchyType = this.query.getHierarchyTypeId();

        const syncInheritance = (targetNodeId) => {
            const conn = this.query.getOrCreateConnection(parentNodeId, targetNodeId, hierarchyType.id);
            this.query.clearInheritedTags(conn.id);
            for (const tagName of effectiveToChildren) {
                const tag = this.query.getTagByName(tagName);
                if (tag) this.query.insertInheritedTag(conn.id, tag.id);
            }
        };

        for (const doc of childDocs) {
            syncInheritance(doc.node_id);
            this._propagateTagsToFlashcards(doc.id, doc.node_id, effectiveToChildren);
        }

        for (const folder of childFolders) {
            syncInheritance(folder.node_id);
            const subMeta = this.files.getMetadata(folder.relative_path, true) || {};
            this._propagateFolderTags(folder.id, folder.node_id, subMeta);
        }
    }

    _propagateTagsToFlashcards(docId, docNodeId, tags) {
        const hierarchyType = this.query.getHierarchyTypeId();
        for (const fc of this.query.getFlashcardNodeIds(docId)) {
            const conn = this.query.getOrCreateConnection(docNodeId, fc.node_id, hierarchyType.id);
            this.query.clearInheritedTags(conn.id);
            for (const tagName of tags) {
                const tag = this.query.getTagByName(tagName);
                if (tag) this.query.insertInheritedTag(conn.id, tag.id);
            }
        }
    }

    // Returns { removed, added } path arrays for a folder rename/move.
    // Queries the DB after the rename so new paths are already stored; derives old paths by replacing the prefix.
    _buildMovePaths(oldRelPath, newRelPath, newAbsPath) {
        const prefix = newAbsPath + path.sep;
        const docs = this.query.getDocumentsByAbsPathPrefix(prefix);
        const folders = this.query.getFoldersByAbsPathPrefix(prefix, newAbsPath);

        const removed = [path.join(oldRelPath, '.flashback')];
        const added = [path.join(newRelPath, '.flashback')];

        for (const doc of docs) {
            const suffix = path.relative(newRelPath, doc.relative_path);
            const oldDocRel = path.join(oldRelPath, suffix);
            removed.push(oldDocRel, oldDocRel + '.flashback');
            added.push(doc.relative_path, doc.relative_path + '.flashback');
        }
        for (const folder of folders) {
            const suffix = path.relative(newRelPath, folder.relative_path);
            const oldFolderRel = path.join(oldRelPath, suffix);
            removed.push(path.join(oldFolderRel, '.flashback'));
            added.push(path.join(folder.relative_path, '.flashback'));
        }
        return { removed, added };
    }

    // Returns all file + sidecar paths inside a folder, queried before deletion.
    _gatherFolderContents(folderRelPath, folderAbsPath) {
        const prefix = folderAbsPath + path.sep;
        const docs = this.query.getDocumentsByAbsPathPrefix(prefix);
        const folders = this.query.getFoldersByAbsPathPrefix(prefix, folderAbsPath);

        const paths = [];
        for (const doc of docs) {
            paths.push(doc.relative_path, doc.relative_path + '.flashback');
        }
        for (const folder of folders) {
            paths.push(path.join(folder.relative_path, '.flashback'));
        }
        return paths;
    }

    propagatePresence(documentId) {
        db.transaction(() => {
            const stats = this.query.getFlashcardAvgLevel(documentId);
            this.query.updateDocumentPresence(documentId, stats.score || 0);

            let currentFolderId = this.query.getDocumentFolderIdById(documentId)?.folder_id;
            while (currentFolderId) {
                const docStats = this.query.getDocumentPresenceStats(currentFolderId);
                const childFolders = this.query.getChildFolderPresences(currentFolderId);

                const totalCount = (docStats.cnt || 0) + childFolders.length;
                const totalPresence = (docStats.total || 0) + childFolders.reduce((acc, f) => acc + (f.presence || 0), 0);
                const avg = totalCount > 0 ? (totalPresence / totalCount) : 0;

                this.query.updateFolderPresence(currentFolderId, avg);

                currentFolderId = this.query.getFolderParentId(currentFolderId)?.parent_id ?? null;
            }
        })();
    }

    search(q) { return this.query.search(q); }

    // Case-insensitive substring search across text document BODIES. Name/card
    // matching lives in query.search / superSearch — bodies exist only on disk,
    // so this reads each text document (same whitelist as _extractLinks) and
    // returns per-document match counts with context snippets.
    searchContent(q, limit = 20) {
        const needle = String(q ?? '').toLowerCase();
        if (!needle) return [];
        const results = [];
        for (const doc of this.query.getAllDocuments()) {
            if (results.length >= limit) break;
            const ext = path.extname(doc.relative_path).toLowerCase();
            if (!['.md', '.txt', '.markdown'].includes(ext)) continue;
            let content;
            try { ({ content } = this.files.readFile(doc.relative_path)); } catch { continue; }
            if (!content) continue;
            const hay = content.toLowerCase();
            let idx = hay.indexOf(needle);
            if (idx === -1) continue;
            const snippets = [];
            let matches = 0;
            while (idx !== -1) {
                matches++;
                if (snippets.length < 3) {
                    const from = Math.max(0, idx - 80);
                    const to = Math.min(content.length, idx + needle.length + 80);
                    snippets.push(`${from > 0 ? '…' : ''}${content.slice(from, to)}${to < content.length ? '…' : ''}`);
                }
                idx = hay.indexOf(needle, idx + needle.length);
            }
            results.push({ path: doc.relative_path, name: doc.name, matches, snippets });
        }
        return results;
    }

    // Outgoing flashback:// links and backlinks for one document. Resolved edges
    // come from the graph Connections; unresolved outgoing targets (a linked
    // hash whose document doesn't exist yet) come from the DocumentLinks queue.
    getLinks(relPath) {
        const doc = this.query.getDocumentByPath(relPath);
        if (!doc) throw new Error(`Document ${relPath} not found`);
        const { outgoing, backlinks } = this.query.getDocumentLinkEdges(doc.node_id);
        const pending = this.query.getPendingLinksFromSource(doc.global_hash)
            .map((l) => ({ targetHash: l.target_hash, anchorText: l.anchor_text }));
        return { outgoing, backlinks, pending };
    }

    getGraphData() { return this.query.getGraphData(); }
    exists(rel, derived, isFolder) {
        if (derived) return isFolder ? this.query.getFolderByPath(rel) : this.query.getDocumentByPath(rel);
        return this.files.exists(rel);
    }
}
