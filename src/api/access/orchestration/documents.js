/**
 * Documents.js
 * The Orchestrator. Coordinates File System, Database, and specialized services.
 */

import path from 'path';
import fs from 'fs';
import Files from '../resources/files.js';
import { withDocument, withStructure } from '../resources/pathLock.js';
import { safeFetch } from '../resources/safeFetch.js';
import { getAllowPrivateNetworkFetch, getCardRemovalLimits } from '../primitives/config.js';
import cardRemovalBudget from '../resources/cardRemovalBudget.js';
import query from '../resources/query.js';
import srsService from './srs.js';
import db from '../primitives/database.js';
import crypto from 'crypto';
import os from 'os';
import AdmZip from 'adm-zip';
import { sealEmitter } from '../../seal/seal.js';
import highlightsService from './highlights.js';
import newFileMetadata from '../../config/defaults/FlashbackFile.js';
import { OWNER_SCOPE, currentScope, isOwnerScope, currentAccount } from '../../requestContext.js';
import { ROLES, atLeast } from '../../../shared/roles.js';

/** Extracts the 11-char video id from any common YouTube URL shape (watch?v=, youtu.be/, /embed/, /shorts/, /live/). */
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

/** Chooses one caption track from a playerResponse's `captionTracks[]`, preferring a manually-authored track in the requested language. */
export function pickCaptionTrack(playerResponse, lang) {
    const tracks =
        playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!Array.isArray(tracks) || tracks.length === 0) return null;
    const want = String(lang || "en").toLowerCase();
    const inLang = tracks.filter((t) => (t.languageCode || "").toLowerCase().startsWith(want));
    const manual = (arr) => arr.find((t) => t.kind !== "asr");
    return manual(inLang) || inLang[0] || manual(tracks) || tracks[0];
}

/** Turns a YouTube timedtext json3 payload (object or raw string) into transcript cues `{ start, dur, text }` in seconds. */
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

/** Turns an arbitrary title into a filesystem-safe base name (no extension). */
export function slugifyName(title) {
    const cleaned = String(title || "")
        .replace(/[\\/:*?"<>|]/g, " ")
        .replace(/[\r\n\t]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120)
        .trim();
    return cleaned || "clip";
}

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

function extFromAudioContentType(ct) {
    if (!ct) return null;
    const type = ct.split(';')[0].trim().toLowerCase();
    const map = {
        'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
        'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac',
        'audio/ogg': 'ogg', 'audio/vorbis': 'ogg',
        'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav',
        'audio/webm': 'weba', 'audio/flac': 'flac', 'audio/x-flac': 'flac',
    };
    return map[type] || null;
}

function extFromUrl(u) {
    try {
        const m = new URL(u).pathname.match(/\.([a-z0-9]{1,5})$/i);
        return m ? m[1].toLowerCase() : null;
    } catch { return null; }
}

const CLIP_SANITIZE_OPTS = {
    allowedTags: [
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'a', 'ul', 'ol', 'li',
        'blockquote', 'pre', 'code', 'em', 'strong', 'b', 'i', 'u', 's',
        'sub', 'sup', 'br', 'hr', 'img', 'figure', 'figcaption', 'table',
        'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'span',
        'div', 'mark', 'small', 'abbr', 'cite', 'time', 'audio', 'source',
    ],
    allowedAttributes: {
        a: ['href', 'title'],
        img: ['src', 'alt', 'title', 'width', 'height'],
        audio: ['src', 'controls', 'preload', 'title'],
        source: ['src', 'type'],
        '*': ['id'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: {
        img: ['http', 'https', 'data'],
        audio: ['http', 'https'],
        source: ['http', 'https'],
    },
    allowProtocolRelative: false,
};

const CLIP_USER_AGENT = 'Mozilla/5.0 (Flashback webclipper)';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** The file name an asset's src is known by — the last path segment, no query or fragment. */
function assetName(src) {
    const bare = src.split('?')[0].split('#')[0].split('/').pop() || src;
    try { return decodeURIComponent(bare); } catch { return bare; }
}

const PLAYABLE_SOUND_EXT = /\.(mp3|ogg|oga|wav|m4a|aac|flac|opus|weba)(\?|#|$)/i;
function isSoundLink(href) {
    if (!href) return false;
    const segment = href.split('?')[0].split('#')[0].split('/').pop() || '';
    if (segment.includes(':')) return false;
    return PLAYABLE_SOUND_EXT.test(segment);
}

/** Where an element loads from: an anchor's href, anything else's src. */
function assetAddress(el) {
    return (el.tagName.toUpperCase() === 'A' ? el.getAttribute('href') : el.getAttribute('src')) || '';
}

/** Every element in a clip body that carries an asset: pictures and players by `src`, plus links pointing at a playable sound. */
function clipAssetNodes(cdoc) {
    return Array.from(cdoc.querySelectorAll('img[src], audio[src], source[src], a[href]'))
        .filter((n) => n.tagName.toUpperCase() !== 'A'
            || isSoundLink(n.getAttribute('href'))
            || isSoundLink(n.getAttribute('data-src')));
}

/** The element in a clip body that `wanted` names, by the same addressing rules `/api/reader/media-file` uses. */
function resolveClipAsset(cdoc, wanted) {
    const nodes = clipAssetNodes(cdoc);
    const bare = wanted.replace(/^\.?\//, '');
    const matches = (value) => value && (value === wanted || value.replace(/^\.?\//, '') === bare);
    const exact = nodes.find((n) => matches(assetAddress(n)) || matches(n.getAttribute('data-src')));
    if (exact) return exact;

    const byName = nodes.filter((n) => assetName(assetAddress(n)) === bare);
    if (byName.length === 0) throw new Error("That asset is not part of this clip");
    if (byName.length > 1) {
        throw new Error(
            `"${wanted}" matches ${byName.length} assets in this clip `
            + `(${byName.map((n) => assetAddress(n)).join(', ')}). Use the full href.`,
        );
    }
    return byName[0];
}
const MAX_AUDIO_BYTES = 15 * 1024 * 1024;

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

/** Rolls each graph node's raw learning columns up into the two scalars the graph draws with, and drops the intermediate sums from the payload. */
function graphNodeLearning(node) {
    const {
        learnedSum, flashcardLearned, cardCount,
        folderLearnedSum, folderCardCount,
        ...rest
    } = node;
    let learned = 0;
    let cards = 0;
    let mass = 0;

    if (node.type === 'Document') {
        cards = cardCount ?? 0;
        mass = Math.max(0, learnedSum ?? 0);
        learned = cards > 0 ? clamp01(mass / cards) : 0;
    } else if (node.type === 'Flashcard') {
        cards = 1;
        mass = clamp01(flashcardLearned);
        learned = mass;
    } else if (node.type === 'Folder') {
        cards = folderCardCount ?? 0;
        mass = Math.max(0, folderLearnedSum ?? 0);
        learned = cards > 0 ? clamp01(mass / cards) : 0;
    }

    return { ...rest, learned, mass, cardCount: cards };
}

export default class Documents {
    constructor() {
        this.files = new Files();
        this.query = query;
        this.srs = srsService;
    }

    /**
     * Refuses a write whose caller was working from a version of the document that is no longer the one on disk.
     *
     * @param {string} relativePath
     * @param {string} [ifMatch] - the etag the caller last read.
     * @param {object} [opts]
     * @param {boolean} [opts.isFolder=false]
     * @param {'body'|'sidecar'} [opts.part='sidecar'] - which half this write replaces.
     * @throws {Error & {status:409, code:'stale', etag:string|null}}
     */
    _assertFresh(relativePath, ifMatch, { isFolder = false, part = 'sidecar' } = {}) {
        if (!ifMatch) return;
        const current = this.files.etag(relativePath, isFolder);
        const half = (etag) => (typeof etag === 'string' ? etag.split('.')[part === 'body' ? 0 : 1] : etag);
        if (half(current) === half(ifMatch)) return;
        throw Object.assign(
            new Error('This document changed since you last read it.'),
            { status: 409, code: 'stale', etag: current },
        );
    }

    /**
     * The etag of one card as it stands in its document's sidecar — what a client sends back as `ifMatch` when it patches that card.
     *
     * @param {string|null} relativePath - null for a standalone card (it lives in a deck file).
     * @param {string} flashcardHash
     * @returns {string|null}
     */
    cardEtag(relativePath, flashcardHash) {
        if (!relativePath) return null;
        const meta = this.files.getMetadata(relativePath) || {};
        const cards = Array.isArray(meta.flashcards) ? meta.flashcards : [];
        return this.files.entityEtag(cards.find(f => f.globalHash === flashcardHash));
    }

    /**
     * The patch counterpart of `_assertFresh`: refuses a patch to an entity somebody else has changed since the caller read it.
     *
     * @param {object} entity - the card/highlight as it currently stands in the sidecar.
     * @param {string} [ifMatch] - entity etag the caller read.
     * @throws {Error & {status:409, code:'stale', etag:string|null}}
     */
    _assertEntityFresh(entity, ifMatch) {
        if (!ifMatch) return;
        const current = this.files.entityEtag(entity);
        if (current === ifMatch) return;
        throw Object.assign(
            new Error('This card changed since you last read it.'),
            { status: 409, code: 'stale', etag: current },
        );
    }

    /** One folder's documents and subfolders, with their metadata. */
    async listFolder(relPath) {
        const items = await this.files.listFolder(relPath);
        const folder = await this.query.getFolderByPath(relPath);

        let fileCountMap = new Map();
        let folderCountMap = new Map();

        if (folder) {
            const counts = await this.query.getFlashcardCountsByFolder(folder.id);
            fileCountMap = new Map(counts.map(r => [r.name, r.count]));

            const subfolderNames = [];
            for (const i of items) { if (i.type === 'folder') subfolderNames.push(i.name); }
            if (subfolderNames.length > 0) {
                const childRelPaths = subfolderNames.map(n => path.join(relPath, n));
                const childFolders = await this.query.getFoldersByPaths(childRelPaths);
                if (childFolders.length > 0) {
                    const countsByRootId = await this.query.getFlashcardCountsInFolderTrees(childFolders.map(f => f.id));
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

    /** Creates a document, its sidecar and its index rows. */
    async createFile(name, relativePath = "") {
        const { globalHash, name: resolvedName } = await this.files.createFile(relativePath, name);
        const fileRelPath = path.join(relativePath, resolvedName);

        try {
            const absPath = this.files.safePath(fileRelPath);
            await db.transaction(async () => {
                const nodeId = await this.query.createNode('Document');
                const folderId = await this._ensureFolderPath(relativePath);
                await this.query.insertDocument({
                    folderId, nodeId, globalHash,
                    relativePath: fileRelPath, absolutePath: absPath, name: resolvedName,
                    encoding: 'UTF-8'
                });
                const parentFolder = await this.query.getFolderById(folderId);
                if (parentFolder?.node_id) {
                    await this.query.insertInheritance(parentFolder.node_id, nodeId);
                    await this._seedFromParentFolder(parentFolder, nodeId);
                }
            })();
        } catch (err) {
            await this.files.delete(fileRelPath, false);
            throw err;
        }
        await sealEmitter.create(fileRelPath + '.flashback', [fileRelPath]);
    }

    /** Creates a folder, its sidecar and its index rows. */
    async createFolder(name, relativePath = "") {
        const folderRelPath = path.join(relativePath, name);
        const globalHash = await this.files.createFolder(relativePath, name);

        try {
            const absPath = this.files.safePath(folderRelPath);
            await db.transaction(async () => {
                const nodeId = await this.query.createNode('Folder');
                const parentId = await this._ensureFolderPath(relativePath);
                await this.query.insertFolder({
                    nodeId, globalHash, parentId, relativePath: folderRelPath, absolutePath: absPath, name
                });
                const parentFolder = await this.query.getFolderById(parentId);
                if (parentFolder?.node_id) {
                    await this.query.insertInheritance(parentFolder.node_id, nodeId);
                    await this._seedFromParentFolder(parentFolder, nodeId);
                }
            })();
        } catch (err) {
            await this.files.delete(folderRelPath, true);
            throw err;
        }
        await sealEmitter.create(path.join(folderRelPath, '.flashback'));
    }

    /** Renames a document or folder, cascading paths in the index. */
    async rename(relativePath, newName, isFolder = false) {
        return await withStructure(() => this._renameLocked(relativePath, newName, isFolder));
    }

    async _renameLocked(relativePath, newName, isFolder = false) {
        const oldAbsPath = this.files.safePath(relativePath);
        const parentDir = path.dirname(relativePath);
        const newRelPath = path.join(parentDir, newName);
        const newAbsPath = this.files.safePath(newRelPath);

        await this.files.rename(relativePath, newName, isFolder);

        try {
            await db.transaction(async () => {
                if (isFolder) {
                    await this.query.renameFolderRecord(newName, newRelPath, newAbsPath, oldAbsPath);
                    await this.query.cascadeRenameDocumentPaths(relativePath, newRelPath, oldAbsPath, newAbsPath);
                    await this.query.cascadeRenameFolderPaths(relativePath, newRelPath, oldAbsPath, newAbsPath);
                } else {
                    await this.query.renameDocumentRecord(newName, newRelPath, newAbsPath, oldAbsPath);
                }
            })();
        } catch (err) {
            await this.files.rename(newRelPath, path.basename(relativePath), isFolder);
            throw err;
        }
        if (isFolder) {
            const { removed, added } = await this._buildMovePaths(relativePath, newRelPath, newAbsPath);
            await sealEmitter.move(relativePath, newRelPath, removed, added);
        } else {
            await sealEmitter.move(relativePath, newRelPath,
                [relativePath, relativePath + '.flashback'],
                [newRelPath, newRelPath + '.flashback']
            );
        }
    }

    /** Moves a document or folder, carrying its media and re-deriving inherited tags. */
    async move(relativePath, newRelativePath, isFolder = false) {
        return await withStructure(() => this._moveLocked(relativePath, newRelativePath, isFolder));
    }

    async _moveLocked(relativePath, newRelativePath, isFolder = false) {
        const oldAbsPath = this.files.safePath(relativePath);
        const newAbsPath = this.files.safePath(newRelativePath);
        const oldParentAbsPath = path.dirname(oldAbsPath);
        const newParentAbsPath = path.dirname(newAbsPath);

        await this.files.move(relativePath, newRelativePath, isFolder);

        try {
            await db.transaction(async () => {
                if (!isFolder) {
                    const newFolderId = await this._getParentFolderId(newAbsPath);
                    await this.query.moveDocumentRecord(newFolderId, newRelativePath, newAbsPath, oldAbsPath);
                    const moved = await this.query.getDocumentByAbsolutePath(newAbsPath);
                    if (moved?.node_id) {
                        const oldParentNodeId = await this.query.getNodeIdByFolderAbsPath(oldParentAbsPath);
                        const newParentFolder = await this.query.getFolderByAbsolutePath(newParentAbsPath);
                        if (oldParentNodeId) await this.query.deleteInheritance(oldParentNodeId, moved.node_id);
                        if (newParentFolder?.node_id) {
                            await this.query.insertInheritance(newParentFolder.node_id, moved.node_id);
                            await this._seedFromParentFolder(newParentFolder, moved.node_id);
                        }
                        await this._propagateTagsToFlashcards(
                            moved.id, moved.node_id, await this._tagsPassedDownByDocument(moved.node_id));
                    }
                } else {
                    const newParentId = await this._getParentFolderId(newAbsPath);
                    await this.query.moveFolderRecord(newRelativePath, newAbsPath, oldAbsPath, newParentId);
                    await this.query.cascadeRenameDocumentPaths(relativePath, newRelativePath, oldAbsPath, newAbsPath);
                    await this.query.cascadeRenameFolderPaths(relativePath, newRelativePath, oldAbsPath, newAbsPath);
                    await this.query.cascadeMediaPaths(relativePath, newRelativePath, oldAbsPath, newAbsPath);
                    const movedFolder = await this.query.getFolderByAbsolutePath(newAbsPath);
                    if (movedFolder?.node_id) {
                        const oldParentNodeId = await this.query.getNodeIdByFolderAbsPath(oldParentAbsPath);
                        const newParentFolder = await this.query.getFolderByAbsolutePath(newParentAbsPath);
                        if (oldParentNodeId) await this.query.deleteInheritance(oldParentNodeId, movedFolder.node_id);
                        if (newParentFolder?.node_id) {
                            await this.query.insertInheritance(newParentFolder.node_id, movedFolder.node_id);
                            await this._seedFromParentFolder(newParentFolder, movedFolder.node_id);
                        }
                        const movedMeta = this.files.getMetadata(newRelativePath, true) || {};
                        await this._propagateFolderTags(movedFolder.id, movedFolder.node_id, movedMeta);
                    }
                }
            })();
        } catch (err) {
            await this.files.move(newRelativePath, relativePath, isFolder);
            throw err;
        }
        if (isFolder) {
            const { removed, added } = await this._buildMovePaths(relativePath, newRelativePath, newAbsPath);
            await sealEmitter.move(relativePath, newRelativePath, removed, added);
        } else {
            const media = await this._carryMediaAfterMove(relativePath, newRelativePath);
            await sealEmitter.move(relativePath, newRelativePath,
                [relativePath, relativePath + '.flashback', ...media.removed],
                [newRelativePath, newRelativePath + '.flashback', ...media.added]
            );
        }
    }

    /**
     * Writes a document's body and/or its sidecar.
     *
     * @param {string} relativePath
     * @param {string|null} [content] - body; undefined/null leaves the body alone.
     * @param {object} [metadata] - the whole sidecar.
     * @param {object} [opts]
     * @param {string} [opts.ifMatch] - etag the caller read. Omitted means no check; see `routes/documents.js` for why that stays permitted.
     * @returns {Promise<{etag: string|null}>} the document's etag after the write.
     */
    async updateFile(relativePath, content, metadata, { ifMatch } = {}) {
        return await withDocument(relativePath, async () => {
            const part = (content !== undefined && content !== null) ? 'body' : 'sidecar';
            this._assertFresh(relativePath, ifMatch, { part });
            await this._updateFileLocked(relativePath, content, metadata);
            return { etag: this.files.etag(relativePath) };
        });
    }

    /** The body of updateFile, with the lock and the freshness check already applied. */
    async _updateFileLocked(relativePath, content, metadata) {
        await this.files.updateFile(relativePath, content, metadata);

        if (metadata) {
            const doc = await this.query.getDocumentByPath(relativePath);
            if (!doc) throw new Error(`Document ${relativePath} not found in DB`);

            await db.transaction(async () => {
                if (metadata.tags) await this._syncTags(doc.node_id, metadata.tags);
                if (metadata.flashcards) await this._syncDocumentFlashcards(doc.id, metadata.flashcards, doc.node_id);
                if (metadata.highlights) await highlightsService.syncFromSidecar(doc.id, metadata.highlights);

                const folderId = doc.folder_id;
                if (folderId) {
                    const folder = await this.query.getFolderById(folderId);
                    if (folder) {
                        const folderRelPath = path.relative(this.files.workspaceRoot, folder.absolute_path);
                        const folderMeta = this.files.getMetadata(folderRelPath, true) || {};
                        await this._propagateFolderTags(folder.id, folder.node_id, folderMeta);
                    }
                }
            })();
        }
        await sealEmitter.edit(relativePath + '.flashback', [relativePath]);
        if (content !== undefined && content !== null) {
            await this.syncDocumentLinks(relativePath);
        }
    }

    static _LINK_RE = /\[([^\]]*)\]\(flashback:\/\/([a-f0-9-]+)\)/g;

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

    _writeSidecarLinks(relPath, links) {
        if (links === null) return false;
        const sidecar = this.files.getMetadata(relPath, false) ?? {};
        if (JSON.stringify(sidecar.links ?? []) === JSON.stringify(links)) return false;
        sidecar.links = links;
        this.files.writeMetadata(relPath, sidecar, false);
        return true;
    }

    async _writeLinkConnections(doc, links) {
        await db.transaction(async () => {
            await this.query.deleteDocumentLinkConnections(doc.node_id);
            await this.query.deleteDocumentLinkQueueBySource(doc.global_hash);
            for (const { anchorText, targetHash } of (links ?? [])) {
                const target = await this.query.getDocumentByHash(targetHash);
                if (target) {
                    await this.query.insertDocumentLinkConnection(doc.node_id, target.node_id);
                } else {
                    await this.query.upsertDocumentLinkQueue(doc.global_hash, targetHash, anchorText);
                }
            }
        })();
    }

    /** Re-derives a saved document's `flashback://` links, rewriting the sidecar only when they changed. */
    async syncDocumentLinks(relPath) {
        const links = this._extractLinks(relPath);
        if (links === null) return;
        if (this._writeSidecarLinks(relPath, links)) {
            await sealEmitter.edit(relPath + '.flashback');
        }
        const doc = await this.query.getDocumentByPath(relPath);
        if (doc) await this._writeLinkConnections(doc, links);
    }

    /** Re-derives link edges in the index only; writes no file and emits no Seal commit. */
    async indexDocumentLinks(relPath) {
        const links = this._extractLinks(relPath);
        if (links === null) return;
        const doc = await this.query.getDocumentByPath(relPath);
        if (doc) await this._writeLinkConnections(doc, links);
    }

    async _resolvePendingLinks(globalHash, nodeId, relPath) {
        const pending = await this.query.getPendingLinksForTarget(globalHash);
        if (pending.length > 0) {
            await db.transaction(async () => {
                for (const row of pending) {
                    const sourceDoc = await this.query.getDocumentByHash(row.source_hash);
                    if (sourceDoc) {
                        await this.query.insertDocumentLinkConnection(sourceDoc.node_id, nodeId);
                        await this.query.deleteDocumentLinkQueueBySource(row.source_hash);
                        const remaining = await this.query.getPendingLinksFromSource(row.source_hash);
                        for (const r of remaining) {
                            await this.query.upsertDocumentLinkQueue(r.source_hash, r.target_hash, r.anchor_text);
                        }
                    }
                }
            })();
        }
        await this.indexDocumentLinks(relPath);
    }

    /** Deletes a document or folder from disk and from the index. */
    async delete(relativePath, isFolder = false) {
        return await withStructure(() => this._deleteLocked(relativePath, isFolder));
    }

    async _deleteLocked(relativePath, isFolder = false) {
        const absPath = this.files.safePath(relativePath);

        const sealExtra = isFolder
            ? await this._gatherFolderContents(relativePath, absPath)
            : [relativePath];

        await db.transaction(async () => {
            if (isFolder) {
                await this.query.deleteFolderTree(absPath, path.sep);
            } else {
                await this.query.deleteDocumentByAbsPath(absPath);
            }
        })();

        await this.files.delete(relativePath, isFolder);

        const sealSidecar = isFolder ? path.join(relativePath, '.flashback') : relativePath + '.flashback';
        await sealEmitter.delete(sealSidecar, sealExtra);
    }

    /** Copies a document or folder, assigning fresh identities to the copy. */
    async copy(relPath, newRelPath, isFolder = false) {
        return await withStructure(() => this._copyLocked(relPath, newRelPath, isFolder));
    }

    async _copyLocked(relPath, newRelPath, isFolder = false) {
        const items = await this.files.copy(relPath, newRelPath, isFolder);

        await db.transaction(async () => {
            for (const item of items) {
                const sidecar = this.files.getMetadata(item.relativePath, item.type === 'folder');

                if (item.type === 'folder') {
                    const nodeId = await this.query.createNode('Folder');
                    const parentId = await this._getParentFolderId(item.absolutePath);
                    await this.query.insertFolder({
                        nodeId,
                        globalHash: item.globalHash,
                        parentId,
                        relativePath: item.relativePath,
                        absolutePath: item.absolutePath,
                        name: item.name,
                    });
                    if (sidecar?.tags) await this._syncTags(nodeId, sidecar.tags);
                } else {
                    const nodeId = await this.query.createNode('Document');
                    const folderId = await this._getParentFolderId(item.absolutePath);
                    const info = await this.query.insertDocument({
                        folderId,
                        nodeId,
                        globalHash: item.globalHash,
                        relativePath: item.relativePath,
                        absolutePath: item.absolutePath,
                        name: item.name,
                    });
                    if (sidecar?.tags) await this._syncTags(nodeId, sidecar.tags);
                    if (sidecar?.flashcards) await this._syncDocumentFlashcards(info.lastInsertRowid, sidecar.flashcards, nodeId);
                    if (sidecar?.highlights) await highlightsService.syncFromSidecar(info.lastInsertRowid, sidecar.highlights);
                }
            }
        })();

        const mediaPaths = [];
        if (!isFolder) {
            const copied = items.find(i => i.type === 'file');
            if (copied) {
                mediaPaths.push(...this._replicateMedia(
                    copied.relativePath,
                    path.dirname(relPath),
                    path.dirname(copied.relativePath),
                ).added);
            }
        }

        const sidecarPaths = items.map(i =>
            i.type === 'folder'
                ? path.join(i.relativePath, '.flashback')
                : i.relativePath + '.flashback'
        );
        const docPaths = [];
        for (const i of items) { if (i.type === 'file') docPaths.push(i.relativePath); }
        const rootSidecar = sidecarPaths[0];
        await sealEmitter.create(rootSidecar, [...sidecarPaths.slice(1), ...docPaths, ...mediaPaths]);
    }

    /**
     * Replaces a document's or folder's whole sidecar.
     *
     * @param {string} relativePath
     * @param {object} metadata
     * @param {boolean} [isFolder=false]
     * @param {object} [opts]
     * @param {string} [opts.ifMatch]
     * @returns {Promise<{etag: string|null}>}
     */
    async updateMetadata(relativePath, metadata, isFolder = false, { ifMatch } = {}) {
        return await withDocument(relativePath, async () => {
            this._assertFresh(relativePath, ifMatch, { isFolder, part: 'sidecar' });
            await this._updateMetadataLocked(relativePath, metadata, isFolder);
            return { etag: this.files.etag(relativePath, isFolder) };
        });
    }

    /**
     * How many of this document's cards a metadata write would delete.
     *
     * @param {object|null} onDisk the sidecar as it stands, read once by the caller.
     * @returns {number} 0 for a folder, a card-less write, or a write that removes nothing.
     */
    _countCardRemovals(metadata, isFolder, onDisk) {
        if (isFolder || !Array.isArray(metadata?.flashcards)) return 0;

        const before = onDisk?.flashcards;
        if (!Array.isArray(before) || before.length === 0) return 0;

        const incoming = new Set(
            metadata.flashcards.map((fc) => fc?.globalHash).filter(Boolean),
        );
        return before.filter((fc) => fc?.globalHash && !incoming.has(fc.globalHash)).length;
    }

    /** Refuses a metadata write that would delete more cards than this caller may. */
    _assertRemovalAllowed(relativePath, removals) {
        if (removals <= 0) return null;

        const account = currentAccount();
        if (!account) return null;
        if (atLeast(account.role, ROLES.ADMIN)) return null;

        const limits = getCardRemovalLimits();
        const verdict = cardRemovalBudget.check(account.id, removals, limits);
        if (verdict.allowed) return account;

        const message = verdict.reason === 'per_request'
            ? `This would remove ${removals} flashcards from ${relativePath}, and a single `
              + `edit may remove at most ${limits.perRequest}. Remove them in smaller batches, `
              + `or ask an admin.`
            : `This would remove ${removals} flashcards, and you have ${verdict.remaining} `
              + `of your hourly allowance of ${limits.perHour} left. It refills in `
              + `${verdict.retryAfter} seconds.`;

        throw Object.assign(new Error(message), {
            status: 429,
            code: 'removal_budget',
            retryAfter: verdict.retryAfter || 60,
        });
    }

    /** Keeps a sidecar's identity fields as the server assigned them. */
    _preserveIdentity(metadata, onDisk) {
        if (!metadata || typeof metadata !== 'object') return;
        if (!currentAccount()) return;
        if (!onDisk) return;

        if (onDisk.globalHash) metadata.globalHash = onDisk.globalHash;

        if ('createdBy' in onDisk) metadata.createdBy = onDisk.createdBy;
        else delete metadata.createdBy;
    }

    /** The body of updateMetadata, with the lock and the freshness check already applied. */
    async _updateMetadataLocked(relativePath, metadata, isFolder = false) {
        const onDisk = this.files.getMetadata(relativePath, isFolder);

        const removals = this._countCardRemovals(metadata, isFolder, onDisk);
        const charged = this._assertRemovalAllowed(relativePath, removals);

        this._preserveIdentity(metadata, onDisk);
        this.files.writeMetadata(relativePath, metadata, isFolder);
        if (charged) cardRemovalBudget.consume(charged.id, removals);

        await db.transaction(async () => {
            const entity = isFolder ? await this.query.getFolderByPath(relativePath) : await this.query.getDocumentByPath(relativePath);
            if (!entity) throw new Error(`Entity ${relativePath} not found`);

            if (isFolder) await this.query.updateFolderMetadata(entity.id, metadata);
            else await this.query.updateDocumentMetadata(entity.id, metadata);

            if (metadata.tags) await this._syncTags(entity.node_id, metadata.tags);
            if (!isFolder && metadata.flashcards) await this._syncDocumentFlashcards(entity.id, metadata.flashcards, entity.node_id);
            if (!isFolder && metadata.highlights) await highlightsService.syncFromSidecar(entity.id, metadata.highlights);

            if (!isFolder && metadata.tags !== undefined) {
                const inherited = await this.query.getInheritedTagNames(entity.node_id);
                const effective = [...new Set([...inherited, ...(metadata.tags || [])])];
                await this._propagateTagsToFlashcards(entity.id, entity.node_id, effective);
            }

            if (isFolder) await this._propagateFolderTags(entity.id, entity.node_id, metadata);
        })();

        const sidecar = isFolder ? path.join(relativePath, '.flashback') : relativePath + '.flashback';
        await sealEmitter.edit(sidecar);
    }

    /** Imports a file from disk into the workspace, folding its links into the sidecar before sealing. */
    async importFile(name, relativePath, content, metadata) {
        const { name: resolvedName } = await this.files.createFile(relativePath, name);
        const fileRelPath = path.join(relativePath, resolvedName);
        const encoding = await this.files.updateFile(fileRelPath, content, metadata);

        try {
            const absPath = this.files.safePath(fileRelPath);
            const registerMeta = metadata?.globalHash
                ? metadata
                : { ...metadata, globalHash: this.files.getMetadata(fileRelPath)?.globalHash };
            await this._registerDocumentDerived({ name, fileRelPath, absPath, encoding, metadata: registerMeta });
        } catch (err) {
            await this.files.delete(fileRelPath, false);
            throw err;
        }

        this._writeSidecarLinks(fileRelPath, this._extractLinks(fileRelPath));
        await sealEmitter.create(fileRelPath + '.flashback', [fileRelPath]);

        const imported = await this.query.getDocumentByPath(fileRelPath);
        if (imported) {
            await this._resolvePendingLinks(imported.global_hash, imported.node_id, fileRelPath);
        }

        return { path: fileRelPath, globalHash: this.files.getMetadata(fileRelPath)?.globalHash };
    }

    async _registerDocumentDerived({ name, fileRelPath, absPath, encoding, metadata }) {
        const parentAbsPath = path.dirname(absPath);
        return await db.transaction(async () => {
            const nodeId = await this.query.createNode('Document');
            const folderId = await this._getParentFolderId(absPath);
            const info = await this.query.insertDocument({
                folderId, nodeId, globalHash: metadata.globalHash,
                relativePath: fileRelPath, absolutePath: absPath, name,
                encoding
            });
            const docId = info.lastInsertRowid;

            const parentFolder = await this.query.getFolderByAbsolutePath(parentAbsPath);
            if (parentFolder?.node_id) {
                await this.query.insertInheritance(parentFolder.node_id, nodeId);
                await this._seedFromParentFolder(parentFolder, nodeId);
            }

            if (metadata.tags) await this._syncTags(nodeId, metadata.tags);
            if (metadata.flashcards) await this._syncDocumentFlashcards(docId, metadata.flashcards, nodeId);
            if (metadata.highlights) await highlightsService.syncFromSidecar(docId, metadata.highlights);
            return docId;
        })();
    }

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
        } catch { }

        const body = JSON.stringify({ url, videoId, title, author, thumbnailUrl }, null, 2);
        const source = { url, videoId, title, author, clippedAt: new Date().toISOString() };
        return { videoId, title, body, source };
    }

    /**
     * Captures a YouTube URL as a new `.youtube` reference document.
     *
     * @param {string} url
     * @param {string} [relativePath=""] destination folder
     * @returns {Promise<{path: string, globalHash: string}>}
     */
    async createYoutube(url, relativePath = "") {
        const { videoId, title, body, source } = await this._buildYoutubeDoc(url);
        const metadata = { ...newFileMetadata(), source };
        const name = slugifyName(title || videoId) + ".youtube";
        return await this.importFile(name, relativePath, body, metadata);
    }

    /**
     * Populates an existing (e.g.
     *
     * @param {string} relPath existing `.youtube` file
     * @param {string} url
     */
    async setYoutubeSource(relPath, url) {
        if (!await this.files.exists(relPath)) throw new Error("File not found");
        const { body, source } = await this._buildYoutubeDoc(url);
        const existing = this.files.getMetadata(relPath) || newFileMetadata();
        await this.files.updateFile(relPath, body, { ...existing, source });
        await sealEmitter.edit(relPath + '.flashback', [relPath]);
        return { path: relPath, globalHash: this.files.getMetadata(relPath)?.globalHash };
    }

    async _fetchYoutubeTranscript(videoId, lang) {
        const noCaptions = (msg) => Object.assign(new Error(msg), { status: 422 });

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

        let url;
        try { url = new URL(track.baseUrl); } catch { throw noCaptions("This video's caption track URL was malformed."); }
        url.searchParams.set('fmt', 'json3');
        const resp = await safeFetch(url.href, { headers: { 'User-Agent': 'Mozilla/5.0 (Flashback transcript fetcher)' } });
        if (!resp.ok) throw noCaptions(`Could not download the caption track (${resp.status}).`);
        const cues = parseJson3Transcript(await resp.text());
        if (cues.length === 0) throw noCaptions("The caption track came back empty.");

        return { cues, lang: track.languageCode || (lang ?? 'und'), kind: track.kind === 'asr' ? 'asr' : 'manual' };
    }

    /**
     * Fetches a `.youtube` document's caption transcript from YouTube into the sidecar's `source` block.
     *
     * @param {string} relPath existing `.youtube` file
     * @param {object} [opts]
     * @param {string} [opts.lang] preferred caption language code (e.g. "en", "es")
     * @returns {Promise<{path: string, cues: number, lang: string, kind: string}>}
     * @throws {Error & {status:422}} when the video has no usable captions
     */
    async fetchYoutubeTranscript(relPath, { lang } = {}) {
        if (!await this.files.exists(relPath)) throw Object.assign(new Error("File not found"), { status: 404 });
        const existing = this.files.getMetadata(relPath) || newFileMetadata();

        let videoId = existing.source?.videoId;
        if (!videoId) {
            try { videoId = JSON.parse(this.files.readFile(relPath).content ?? '{}').videoId; } catch { }
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

    /**
     * Downloads one remote asset into `<mediaFolder>/media/`, registers it in the Media table, and returns its `./media/<name>` reference.
     *
     * @param {string} absSrc absolute http(s) URL
     * @param {object} opts
     * @param {string} opts.mediaFolder folder the clip lives in
     * @param {number} opts.maxBytes size ceiling
     * @param {(contentType: string|null, url: string) => string} opts.extFor
     * @returns {Promise<{localRef: string, name: string, mediaRel: string, bytes: number, mediaType: string|null}>}
     */
    async _cacheRemoteAsset(absSrc, { mediaFolder, maxBytes, extFor }) {
        if (!/^https?:/i.test(absSrc)) throw new Error(`Not a downloadable address: ${absSrc}`);

        let r;
        try {
            r = await safeFetch(absSrc, {
                headers: { 'User-Agent': CLIP_USER_AGENT },
            }, { allowPrivate: getAllowPrivateNetworkFetch() });
        } catch (err) {
            if (err.status === 400) throw err;
            throw new Error(`Could not reach ${new URL(absSrc).hostname}: ${err.message}`);
        }
        if (!r.ok) throw new Error(`The site refused that file (status ${r.status})`);
        if (/^text\/html/i.test(r.headers.get('content-type') ?? '')) {
            throw new Error('That address answers with a web page, not a file');
        }

        const tooBig = () => new Error(`That file is larger than the ${Math.round(maxBytes / 1024 / 1024)} MB limit`);
        const declared = Number(r.headers.get('content-length'));
        if (Number.isFinite(declared) && declared > maxBytes) throw tooBig();

        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length === 0) throw new Error('That file came back empty');
        if (buf.length > maxBytes) throw tooBig();

        const contentType = r.headers.get('content-type');
        const hash = crypto.createHash('sha256').update(buf).digest('hex');
        const name = `clip-${hash.slice(0, 12)}.${extFor(contentType, absSrc)}`;
        const mediaRel = path.join(mediaFolder, 'media', name);
        const mediaAbs = this.files.safePath(mediaRel);
        fs.mkdirSync(path.dirname(mediaAbs), { recursive: true });
        fs.writeFileSync(mediaAbs, buf);
        await db.transaction(async () => {
            await this.query.insertMedia({ hash, name, relativePath: mediaRel, absolutePath: mediaAbs });
        })();

        return {
            localRef: `./media/${name}`,
            name,
            mediaRel,
            bytes: buf.length,
            mediaType: contentType ? contentType.split(';')[0].trim() : null,
        };
    }

    async _buildClipDoc(url) {
        let html;
        try {
            const resp = await safeFetch(url, {
                headers: { 'User-Agent': CLIP_USER_AGENT },
            }, { allowPrivate: getAllowPrivateNetworkFetch() });
            if (!resp.ok) throw new Error(`status ${resp.status}`);
            html = await resp.text();
        } catch (err) {
            if (err.status === 400) throw err;
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

        const contentDom = new JSDOM(`<body>${article.content}</body>`, { url });
        const cdoc = contentDom.window.document;

        const clean = sanitizeHtml(cdoc.body.innerHTML, CLIP_SANITIZE_OPTS);
        const source = {
            url,
            siteName: siteName || article.siteName || '',
            byline: article.byline || '',
            title: article.title || '',
            excerpt: article.excerpt || '',
            clippedAt: new Date().toISOString(),
        };
        return { html: clean, source, title: article.title || 'clip' };
    }

    /**
     * Fetches a web page and stores a readable `.clip` snapshot.
     *
     * @param {string} url
     * @param {string} [relativePath=""] destination folder
     * @returns {Promise<{path: string, globalHash: string}>}
     */
    async createClip(url, relativePath = "") {
        const { html, source, title } = await this._buildClipDoc(url);
        const metadata = { ...newFileMetadata(), source };
        const name = slugifyName(title) + ".clip";
        return await this.importFile(name, relativePath, html, metadata);
    }

    /**
     * Populates an existing (e.g.
     *
     * @param {string} relPath existing `.clip` file
     * @param {string} url
     */
    async setClipSource(relPath, url) {
        if (!await this.files.exists(relPath)) throw new Error("File not found");
        const { html, source } = await this._buildClipDoc(url);
        const existing = this.files.getMetadata(relPath) || newFileMetadata();
        await this.files.updateFile(relPath, html, { ...existing, source });
        await sealEmitter.edit(relPath + '.flashback', [relPath]);
        return { path: relPath, globalHash: this.files.getMetadata(relPath)?.globalHash };
    }

    /**
     * Downloads one of a saved clip's remote assets into the vault and points the clip at the local copy.
     *
     * @param {string} relPath the `.clip` document
     * @param {string} href the asset's src or href as it appears in the body, or its bare file name
     * @returns {Promise<{path: string, href: string, name: string, kind: 'image'|'audio', bytes: number|null, mediaType: string|null, alreadySaved: boolean}>}
     */
    async saveClipAsset(relPath, href) {
        if (!/\.clip$/i.test(relPath)) throw new Error("Not a web clip");
        if (!await this.files.exists(relPath)) throw new Error("File not found");
        const wanted = String(href ?? '').trim();
        if (!wanted) throw new Error("No asset given");

        const { JSDOM } = await import('jsdom');
        const { content } = this.files.readFile(relPath);
        const cdoc = new JSDOM(`<body>${content ?? ''}</body>`).window.document;

        const el = resolveClipAsset(cdoc, wanted);
        const src = assetAddress(el);

        const tag = el.tagName.toUpperCase();
        const audioEl = tag === 'SOURCE' ? el.closest('audio') : (tag === 'AUDIO' ? el : null);
        const kind = (audioEl || tag === 'A') ? 'audio' : 'image';

        const local = src.match(/^\.?\/?media\/(.+)$/);
        if (local) {
            let name = local[1];
            try { name = decodeURIComponent(name); } catch { }
            return {
                path: relPath, href: src, name, kind,
                bytes: null, mediaType: null, alreadySaved: true,
            };
        }
        if (/^data:/i.test(src)) {
            throw new Error("That picture is written into the page itself — it is already saved with the clip");
        }

        const parent = path.dirname(relPath);
        const saved = await this._cacheRemoteAsset(src, {
            mediaFolder: parent === '.' ? '' : parent,
            maxBytes: kind === 'audio' ? MAX_AUDIO_BYTES : MAX_IMAGE_BYTES,
            extFor: kind === 'audio'
                ? (ct, u) => extFromAudioContentType(ct) || extFromUrl(u) || 'audio'
                : (ct, u) => extFromContentType(ct) || extFromUrl(u) || 'img',
        });

        let target = el;
        if (tag === 'A') {
            target = cdoc.createElement('audio');
            target.setAttribute('controls', '');
            target.setAttribute('preload', 'none');
            el.replaceWith(target);
        }

        target.setAttribute('src', saved.localRef);
        target.setAttribute('data-src', src);
        target.removeAttribute('srcset');
        if (audioEl) {
            for (const other of audioEl.querySelectorAll('source')) {
                if (other !== el) other.remove();
            }
            if (el !== audioEl) audioEl.removeAttribute('src');
        }

        const existing = this.files.getMetadata(relPath) || newFileMetadata();
        await this.files.updateFile(relPath, cdoc.body.innerHTML, existing);
        await sealEmitter.edit(relPath + '.flashback', [relPath, saved.mediaRel]);

        return {
            path: relPath, href: saved.localRef, name: saved.name, kind,
            bytes: saved.bytes, mediaType: saved.mediaType, alreadySaved: false,
        };
    }

    /**
     * Indexes a document that exists on disk (file + sidecar) but has no derived-layer row.
     *
     * @param {string} relPath - document path relative to the workspace root.
     * @returns {Promise<number>} the document's DB id.
     */
    async indexDocument(relPath) {
        if (await this.query.getDocumentByPath(relPath)) return await this.reindexDocument(relPath);

        const metadata = this.files.getMetadata(relPath, false);
        if (!metadata?.globalHash) throw new Error(`No valid sidecar for ${relPath}`);

        const absPath = this.files.safePath(relPath);
        const parentDir = path.dirname(relPath);
        await this._ensureFolderPath(parentDir === '.' ? '' : parentDir);
        const docId = await this._registerDocumentDerived({
            name: path.basename(relPath),
            fileRelPath: relPath,
            absPath,
            encoding: metadata.encoding ?? null,
            metadata,
        });
        await this._resolvePendingLinks(metadata.globalHash, (await this.query.getDocumentByPath(relPath)).node_id, relPath);
        return docId;
    }

    /**
     * Refreshes an existing document's index rows from its sidecar, which is canonical.
     *
     * @param {string} relPath - document path relative to the workspace root.
     * @returns {Promise<number>} the document's DB id.
     */
    async reindexDocument(relPath) {
        const doc = await this.query.getDocumentByPath(relPath);
        if (!doc) return await this.indexDocument(relPath);

        const metadata = this.files.getMetadata(relPath, false);
        if (!metadata) throw new Error(`No readable sidecar for ${relPath}`);

        await db.transaction(async () => {
            if (metadata.globalHash && metadata.globalHash !== doc.global_hash) {
                await this.query.updateDocumentMetadata(doc.id, { globalHash: metadata.globalHash });
            }
            await this._syncTags(doc.node_id, metadata.tags ?? []);
            await this._syncDocumentFlashcards(doc.id, metadata.flashcards ?? [], doc.node_id);
            await this.query.syncDocumentHighlights(doc.id, metadata.highlights ?? []);

            if (doc.folder_id) {
                const folder = await this.query.getFolderById(doc.folder_id);
                if (folder) {
                    const folderRelPath = path.relative(this.files.workspaceRoot, folder.absolute_path);
                    const folderMeta = this.files.getMetadata(folderRelPath, true) || {};
                    await this._propagateFolderTags(folder.id, folder.node_id, folderMeta);
                }
            }
        })();

        await this.indexDocumentLinks(relPath);
        return doc.id;
    }

    /**
     * Indexes a folder that exists on disk (row for every missing ancestor included) and syncs its tags + inheritance from its sidecar.
     *
     * @param {string} relPath - folder path relative to the workspace root ('' = root).
     * @returns {number} the folder's DB id.
     */
    async indexFolder(relPath) {
        const folderId = await this._ensureFolderPath(relPath);
        const folder = await this.query.getFolderById(folderId);
        const metadata = this.files.getMetadata(relPath, true) || {};

        await db.transaction(async () => {
            if (metadata.globalHash && metadata.globalHash !== folder.global_hash) {
                await this.query.updateFolderMetadata(folder.id, { globalHash: metadata.globalHash });
            }
            if (folder.node_id) await this._syncTags(folder.node_id, metadata.tags ?? []);
            await this._propagateFolderTags(folder.id, folder.node_id, metadata);
        })();
        return folderId;
    }

    /**
     * Removes a document's or folder tree's index rows for an item already deleted on disk.
     *
     * @param {string} relPath - path relative to the workspace root.
     * @param {boolean} [isFolder=false]
     */
    async removeFromIndex(relPath, isFolder = false) {
        const absPath = this.files.safePath(relPath);
        await db.transaction(async () => {
            if (isFolder) {
                await this.query.deleteFolderTree(absPath, path.sep);
            } else {
                await this.query.deleteDocumentByAbsPath(absPath);
            }
        })();
    }

    /** Imports a package exported by this app. */
    async importPackage(externalPath, targetRelPath = "") {
        const folderName = path.basename(externalPath);
        const folderRelPath = path.join(targetRelPath, folderName);
        
        const nodeId = await this.query.createNode('Folder');
        const absPath = this.files.safePath(folderRelPath);
        const globalHash = crypto.randomUUID();
        const parentId = await this._getParentFolderId(absPath);

        if (!fs.existsSync(absPath)) fs.mkdirSync(absPath, { recursive: true });

        await this.query.insertFolder({
            nodeId, globalHash, parentId, relativePath: folderRelPath, absolutePath: absPath, name: folderName
        });

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
                                await this.query.insertMedia({
                                    hash: mHash, name: mFile, relativePath: path.join(entryRel, mFile), absolutePath: mDest
                                });
                            }
                        }
                    } else {
                        const subNodeId = await this.query.createNode('Folder');
                        const subAbs = this.files.safePath(entryRel);
                        if (!fs.existsSync(subAbs)) fs.mkdirSync(subAbs, { recursive: true });
                        const subParentId = await this._getParentFolderId(subAbs);
                        await this.query.insertFolder({
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

    /** Unpacks an uploaded `.zip` and imports what it holds. */
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

    /** Packages a document and its media for export. */
    exportPackage(relativePath) {
        const sourcePath = this.files.safePath(relativePath);
        const zip = new AdmZip();
        zip.addLocalFolder(sourcePath, path.basename(sourcePath));
        const zipPath = path.join(os.tmpdir(), `${path.basename(sourcePath)}_${Date.now()}.zip`);
        zip.writeZip(zipPath);
        return zipPath;
    }

    /**
     * Creates a single vanilla flashcard in a document's sidecar and attaches any provided media in one atomic operation.
     *
     * @param {string} relativePath - relative path to the target document.
     * @param {object} cardData - the card object (front/back text, tags, category, location, …). Any client-supplied globalHash is ignored — the API owns it.
     * @param {Array<{ buffer: Buffer, originalName: string, type: "image"|"sound", position: "front"|"back" }>} [mediaItems=[]]
     * @returns {object} The persisted card, including its assigned globalHash and media refs.
     */
    async createFlashcard(relativePath, cardData, mediaItems = []) {
        return await withDocument(relativePath, () =>
            this._createFlashcardLocked(relativePath, cardData, mediaItems));
    }

    async _createFlashcardLocked(relativePath, cardData, mediaItems = []) {
        const doc = await this.query.getDocumentByPath(relativePath);
        if (!doc) throw new Error(`Document ${relativePath} not found in DB`);

        if (cardData.category && !await this.query.getCategoryByName(cardData.category)) {
            throw new Error(`Unknown category: "${cardData.category}". Call GET /api/categories for valid values.`);
        }

        const meta = this.files.getMetadata(relativePath) || {};
        if (!Array.isArray(meta.flashcards)) meta.flashcards = [];
        const card = { ...cardData };
        delete card.globalHash;
        if (card.origin !== 'ai') delete card.origin;
        meta.flashcards.push(card);
        const cardIndex = meta.flashcards.length - 1;
        this.files.writeMetadata(relativePath, meta, false);

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

        const finalMeta = this.files.getMetadata(relativePath);
        const savedCard = finalMeta.flashcards[cardIndex];
        await db.transaction(async () => {
            if (finalMeta.tags) await this._syncTags(doc.node_id, finalMeta.tags);
            await this._syncDocumentFlashcards(doc.id, finalMeta.flashcards, doc.node_id);
            for (const r of registered) {
                await this.query.insertMedia({
                    hash: r.hash, name: r.name,
                    relativePath: r.mediaRel, absolutePath: this.files.safePath(r.mediaRel),
                });
            }
        })();

        await sealEmitter.edit(relativePath + '.flashback', mediaRels);
        return savedCard;
    }

    /**
     * Edits a document-anchored flashcard's content in place.
     *
     * @param {string} relativePath - document the card is anchored to.
     * @param {string} flashcardHash - globalHash of the card to edit.
     * @param {object} patch - any of { frontText, backText, answerText, name, cardType, category, customHtml, tags }.
     * @returns {object} the updated card as written to the sidecar.
     */
    /**
     * Patches ONE card inside a document's sidecar.
     *
     * @param {string} relativePath
     * @param {string} flashcardHash
     * @param {object} [patch]
     * @param {object} [opts]
     * @param {string} [opts.ifMatch] - entity etag (see Files.entityEtag) of the card as read.
     */
    async updateFlashcard(relativePath, flashcardHash, patch = {}, { ifMatch } = {}) {
        return await withDocument(relativePath, () =>
            this._updateFlashcardLocked(relativePath, flashcardHash, patch, ifMatch));
    }

    async _updateFlashcardLocked(relativePath, flashcardHash, patch = {}, ifMatch = undefined) {
        const doc = await this.query.getDocumentByPath(relativePath);
        if (!doc) throw new Error(`Document ${relativePath} not found in DB`);

        if (patch.category && !await this.query.getCategoryByName(patch.category)) {
            throw new Error(`Unknown category: "${patch.category}". Call GET /api/categories for valid values.`);
        }

        const meta = this.files.getMetadata(relativePath) || {};
        const cards = Array.isArray(meta.flashcards) ? meta.flashcards : [];
        const idx = cards.findIndex(f => f.globalHash === flashcardHash);
        if (idx === -1) throw new Error(`Flashcard ${flashcardHash} not found in ${relativePath}`);

        const ex = cards[idx];
        this._assertEntityFresh(ex, ifMatch);
        const nextType = patch.cardType ?? ex.cardType ?? 'basic';
        const updated = { ...ex, cardType: nextType };
        if (patch.name !== undefined) updated.name = patch.name;
        if (patch.tags !== undefined) updated.tags = patch.tags;
        if (patch.category !== undefined) updated.category = patch.category;
        if (nextType === 'custom') {
            updated.customData = {
                ...(ex.customData || {}),
                html: patch.customHtml !== undefined ? patch.customHtml : (ex.customData?.html ?? ''),
            };
        } else {
            updated.vanillaData = {
                ...(ex.vanillaData || {}),
                frontText: patch.frontText !== undefined ? patch.frontText : (ex.vanillaData?.frontText ?? ''),
                backText: patch.backText !== undefined ? patch.backText : (ex.vanillaData?.backText ?? ''),
            };
            if (nextType === 'type_answer') {
                const answerText = patch.answerText !== undefined ? patch.answerText : ex.vanillaData?.answerText;
                if (answerText != null) updated.vanillaData.answerText = answerText;
            } else {
                delete updated.vanillaData.answerText;
            }
        }

        meta.flashcards[idx] = updated;
        this.files.writeMetadata(relativePath, meta, false);

        await db.transaction(async () => {
            await this._syncDocumentFlashcards(doc.id, meta.flashcards, doc.node_id);
        })();

        await sealEmitter.edit(relativePath + '.flashback');
        return updated;
    }

    /**
     * Permanently deletes a document-anchored flashcard, dropping it from the sidecar's `flashcards[]` and letting the derived-layer sync remove the row.
     *
     * @param {string} relativePath - document the card is anchored to.
     * @param {string} flashcardHash - globalHash of the card to delete.
     */
    async deleteFlashcard(relativePath, flashcardHash) {
        return await withDocument(relativePath, () =>
            this._deleteFlashcardLocked(relativePath, flashcardHash));
    }

    async _deleteFlashcardLocked(relativePath, flashcardHash) {
        const doc = await this.query.getDocumentByPath(relativePath);
        if (!doc) throw new Error(`Document ${relativePath} not found in DB`);

        const meta = this.files.getMetadata(relativePath) || {};
        const cards = Array.isArray(meta.flashcards) ? meta.flashcards : [];
        if (!cards.some(f => f.globalHash === flashcardHash)) {
            throw new Error(`Flashcard ${flashcardHash} not found in ${relativePath}`);
        }

        meta.flashcards = cards.filter(f => f.globalHash !== flashcardHash);
        this.files.writeMetadata(relativePath, meta, false);

        await db.transaction(async () => {
            await this._syncDocumentFlashcards(doc.id, meta.flashcards, doc.node_id);
            // The sync's orphan sweep drops the index row but deliberately leaves behavioural
            // rows alone — a card vanishing from a sidecar is not a decision to destroy
            // anyone's history. This IS that decision, so it purges explicitly.
            await this.query.purgeCardBehaviour(flashcardHash);
        })();

        await sealEmitter.edit(relativePath + '.flashback');
    }

    /** Attaches an asset to a card and registers it in the Media table. */
    async addMediaToFlashcard(relativePath, flashcardHash, mediaBuffer, mediaName) {
        return await withDocument(relativePath, () =>
            this._addMediaToFlashcardLocked(relativePath, flashcardHash, mediaBuffer, mediaName));
    }

    async _addMediaToFlashcardLocked(relativePath, flashcardHash, mediaBuffer, mediaName) {
        const meta = this.files.getMetadata(relativePath);
        const cardIdx = meta.flashcards.findIndex(f => f.globalHash === flashcardHash);
        if (cardIdx === -1) throw new Error(`Flashcard ${flashcardHash} not found`);

        this.files.addCustomMedia(relativePath, mediaBuffer, mediaName, cardIdx);

        const mediaRel = path.join(path.dirname(relativePath), "media", mediaName);
        const mediaAbs = this.files.safePath(mediaRel);
        const hash = crypto.createHash('sha256').update(mediaBuffer).digest('hex');

        await db.transaction(async () => {
            await this.query.insertMedia({ hash, name: mediaName, relativePath: mediaRel, absolutePath: mediaAbs });
        })();
        await sealEmitter.edit(relativePath + '.flashback', [mediaRel]);
    }

    /** Grades a card, writing the schedule and, for the owner, the sidecar. */
    async submitReview(relativePath, flashcardHash, outcome, easeFactor, newLevel, algorithm = 'leitner', opts = {}) {
        const owner = isOwnerScope(opts.scope ?? currentScope());

        let metadata = null;
        let card = null;
        if (owner) {
            metadata = this.files.getMetadata(relativePath);
            card = metadata?.flashcards?.find(f => f.globalHash === flashcardHash);
            if (!card) throw new Error(`Flashcard ${flashcardHash} not found in sidecar for ${relativePath}`);
        }

        const { documentId, fsrs, scope } = await this.srs.submitReview(
            flashcardHash, outcome, easeFactor, newLevel, algorithm, opts,
        );

        if (!isOwnerScope(scope)) return;

        if (!card) {
            metadata = this.files.getMetadata(relativePath);
            card = metadata?.flashcards?.find(f => f.globalHash === flashcardHash);
            if (!card) throw new Error(`Flashcard ${flashcardHash} not found in sidecar for ${relativePath}`);
        }

        if (algorithm === 'fsrs' && fsrs) {
            card.fsrsStability = fsrs.stability;
            card.fsrsDifficulty = fsrs.difficulty;
            card.fsrsDue = fsrs.due;
            card.fsrsState = fsrs.state;
            card.fsrsReps = fsrs.reps;
            card.fsrsLapses = fsrs.lapses;
            card.level = fsrs.level;
            card.lastRecall = fsrs.last_review;
        } else {
            if (algorithm === 'sm2') card.sm2Reps = newLevel; else card.level = newLevel;
            card.easeFactor = easeFactor;
            card.lastRecall = new Date().toISOString();
        }
        this.files.writeMetadata(relativePath, metadata);

        await this.propagatePresence(documentId);
        await sealEmitter.review(relativePath + '.flashback');
    }

    /** Reverts the caller's last grade on a card. */
    async undoReview(relativePath, flashcardHash, algorithm = 'leitner') {
        const { document_id, restored, scope } = await this.srs.undoReview(flashcardHash, algorithm);

        if (!isOwnerScope(scope)) return restored;

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
                    card.level = 0;
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
            await sealEmitter.review(relativePath + '.flashback');
        }

        if (document_id) await this.propagatePresence(document_id);
        return restored;
    }

    async _ensureFolderPath(relativePath) {
        let root = await this.query.getFolderByPath("");
        let parentId;
        let parentAbs = this.files.workspaceRoot;
        if (root) {
            parentId = root.id;
        } else {
            const nodeId = await this.query.createNode('Folder');
            const info = await this.query.insertFolder({
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
            let folder = await this.query.getFolderByPath(builtRel);
            if (!folder) {
                const globalHash = this.files.ensureFolderMetadata(priorRel, seg);
                const absPath = this.files.safePath(builtRel);
                const nodeId = await this.query.createNode('Folder');
                const info = await this.query.insertFolder({
                    nodeId, globalHash, parentId, relativePath: builtRel, absolutePath: absPath, name: seg,
                });
                const parentFolder = await this.query.getFolderByAbsolutePath(parentAbs);
                if (parentFolder?.node_id) {
                    await this.query.insertInheritance(parentFolder.node_id, nodeId);
                    await this._seedFromParentFolder(parentFolder, nodeId);
                }
                folder = { id: info.lastInsertRowid };
            }
            parentId = folder.id;
            parentAbs = this.files.safePath(builtRel);
        }
        return parentId;
    }

    async _getParentFolderId(absolutePath) {
        const parentDir = path.dirname(absolutePath);
        if (parentDir === this.files.workspaceRoot) {
            const root = await this.query.getFolderByPath("");
            if (root) return root.id;

            const nodeId = await this.query.createNode('Folder');
            const info = await this.query.insertFolder({
                nodeId, globalHash: crypto.randomUUID(), parentId: null,
                relativePath: "", absolutePath: parentDir, name: path.basename(parentDir)
            });
            return info.lastInsertRowid;
        }
        const folder = await this.query.getFolderByAbsolutePath(parentDir);
        return folder ? folder.id : null;
    }

    async _syncTags(nodeId, tagNames) {
        const tagNodeIds = [];
        for (const name of tagNames) {
            let tag = await this.query.getTagByName(name);
            if (!tag) {
                const tNodeId = await this.query.createNode('Tag');
                await this.query.insertTag(name, tNodeId);
                tagNodeIds.push(tNodeId);
            } else {
                tagNodeIds.push(tag.node_id);
            }
        }
        await this.query.syncNodeTags(nodeId, tagNodeIds);
    }

    /** Mirrors a sidecar's flashcards[] into the derived layer. */
    async _syncDocumentFlashcards(documentId, flashcardsData, docNodeId = null) {
        const existing = await this.query.getFlashcardsByDocument(documentId, OWNER_SCOPE);
        const existingMap = new Map(existing.map(f => [f.global_hash, f]));
        const incomingHashes = new Set();

        for (const [index, fcData] of flashcardsData.entries()) {
            incomingHashes.add(fcData.globalHash);
            const match = existingMap.get(fcData.globalHash);

            if (match) {
                const mergedLevel = Math.max(fcData.level ?? 0, match.level ?? 0);
                const mergedSm2Reps = Math.max(fcData.sm2Reps ?? 0, match.sm2_reps ?? 0);
                const mergedRecall = (mergedLevel === (fcData.level ?? 0) && fcData.lastRecall)
                    ? fcData.lastRecall
                    : (match.last_recall ?? fcData.lastRecall);

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

                await this.query.updateFlashcard(match.id, {
                    ...fcData,
                    ...fsrsFromDb,
                    level: mergedLevel,
                    sm2Reps: mergedSm2Reps,
                    lastRecall: mergedRecall,
                    fileIndex: index,
                    contentId: match.content_id
                }, OWNER_SCOPE);
                if (Array.isArray(fcData.tags)) await this._syncTags(match.node_id, fcData.tags);
            } else {
                const nodeId = await this.query.createNode('Flashcard');
                await this.query.insertFlashcard({
                    ...fcData, nodeId, documentId, fileIndex: index
                }, OWNER_SCOPE);
                if (Array.isArray(fcData.tags)) await this._syncTags(nodeId, fcData.tags);
            }
        }

        for (const [hash, fc] of existingMap) {
            if (!incomingHashes.has(hash)) await this.query.deleteFlashcard(fc.id);
        }

        if (docNodeId) {
            await this._propagateTagsToFlashcards(documentId, docNodeId, await this._tagsPassedDownByDocument(docNodeId));
        }
    }

    /** The tag set a folder hands down to its children: whatever it inherits on its own incoming edge (minus its own exclusions) plus its direct tags. */
    async _tagsPassedDownByFolder(folderNodeId, folderRelPath) {
        const meta = this.files.getMetadata(folderRelPath, true) || {};
        const excluded = new Set(meta.excludedTags || []);
        const inherited = (await this.query.getInheritedTagNames(folderNodeId)).filter(t => !excluded.has(t));
        const direct = await this.query.getDirectTagNames(folderNodeId);
        return [...new Set([...inherited, ...direct])];
    }

    /** Fills a parent→child inheritance edge with the parent's effective tags. */
    async _seedInheritedTags(parentNodeId, childNodeId, tagNames) {
        if (!parentNodeId || !childNodeId) return;
        const hierarchyType = await this.query.getHierarchyTypeId();
        const conn = await this.query.getOrCreateConnection(parentNodeId, childNodeId, hierarchyType.id);
        await this.query.clearInheritedTags(conn.id);
        for (const tagName of tagNames) {
            const tag = await this.query.getTagByName(tagName);
            if (tag) await this.query.insertInheritedTag(conn.id, tag.id);
        }
    }

    async _seedFromParentFolder(parentFolder, childNodeId) {
        if (!parentFolder?.node_id) return;
        await this._seedInheritedTags(
            parentFolder.node_id,
            childNodeId,
            await this._tagsPassedDownByFolder(parentFolder.node_id, parentFolder.relative_path),
        );
    }

    async _tagsPassedDownByDocument(docNodeId) {
        const inherited = await this.query.getInheritedTagNames(docNodeId);
        const direct = await this.query.getDirectTagNames(docNodeId);
        return [...new Set([...inherited, ...direct])];
    }

    async _propagateFolderTags(folderId, parentNodeId, metadata) {
        const childDocs = await this.query.getChildDocuments(folderId);
        const childFolders = await this.query.getChildFolders(folderId);

        const inheritedFromAbove = await this.query.getInheritedTagNames(parentNodeId);
        const myDirectTags = new Set(metadata.tags || []);
        const myExclusions = new Set(metadata.excludedTags || []);
        const effectiveInherited = inheritedFromAbove.filter(t => !myExclusions.has(t));
        const effectiveToChildren = [...new Set([...effectiveInherited, ...myDirectTags])];

        const hierarchyType = await this.query.getHierarchyTypeId();

        const syncInheritance = async (targetNodeId) => {
            const conn = await this.query.getOrCreateConnection(parentNodeId, targetNodeId, hierarchyType.id);
            await this.query.clearInheritedTags(conn.id);
            for (const tagName of effectiveToChildren) {
                const tag = await this.query.getTagByName(tagName);
                if (tag) await this.query.insertInheritedTag(conn.id, tag.id);
            }
        };

        for (const doc of childDocs) {
            await syncInheritance(doc.node_id);
            await this._propagateTagsToFlashcards(doc.id, doc.node_id, effectiveToChildren);
        }

        for (const folder of childFolders) {
            await syncInheritance(folder.node_id);
            const subMeta = this.files.getMetadata(folder.relative_path, true) || {};
            await this._propagateFolderTags(folder.id, folder.node_id, subMeta);
        }
    }

    async _propagateTagsToFlashcards(docId, docNodeId, tags) {
        const hierarchyType = await this.query.getHierarchyTypeId();
        for (const fc of await this.query.getFlashcardNodeIds(docId)) {
            const conn = await this.query.getOrCreateConnection(docNodeId, fc.node_id, hierarchyType.id);
            await this.query.clearInheritedTags(conn.id);
            for (const tagName of tags) {
                const tag = await this.query.getTagByName(tagName);
                if (tag) await this.query.insertInheritedTag(conn.id, tag.id);
            }
        }
    }

    static _MEDIA_REF = /\.\/media\/([^"')\s>]+)/g;

    static _IS_HASH = /^[a-f0-9]{64}$/i;

    _mediaNamesReferencedBy(relDocPath) {
        const names = new Set();
        const addRefsIn = (text) => {
            if (!text) return;
            for (const m of String(text).matchAll(Documents._MEDIA_REF)) {
                names.add(path.basename(m[1]));
            }
        };

        const meta = this.files.getMetadata(relDocPath);
        for (const card of meta?.flashcards ?? []) {
            for (const ref of Object.values(card?.vanillaData?.media ?? {})) {
                if (ref && !Documents._IS_HASH.test(String(ref))) {
                    names.add(path.basename(String(ref).replace(/\\/g, '/')));
                }
            }
            addRefsIn(card?.customData?.html);
        }

        try { addRefsIn(this.files.readFile(relDocPath).content); } catch { }

        return names;
    }

    async _mediaNamesStillNeededIn(folderRel, excludeRelDocPath) {
        const folderAbs = this.files.safePath(folderRel);
        const needed = new Set();
        for (const doc of await this.query.getDocumentsByAbsPathPrefix(folderAbs + path.sep)) {
            if (doc.relative_path === excludeRelDocPath) continue;
            if (path.dirname(doc.relative_path) !== folderRel) continue;
            for (const name of this._mediaNamesReferencedBy(doc.relative_path)) needed.add(name);
        }
        return needed;
    }

    _replicateMedia(relDocPath, oldFolder, newFolder) {
        const added = [], carried = [];
        if (oldFolder === newFolder) return { added, carried };

        for (const name of this._mediaNamesReferencedBy(relDocPath)) {
            const srcAbs = this.files.safePath(path.join(oldFolder, 'media', name));
            if (!fs.existsSync(srcAbs)) continue;

            const destRel = path.join(newFolder, 'media', name);
            const destAbs = this.files.safePath(destRel);
            fs.mkdirSync(path.dirname(destAbs), { recursive: true });
            if (!fs.existsSync(destAbs)) fs.copyFileSync(srcAbs, destAbs);
            added.push(destRel);
            carried.push(name);
        }
        return { added, carried };
    }

    async _carryMediaAfterMove(oldRelDocPath, newRelDocPath) {
        const oldFolder = path.dirname(oldRelDocPath);
        const newFolder = path.dirname(newRelDocPath);
        if (oldFolder === newFolder) return { added: [], removed: [] };

        const { added, carried } = this._replicateMedia(newRelDocPath, oldFolder, newFolder);
        if (carried.length === 0) return { added, removed: [] };

        const stillNeeded = await this._mediaNamesStillNeededIn(oldFolder, newRelDocPath);
        const removed = [];

        for (const name of carried) {
            if (stillNeeded.has(name)) {
                continue;
            }
            const srcRel = path.join(oldFolder, 'media', name);
            const srcAbs = this.files.safePath(srcRel);
            const destRel = path.join(newFolder, 'media', name);
            fs.rmSync(srcAbs, { force: true });
            removed.push(srcRel);
            await this.query.updateMediaPath(srcAbs, destRel, this.files.safePath(destRel));
        }

        const srcMediaAbs = this.files.safePath(path.join(oldFolder, 'media'));
        try {
            if (fs.existsSync(srcMediaAbs) && fs.readdirSync(srcMediaAbs).length === 0) {
                fs.rmdirSync(srcMediaAbs);
            }
        } catch { }

        return { added, removed };
    }

    async _buildMovePaths(oldRelPath, newRelPath, newAbsPath) {
        const prefix = newAbsPath + path.sep;
        const docs = await this.query.getDocumentsByAbsPathPrefix(prefix);
        const folders = await this.query.getFoldersByAbsPathPrefix(prefix, newAbsPath);

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

    async _gatherFolderContents(folderRelPath, folderAbsPath) {
        const prefix = folderAbsPath + path.sep;
        const docs = await this.query.getDocumentsByAbsPathPrefix(prefix);
        const folders = await this.query.getFoldersByAbsPathPrefix(prefix, folderAbsPath);

        const paths = [];
        for (const doc of docs) {
            paths.push(doc.relative_path, doc.relative_path + '.flashback');
        }
        for (const folder of folders) {
            paths.push(path.join(folder.relative_path, '.flashback'));
        }
        return paths;
    }

    /** Recomputes stored presence up the folder tree from a document. */
    async propagatePresence(documentId) {
        await db.transaction(async () => {
            const stats = await this.query.getFlashcardAvgLevel(documentId, OWNER_SCOPE);
            await this.query.updateDocumentPresence(documentId, stats.score || 0);

            let currentFolderId = (await this.query.getDocumentFolderIdById(documentId))?.folder_id;
            while (currentFolderId) {
                const docStats = await this.query.getDocumentPresenceStats(currentFolderId);
                const childFolders = await this.query.getChildFolderPresences(currentFolderId);

                const totalCount = (docStats.cnt || 0) + childFolders.length;
                const totalPresence = (docStats.total || 0) + childFolders.reduce((acc, f) => acc + (f.presence || 0), 0);
                const avg = totalCount > 0 ? (totalPresence / totalCount) : 0;

                await this.query.updateFolderPresence(currentFolderId, avg);

                currentFolderId = (await this.query.getFolderParentId(currentFolderId))?.parent_id ?? null;
            }
        })();
    }

    /** Searches names and metadata across the workspace. */
    async search(q) { return await this.query.search(q); }

    /** Searches document bodies, returning matching snippets. */
    async searchContent(q, limit = 20) {
        const needle = String(q ?? '').toLowerCase();
        if (!needle) return [];
        const results = [];
        for (const doc of await this.query.getAllDocuments()) {
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

    /** A document's outgoing links and backlinks. */
    async getLinks(relPath) {
        const doc = await this.query.getDocumentByPath(relPath);
        if (!doc) throw new Error(`Document ${relPath} not found`);
        const { outgoing, backlinks } = await this.query.getDocumentLinkEdges(doc.node_id);
        const pending = (await this.query.getPendingLinksFromSource(doc.global_hash))
            .map((l) => ({ targetHash: l.target_hash, anchorText: l.anchor_text }));
        return { outgoing, backlinks, pending };
    }

    /** Nodes and edges for the graph view. */
    async getGraphData(scope) {
        const { nodes, edges } = await this.query.getGraphData(scope ?? currentScope());
        return { nodes: nodes.map(graphNodeLearning), edges };
    }
    /** Whether a path exists in the workspace. */
    async exists(rel, derived, isFolder) {
        if (derived) return isFolder ? await this.query.getFolderByPath(rel) : await this.query.getDocumentByPath(rel);
        return await this.files.exists(rel);
    }
}
