import path from 'path';
import fs from 'fs';
import * as Files from '../resources/files.js';
import { withDocument, withStructure } from '../resources/pathLock.js';
import { safeFetch } from '../resources/safeFetch.js';
import { getAllowPrivateNetworkFetch, getCardRemovalLimits } from '../primitives/config.js';
import cardRemovalBudget from '../resources/cardRemovalBudget.js';
import { PROGRESS_KEYS } from '../resources/db/sql.js';
import * as cardProgressRows from '../resources/db/cardProgress.js';
import * as categoryRows from '../resources/db/categories.js';
import * as documentRows from '../resources/db/documents.js';
import * as flashcardRows from '../resources/db/flashcards.js';
import * as folderRows from '../resources/db/folders.js';
import * as graphRows from '../resources/db/graph.js';
import * as highlightRows from '../resources/db/highlights.js';
import * as linkRows from '../resources/db/links.js';
import * as mediaRows from '../resources/db/media.js';
import * as nodeRows from '../resources/db/nodes.js';
import * as searchRows from '../resources/db/search.js';
import * as statisticsRows from '../resources/db/statistics.js';
import * as tagRows from '../resources/db/tags.js';
import * as Srs from './srs.js';
import db from '../primitives/database.js';
import crypto from 'crypto';
import os from 'os';
import AdmZip from 'adm-zip';
import { sealEmitter } from '../../seal/seal.js';
import * as Highlights from './highlights.js';
import newFileMetadata from '../../config/defaults/FlashbackFile.js';
import { OWNER_SCOPE, currentScope, isOwnerScope, currentAccount } from '../../requestContext.js';
import { ROLES, atLeast } from '../../../shared/roles.js';
import { COVER_TYPES, COVER_PATTERNS, MAX_COVER_BYTES, cleanCover, clampCoverY } from '../../../shared/covers.js';
import { swapTag } from '../../../shared/tagNames.js';

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

export function pickCaptionTrack(playerResponse, lang) {
    const tracks =
        playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!Array.isArray(tracks) || tracks.length === 0) return null;
    const want = String(lang || "en").toLowerCase();
    const inLang = tracks.filter((t) => (t.languageCode || "").toLowerCase().startsWith(want));
    const manual = (arr) => arr.find((t) => t.kind !== "asr");
    return manual(inLang) || inLang[0] || manual(tracks) || tracks[0];
}

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

function assetAddress(el) {
    return (el.tagName.toUpperCase() === 'A' ? el.getAttribute('href') : el.getAttribute('src')) || '';
}

function clipAssetNodes(cdoc) {
    return Array.from(cdoc.querySelectorAll('img[src], audio[src], source[src], a[href]'))
        .filter((n) => n.tagName.toUpperCase() !== 'A'
            || isSoundLink(n.getAttribute('href'))
            || isSoundLink(n.getAttribute('data-src')));
}

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

const _LINK_RE = /\[([^\]]*)\]\(flashback:\/\/([a-f0-9-]+)\)/g;

const _MEDIA_REF = /\.\/media\/([^"')\s>]+)/g;

const _IS_HASH = /^[a-f0-9]{64}$/i;

function _assertFresh(relativePath, ifMatch, { isFolder = false, part = 'sidecar' } = {}) {
    if (!ifMatch) return;
    const current = Files.etag(relativePath, isFolder);
    const half = (etag) => (typeof etag === 'string' ? etag.split('.')[part === 'body' ? 0 : 1] : etag);
    if (half(current) === half(ifMatch)) return;
    throw Object.assign(
        new Error('This document changed since you last read it.'),
        { status: 409, code: 'stale', etag: current },
    );
}

export function cardEtag(relativePath, flashcardHash) {
    if (!relativePath) return null;
    const meta = Files.getMetadata(relativePath) || {};
    const cards = Array.isArray(meta.flashcards) ? meta.flashcards : [];
    return Files.entityEtag(cards.find(f => f.globalHash === flashcardHash));
}

function _assertEntityFresh(entity, ifMatch) {
    if (!ifMatch) return;
    const current = Files.entityEtag(entity);
    if (current === ifMatch) return;
    throw Object.assign(
        new Error('This card changed since you last read it.'),
        { status: 409, code: 'stale', etag: current },
    );
}

export async function listFolder(relPath) {
    const items = await Files.listFolder(relPath);
    const folder = await folderRows.getByPath(relPath);

    let fileCountMap = new Map();
    let folderCountMap = new Map();

    if (folder) {
        const counts = await flashcardRows.getCountsByFolder(folder.id);
        fileCountMap = new Map(counts.map(r => [r.name, r.count]));

        const subfolderNames = [];
        for (const i of items) { if (i.type === 'folder') subfolderNames.push(i.name); }
        if (subfolderNames.length > 0) {
            const childRelPaths = subfolderNames.map(n => path.join(relPath, n));
            const childFolders = await folderRows.getByPaths(childRelPaths);
            if (childFolders.length > 0) {
                const countsByRootId = await flashcardRows.getCountsInFolderTrees(childFolders.map(f => f.id));
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

export async function createFile(name, relativePath = "") {
    const { globalHash, name: resolvedName } = await Files.createFile(relativePath, name);
    const fileRelPath = path.join(relativePath, resolvedName);

    try {
        const absPath = Files.safePath(fileRelPath);
        await db.transaction(async () => {
            const nodeId = await nodeRows.create('Document');
            const folderId = await _ensureFolderPath(relativePath);
            await documentRows.insert({
                folderId, nodeId, globalHash,
                relativePath: fileRelPath, absolutePath: absPath, name: resolvedName,
                encoding: 'UTF-8'
            });
            const parentFolder = await folderRows.getById(folderId);
            if (parentFolder?.node_id) {
                await nodeRows.insertInheritance(parentFolder.node_id, nodeId);
                await _seedFromParentFolder(parentFolder, nodeId);
            }
        })();
    } catch (err) {
        await Files.remove(fileRelPath, false);
        throw err;
    }
    await sealEmitter.create(fileRelPath + '.flashback', [fileRelPath]);
}

export async function createFolder(name, relativePath = "") {
    const folderRelPath = path.join(relativePath, name);
    const globalHash = await Files.createFolder(relativePath, name);

    try {
        const absPath = Files.safePath(folderRelPath);
        await db.transaction(async () => {
            const nodeId = await nodeRows.create('Folder');
            const parentId = await _ensureFolderPath(relativePath);
            await folderRows.insert({
                nodeId, globalHash, parentId, relativePath: folderRelPath, absolutePath: absPath, name
            });
            const parentFolder = await folderRows.getById(parentId);
            if (parentFolder?.node_id) {
                await nodeRows.insertInheritance(parentFolder.node_id, nodeId);
                await _seedFromParentFolder(parentFolder, nodeId);
            }
        })();
    } catch (err) {
        await Files.remove(folderRelPath, true);
        throw err;
    }
    await sealEmitter.create(path.join(folderRelPath, '.flashback'));
}

export async function rename(relativePath, newName, isFolder = false) {
    return await withStructure(() => _renameLocked(relativePath, newName, isFolder));
}

async function _renameLocked(relativePath, newName, isFolder = false) {
    const oldAbsPath = Files.safePath(relativePath);
    const parentDir = path.dirname(relativePath);
    const newRelPath = path.join(parentDir, newName);
    const newAbsPath = Files.safePath(newRelPath);

    await Files.rename(relativePath, newName, isFolder);

    try {
        await db.transaction(async () => {
            if (isFolder) {
                await folderRows.rename(newName, newRelPath, newAbsPath, oldAbsPath);
                await documentRows.cascadeRenamePaths(relativePath, newRelPath, oldAbsPath, newAbsPath);
                await folderRows.cascadeRenamePaths(relativePath, newRelPath, oldAbsPath, newAbsPath);
            } else {
                await documentRows.rename(newName, newRelPath, newAbsPath, oldAbsPath);
            }
        })();
    } catch (err) {
        await Files.rename(newRelPath, path.basename(relativePath), isFolder);
        throw err;
    }
    if (isFolder) {
        const { removed, added } = await _buildMovePaths(relativePath, newRelPath, newAbsPath);
        await sealEmitter.move(relativePath, newRelPath, removed, added);
    } else {
        await sealEmitter.move(relativePath, newRelPath,
            [relativePath, relativePath + '.flashback'],
            [newRelPath, newRelPath + '.flashback']
        );
    }
}

export async function move(relativePath, newRelativePath, isFolder = false) {
    return await withStructure(() => _moveLocked(relativePath, newRelativePath, isFolder));
}

async function _moveLocked(relativePath, newRelativePath, isFolder = false) {
    const oldAbsPath = Files.safePath(relativePath);
    const newAbsPath = Files.safePath(newRelativePath);
    const oldParentAbsPath = path.dirname(oldAbsPath);
    const newParentAbsPath = path.dirname(newAbsPath);

    await Files.move(relativePath, newRelativePath, isFolder);

    try {
        await db.transaction(async () => {
            if (!isFolder) {
                const newFolderId = await _getParentFolderId(newAbsPath);
                await documentRows.move(newFolderId, newRelativePath, newAbsPath, oldAbsPath);
                const moved = await documentRows.getByAbsolutePath(newAbsPath);
                if (moved?.node_id) {
                    const oldParentNodeId = await folderRows.getNodeIdByAbsPath(oldParentAbsPath);
                    const newParentFolder = await folderRows.getByAbsolutePath(newParentAbsPath);
                    if (oldParentNodeId) await nodeRows.deleteInheritance(oldParentNodeId, moved.node_id);
                    if (newParentFolder?.node_id) {
                        await nodeRows.insertInheritance(newParentFolder.node_id, moved.node_id);
                        await _seedFromParentFolder(newParentFolder, moved.node_id);
                    }
                    await _propagateTagsToFlashcards(
                        moved.id, moved.node_id, await _tagsPassedDownByDocument(moved.node_id));
                }
            } else {
                const newParentId = await _getParentFolderId(newAbsPath);
                await folderRows.move(newRelativePath, newAbsPath, oldAbsPath, newParentId);
                await documentRows.cascadeRenamePaths(relativePath, newRelativePath, oldAbsPath, newAbsPath);
                await folderRows.cascadeRenamePaths(relativePath, newRelativePath, oldAbsPath, newAbsPath);
                await mediaRows.cascadePaths(relativePath, newRelativePath, oldAbsPath, newAbsPath);
                const movedFolder = await folderRows.getByAbsolutePath(newAbsPath);
                if (movedFolder?.node_id) {
                    const oldParentNodeId = await folderRows.getNodeIdByAbsPath(oldParentAbsPath);
                    const newParentFolder = await folderRows.getByAbsolutePath(newParentAbsPath);
                    if (oldParentNodeId) await nodeRows.deleteInheritance(oldParentNodeId, movedFolder.node_id);
                    if (newParentFolder?.node_id) {
                        await nodeRows.insertInheritance(newParentFolder.node_id, movedFolder.node_id);
                        await _seedFromParentFolder(newParentFolder, movedFolder.node_id);
                    }
                    const movedMeta = Files.getMetadata(newRelativePath, true) || {};
                    await _propagateFolderTags(movedFolder.id, movedFolder.node_id, movedMeta);
                }
            }
        })();
    } catch (err) {
        await Files.move(newRelativePath, relativePath, isFolder);
        throw err;
    }
    if (isFolder) {
        const { removed, added } = await _buildMovePaths(relativePath, newRelativePath, newAbsPath);
        await sealEmitter.move(relativePath, newRelativePath, removed, added);
    } else {
        const media = await _carryMediaAfterMove(relativePath, newRelativePath);
        await sealEmitter.move(relativePath, newRelativePath,
            [relativePath, relativePath + '.flashback', ...media.removed],
            [newRelativePath, newRelativePath + '.flashback', ...media.added]
        );
    }
}

export async function updateFile(relativePath, content, metadata, { ifMatch } = {}) {
    return await withDocument(relativePath, async () => {
        const part = (content !== undefined && content !== null) ? 'body' : 'sidecar';
        _assertFresh(relativePath, ifMatch, { part });
        await _updateFileLocked(relativePath, content, metadata);
        return { etag: Files.etag(relativePath) };
    });
}

async function _updateFileLocked(relativePath, content, metadata) {
    if (metadata) _preserveCover(metadata, Files.getMetadata(relativePath));
    await Files.updateFile(relativePath, content, metadata);

    if (metadata) {
        const doc = await documentRows.getByPath(relativePath);
        if (!doc) throw new Error(`Document ${relativePath} not found in DB`);

        await db.transaction(async () => {
            if (metadata.tags) await _syncTags(doc.node_id, metadata.tags);
            if (metadata.flashcards) await _syncDocumentFlashcards(doc.id, metadata.flashcards, doc.node_id);
            if (metadata.highlights) await Highlights.syncFromSidecar(doc.id, metadata.highlights);

            const folderId = doc.folder_id;
            if (folderId) {
                const folder = await folderRows.getById(folderId);
                if (folder) {
                    const folderRelPath = path.relative(Files.workspaceRoot(), folder.absolute_path);
                    const folderMeta = Files.getMetadata(folderRelPath, true) || {};
                    await _propagateFolderTags(folder.id, folder.node_id, folderMeta);
                }
            }
        })();
    }
    await sealEmitter.edit(relativePath + '.flashback', [relativePath]);
    if (content !== undefined && content !== null) {
        await syncDocumentLinks(relativePath);
    }
}

function _extractLinks(relPath) {
    const ext = path.extname(relPath).toLowerCase();
    if (!['.md', '.txt', '.markdown'].includes(ext)) return null;
    let content;
    try {
        ({ content } = Files.readFile(relPath));
    } catch {
        return null;
    }
    const found = [];
    for (const m of (content ?? '').matchAll(_LINK_RE)) {
        found.push({ anchorText: m[1], targetHash: m[2] });
    }
    return found;
}

function _writeSidecarLinks(relPath, links) {
    if (links === null) return false;
    const sidecar = Files.getMetadata(relPath, false) ?? {};
    if (JSON.stringify(sidecar.links ?? []) === JSON.stringify(links)) return false;
    sidecar.links = links;
    Files.writeMetadata(relPath, sidecar, false);
    return true;
}

async function _writeLinkConnections(doc, links) {
    await db.transaction(async () => {
        await linkRows.deleteConnections(doc.node_id);
        await linkRows.deleteQueueBySource(doc.global_hash);
        for (const { anchorText, targetHash } of (links ?? [])) {
            const target = await documentRows.getByHash(targetHash);
            if (target) {
                await linkRows.insertConnection(doc.node_id, target.node_id);
            } else {
                await linkRows.upsertQueue(doc.global_hash, targetHash, anchorText);
            }
        }
    })();
}

export async function syncDocumentLinks(relPath) {
    const links = _extractLinks(relPath);
    if (links === null) return;
    if (_writeSidecarLinks(relPath, links)) {
        await sealEmitter.edit(relPath + '.flashback');
    }
    const doc = await documentRows.getByPath(relPath);
    if (doc) await _writeLinkConnections(doc, links);
}

export async function indexDocumentLinks(relPath) {
    const links = _extractLinks(relPath);
    if (links === null) return;
    const doc = await documentRows.getByPath(relPath);
    if (doc) await _writeLinkConnections(doc, links);
}

async function _resolvePendingLinks(globalHash, nodeId, relPath) {
    const pending = await linkRows.getPendingForTarget(globalHash);
    if (pending.length > 0) {
        await db.transaction(async () => {
            for (const row of pending) {
                const sourceDoc = await documentRows.getByHash(row.source_hash);
                if (sourceDoc) {
                    await linkRows.insertConnection(sourceDoc.node_id, nodeId);
                    await linkRows.deleteQueueBySource(row.source_hash);
                    const remaining = await linkRows.getPendingFromSource(row.source_hash);
                    for (const r of remaining) {
                        await linkRows.upsertQueue(r.source_hash, r.target_hash, r.anchor_text);
                    }
                }
            }
        })();
    }
    await indexDocumentLinks(relPath);
}

export async function remove(relativePath, isFolder = false) {
    return await withStructure(() => _deleteLocked(relativePath, isFolder));
}

async function _deleteLocked(relativePath, isFolder = false) {
    const absPath = Files.safePath(relativePath);

    const sealExtra = isFolder
        ? await _gatherFolderContents(relativePath, absPath)
        : [relativePath];

    await db.transaction(async () => {
        if (isFolder) {
            await folderRows.deleteTree(absPath, path.sep);
        } else {
            await documentRows.deleteByAbsPath(absPath);
        }
    })();

    await Files.remove(relativePath, isFolder);

    const sealSidecar = isFolder ? path.join(relativePath, '.flashback') : relativePath + '.flashback';
    await sealEmitter.delete(sealSidecar, sealExtra);
}

export async function copy(relPath, newRelPath, isFolder = false) {
    return await withStructure(() => _copyLocked(relPath, newRelPath, isFolder));
}

async function _copyLocked(relPath, newRelPath, isFolder = false) {
    const items = await Files.copy(relPath, newRelPath, isFolder);

    await db.transaction(async () => {
        for (const item of items) {
            const sidecar = Files.getMetadata(item.relativePath, item.type === 'folder');

            if (item.type === 'folder') {
                const nodeId = await nodeRows.create('Folder');
                const parentId = await _getParentFolderId(item.absolutePath);
                await folderRows.insert({
                    nodeId,
                    globalHash: item.globalHash,
                    parentId,
                    relativePath: item.relativePath,
                    absolutePath: item.absolutePath,
                    name: item.name,
                });
                if (sidecar?.tags) await _syncTags(nodeId, sidecar.tags);
            } else {
                const nodeId = await nodeRows.create('Document');
                const folderId = await _getParentFolderId(item.absolutePath);
                const info = await documentRows.insert({
                    folderId,
                    nodeId,
                    globalHash: item.globalHash,
                    relativePath: item.relativePath,
                    absolutePath: item.absolutePath,
                    name: item.name,
                });
                if (sidecar?.tags) await _syncTags(nodeId, sidecar.tags);
                if (sidecar?.flashcards) await _syncDocumentFlashcards(info.lastInsertRowid, sidecar.flashcards, nodeId);
                if (sidecar?.highlights) await Highlights.syncFromSidecar(info.lastInsertRowid, sidecar.highlights);
            }
        }
    })();

    const mediaPaths = [];
    if (!isFolder) {
        const copied = items.find(i => i.type === 'file');
        if (copied) {
            mediaPaths.push(..._replicateMedia(
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

export async function updateMetadata(relativePath, metadata, isFolder = false, { ifMatch } = {}) {
    return await withDocument(relativePath, async () => {
        _assertFresh(relativePath, ifMatch, { isFolder, part: 'sidecar' });
        await _updateMetadataLocked(relativePath, metadata, isFolder);
        return { etag: Files.etag(relativePath, isFolder) };
    });
}

function _countCardRemovals(metadata, isFolder, onDisk) {
    if (isFolder || !Array.isArray(metadata?.flashcards)) return 0;

    const before = onDisk?.flashcards;
    if (!Array.isArray(before) || before.length === 0) return 0;

    const incoming = new Set(
        metadata.flashcards.map((fc) => fc?.globalHash).filter(Boolean),
    );
    return before.filter((fc) => fc?.globalHash && !incoming.has(fc.globalHash)).length;
}

function _assertRemovalAllowed(relativePath, removals) {
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

function _preserveIdentity(metadata, onDisk) {
    if (!metadata || typeof metadata !== 'object') return;
    if (!currentAccount()) return;
    if (!onDisk) return;

    if (onDisk.globalHash) metadata.globalHash = onDisk.globalHash;

    if ('createdBy' in onDisk) metadata.createdBy = onDisk.createdBy;
    else delete metadata.createdBy;
}

function _preserveCover(metadata, onDisk) {
    if (!metadata || typeof metadata !== 'object') return;
    if (onDisk?.cover) metadata.cover = onDisk.cover;
    else delete metadata.cover;
}

export async function uploadCover(relativePath, buffer, mime) {
    const ext = COVER_TYPES[mime];
    if (!ext) throw Object.assign(new Error(`Unsupported cover type: ${mime}`), { status: 400 });
    if (buffer.length > MAX_COVER_BYTES) throw Object.assign(new Error('Cover image too large'), { status: 413 });
    return await withDocument(relativePath, async () => {
        const meta = _coverSidecar(relativePath);
        const before = cleanCover(meta.cover);
        const name = `cover-${crypto.randomBytes(6).toString('hex')}.${ext}`;
        const abs = Files.mediaPathFor(relativePath, name);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, buffer);
        const rel = path.relative(Files.workspaceRoot(), abs);
        meta.cover = { kind: 'image', file: name, y: 0.5 };
        Files.writeMetadata(relativePath, meta, false);
        const removed = await _dropCoverFile(relativePath, before);
        await db.transaction(async () => {
            const hash = crypto.createHash('sha256').update(buffer).digest('hex');
            await mediaRows.insert({ hash, name, relativePath: rel, absolutePath: abs });
        })();
        await sealEmitter.edit(relativePath + '.flashback', [rel], removed);
        return meta.cover;
    });
}

export async function setCover(relativePath, change) {
    return await withDocument(relativePath, async () => {
        const meta = _coverSidecar(relativePath);
        const before = cleanCover(meta.cover);
        let removed = [];
        if (change === null) {
            delete meta.cover;
            removed = await _dropCoverFile(relativePath, before);
        } else if (change.pattern !== undefined) {
            if (!COVER_PATTERNS.includes(change.pattern)) throw Object.assign(new Error(`Unknown cover pattern: ${change.pattern}`), { status: 400 });
            meta.cover = { kind: 'pattern', pattern: change.pattern };
            removed = await _dropCoverFile(relativePath, before);
        } else {
            if (before?.kind !== 'image') throw Object.assign(new Error(`This document's cover is not an image`), { status: 404 });
            meta.cover = { ...before, y: clampCoverY(change.y) };
        }
        Files.writeMetadata(relativePath, meta, false);
        await sealEmitter.edit(relativePath + '.flashback', [], removed);
        return cleanCover(meta.cover);
    });
}

function _coverSidecar(relativePath) {
    if (!Files.exists(relativePath) || fs.lstatSync(Files.safePath(relativePath)).isDirectory()) {
        throw Object.assign(new Error(`Document not found: ${relativePath}`), { status: 404 });
    }
    const meta = Files.getMetadata(relativePath, false);
    if (!meta) throw Object.assign(new Error(`Document not found: ${relativePath}`), { status: 404 });
    return meta;
}

async function _dropCoverFile(relativePath, cover) {
    if (cover?.kind !== 'image') return [];
    const abs = Files.mediaPathFor(relativePath, cover.file);
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
    await db.transaction(async () => { await mediaRows.deleteByAbsPath(abs); })();
    return [path.relative(Files.workspaceRoot(), abs)];
}

async function _updateMetadataLocked(relativePath, metadata, isFolder = false, { seal = true } = {}) {
    const onDisk = Files.getMetadata(relativePath, isFolder);

    const removals = _countCardRemovals(metadata, isFolder, onDisk);
    const charged = _assertRemovalAllowed(relativePath, removals);

    _preserveIdentity(metadata, onDisk);
    if (!isFolder) _preserveCover(metadata, onDisk);
    Files.writeMetadata(relativePath, metadata, isFolder);
    if (charged) cardRemovalBudget.consume(charged.id, removals);

    await db.transaction(async () => {
        const entity = isFolder ? await folderRows.getByPath(relativePath) : await documentRows.getByPath(relativePath);
        if (!entity) throw new Error(`Entity ${relativePath} not found`);

        if (isFolder) await folderRows.updateMetadata(entity.id, metadata);
        else await documentRows.updateMetadata(entity.id, metadata);

        if (metadata.tags) await _syncTags(entity.node_id, metadata.tags);
        if (!isFolder && metadata.flashcards) await _syncDocumentFlashcards(entity.id, metadata.flashcards, entity.node_id);
        if (!isFolder && metadata.highlights) await Highlights.syncFromSidecar(entity.id, metadata.highlights);

        if (!isFolder && metadata.tags !== undefined) {
            const inherited = await tagRows.getInheritedNames(entity.node_id);
            const effective = [...new Set([...inherited, ...(metadata.tags || [])])];
            await _propagateTagsToFlashcards(entity.id, entity.node_id, effective);
        }

        if (isFolder) await _propagateFolderTags(entity.id, entity.node_id, metadata);
    })();

    const sidecar = isFolder ? path.join(relativePath, '.flashback') : relativePath + '.flashback';
    if (seal) await sealEmitter.edit(sidecar);
    return sidecar;
}

export async function rewriteTag(from, to = null) {
    return await withStructure(async () => {
        const touched = [];
        const entities = [
            ...(await folderRows.getAll()).map((f) => ({ rel: f.relative_path, isFolder: true })),
            ...(await documentRows.getAll()).map((d) => ({ rel: d.relative_path, isFolder: false })),
        ];
        for (const { rel, isFolder } of entities) {
            if (rel === undefined || rel === null) continue;
            const meta = Files.getMetadata(rel, isFolder);
            if (!meta) continue;
            let changed = false;
            const tags = swapTag(meta.tags, from, to);
            if (tags) { meta.tags = tags; changed = true; }
            const excluded = swapTag(meta.excludedTags, from, to);
            if (excluded) { meta.excludedTags = excluded; changed = true; }
            if (!isFolder && Array.isArray(meta.flashcards)) {
                for (const fc of meta.flashcards) {
                    const own = swapTag(fc?.tags, from, to);
                    if (own) { fc.tags = own; changed = true; }
                }
            }
            if (!changed) continue;
            touched.push(await _updateMetadataLocked(rel, meta, isFolder, { seal: false }));
        }
        if (touched.length) await sealEmitter.edit(touched[0], touched.slice(1));
        return touched.length;
    });
}

export async function rewriteCategory(from, to = null) {
    return await withStructure(async () => {
        const touched = [];
        for (const d of await documentRows.getAll()) {
            const rel = d.relative_path;
            if (rel === undefined || rel === null) continue;
            const meta = Files.getMetadata(rel, false);
            let changed = false;
            for (const fc of meta?.flashcards ?? []) {
                if (fc?.category !== from) continue;
                if (to) fc.category = to;
                else delete fc.category;
                changed = true;
            }
            if (!changed) continue;
            touched.push(await _updateMetadataLocked(rel, meta, false, { seal: false }));
        }
        if (touched.length) await sealEmitter.edit(touched[0], touched.slice(1));
        return touched.length;
    });
}

export async function importFile(name, relativePath, content, metadata) {
    const { name: resolvedName } = await Files.createFile(relativePath, name);
    const fileRelPath = path.join(relativePath, resolvedName);
    const encoding = await Files.updateFile(fileRelPath, content, metadata);

    try {
        const absPath = Files.safePath(fileRelPath);
        const registerMeta = metadata?.globalHash
            ? metadata
            : { ...metadata, globalHash: Files.getMetadata(fileRelPath)?.globalHash };
        await _registerDocumentDerived({ name, fileRelPath, absPath, encoding, metadata: registerMeta });
    } catch (err) {
        await Files.remove(fileRelPath, false);
        throw err;
    }

    _writeSidecarLinks(fileRelPath, _extractLinks(fileRelPath));
    await sealEmitter.create(fileRelPath + '.flashback', [fileRelPath]);

    const imported = await documentRows.getByPath(fileRelPath);
    if (imported) {
        await _resolvePendingLinks(imported.global_hash, imported.node_id, fileRelPath);
    }

    return { path: fileRelPath, globalHash: Files.getMetadata(fileRelPath)?.globalHash };
}

async function _registerDocumentDerived({ name, fileRelPath, absPath, encoding, metadata }) {
    const parentAbsPath = path.dirname(absPath);
    return await db.transaction(async () => {
        const nodeId = await nodeRows.create('Document');
        const folderId = await _getParentFolderId(absPath);
        const info = await documentRows.insert({
            folderId, nodeId, globalHash: metadata.globalHash,
            relativePath: fileRelPath, absolutePath: absPath, name,
            encoding
        });
        const docId = info.lastInsertRowid;

        const parentFolder = await folderRows.getByAbsolutePath(parentAbsPath);
        if (parentFolder?.node_id) {
            await nodeRows.insertInheritance(parentFolder.node_id, nodeId);
            await _seedFromParentFolder(parentFolder, nodeId);
        }

        if (metadata.tags) await _syncTags(nodeId, metadata.tags);
        if (metadata.flashcards) await _syncDocumentFlashcards(docId, metadata.flashcards, nodeId);
        if (metadata.highlights) await Highlights.syncFromSidecar(docId, metadata.highlights);
        return docId;
    })();
}

async function _buildYoutubeDoc(url) {
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

export async function createYoutube(url, relativePath = "") {
    const { videoId, title, body, source } = await _buildYoutubeDoc(url);
    const metadata = { ...newFileMetadata(), source };
    const name = slugifyName(title || videoId) + ".youtube";
    return await importFile(name, relativePath, body, metadata);
}

export async function setYoutubeSource(relPath, url) {
    if (!await Files.exists(relPath)) throw new Error("File not found");
    const { body, source } = await _buildYoutubeDoc(url);
    const existing = Files.getMetadata(relPath) || newFileMetadata();
    await Files.updateFile(relPath, body, { ...existing, source });
    await sealEmitter.edit(relPath + '.flashback', [relPath]);
    return { path: relPath, globalHash: Files.getMetadata(relPath)?.globalHash };
}

async function _fetchYoutubeTranscript(videoId, lang) {
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

export async function fetchYoutubeTranscript(relPath, { lang } = {}) {
    if (!await Files.exists(relPath)) throw Object.assign(new Error("File not found"), { status: 404 });
    const existing = Files.getMetadata(relPath) || newFileMetadata();

    let videoId = existing.source?.videoId;
    if (!videoId) {
        try { videoId = JSON.parse(Files.readFile(relPath).content ?? '{}').videoId; } catch { }
    }
    if (!videoId) throw Object.assign(new Error("This document has no YouTube video id."), { status: 400 });

    const { cues, lang: gotLang, kind } = await _fetchYoutubeTranscript(videoId, lang);
    const merged = {
        ...existing,
        source: {
            ...existing.source,
            transcript: cues,
            transcriptMeta: { lang: gotLang, kind, fetchedAt: new Date().toISOString() },
        },
    };
    Files.writeMetadata(relPath, merged);
    await sealEmitter.edit(relPath + '.flashback');
    return { path: relPath, cues: cues.length, lang: gotLang, kind };
}

async function _cacheRemoteAsset(absSrc, { mediaFolder, maxBytes, extFor }) {
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
    const mediaAbs = Files.safePath(mediaRel);
    fs.mkdirSync(path.dirname(mediaAbs), { recursive: true });
    fs.writeFileSync(mediaAbs, buf);
    await db.transaction(async () => {
        await mediaRows.insert({ hash, name, relativePath: mediaRel, absolutePath: mediaAbs });
    })();

    return {
        localRef: `./media/${name}`,
        name,
        mediaRel,
        bytes: buf.length,
        mediaType: contentType ? contentType.split(';')[0].trim() : null,
    };
}

async function _buildClipDoc(url) {
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

export async function createClip(url, relativePath = "") {
    const { html, source, title } = await _buildClipDoc(url);
    const metadata = { ...newFileMetadata(), source };
    const name = slugifyName(title) + ".clip";
    return await importFile(name, relativePath, html, metadata);
}

export async function setClipSource(relPath, url) {
    if (!await Files.exists(relPath)) throw new Error("File not found");
    const { html, source } = await _buildClipDoc(url);
    const existing = Files.getMetadata(relPath) || newFileMetadata();
    await Files.updateFile(relPath, html, { ...existing, source });
    await sealEmitter.edit(relPath + '.flashback', [relPath]);
    return { path: relPath, globalHash: Files.getMetadata(relPath)?.globalHash };
}

export async function saveClipAsset(relPath, href) {
    if (!/\.clip$/i.test(relPath)) throw new Error("Not a web clip");
    if (!await Files.exists(relPath)) throw new Error("File not found");
    const wanted = String(href ?? '').trim();
    if (!wanted) throw new Error("No asset given");

    const { JSDOM } = await import('jsdom');
    const { content } = Files.readFile(relPath);
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
    const saved = await _cacheRemoteAsset(src, {
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

    const existing = Files.getMetadata(relPath) || newFileMetadata();
    await Files.updateFile(relPath, cdoc.body.innerHTML, existing);
    await sealEmitter.edit(relPath + '.flashback', [relPath, saved.mediaRel]);

    return {
        path: relPath, href: saved.localRef, name: saved.name, kind,
        bytes: saved.bytes, mediaType: saved.mediaType, alreadySaved: false,
    };
}

export async function indexDocument(relPath) {
    if (await documentRows.getByPath(relPath)) return await reindexDocument(relPath);

    const metadata = Files.getMetadata(relPath, false);
    if (!metadata?.globalHash) throw new Error(`No valid sidecar for ${relPath}`);

    const absPath = Files.safePath(relPath);
    const parentDir = path.dirname(relPath);
    await _ensureFolderPath(parentDir === '.' ? '' : parentDir);
    const docId = await _registerDocumentDerived({
        name: path.basename(relPath),
        fileRelPath: relPath,
        absPath,
        encoding: metadata.encoding ?? null,
        metadata,
    });
    await _resolvePendingLinks(metadata.globalHash, (await documentRows.getByPath(relPath)).node_id, relPath);
    return docId;
}

export async function reindexDocument(relPath) {
    const doc = await documentRows.getByPath(relPath);
    if (!doc) return await indexDocument(relPath);

    const metadata = Files.getMetadata(relPath, false);
    if (!metadata) throw new Error(`No readable sidecar for ${relPath}`);

    await db.transaction(async () => {
        if (metadata.globalHash && metadata.globalHash !== doc.global_hash) {
            await documentRows.updateMetadata(doc.id, { globalHash: metadata.globalHash });
        }
        await _syncTags(doc.node_id, metadata.tags ?? []);
        await _syncDocumentFlashcards(doc.id, metadata.flashcards ?? [], doc.node_id);
        await highlightRows.syncDocument(doc.id, metadata.highlights ?? []);

        if (doc.folder_id) {
            const folder = await folderRows.getById(doc.folder_id);
            if (folder) {
                const folderRelPath = path.relative(Files.workspaceRoot(), folder.absolute_path);
                const folderMeta = Files.getMetadata(folderRelPath, true) || {};
                await _propagateFolderTags(folder.id, folder.node_id, folderMeta);
            }
        }
    })();

    await indexDocumentLinks(relPath);
    return doc.id;
}

export async function indexFolder(relPath) {
    const folderId = await _ensureFolderPath(relPath);
    const folder = await folderRows.getById(folderId);
    const metadata = Files.getMetadata(relPath, true) || {};

    await db.transaction(async () => {
        if (metadata.globalHash && metadata.globalHash !== folder.global_hash) {
            await folderRows.updateMetadata(folder.id, { globalHash: metadata.globalHash });
        }
        if (folder.node_id) await _syncTags(folder.node_id, metadata.tags ?? []);
        await _propagateFolderTags(folder.id, folder.node_id, metadata);
    })();
    return folderId;
}

export async function removeFromIndex(relPath, isFolder = false) {
    const absPath = Files.safePath(relPath);
    await db.transaction(async () => {
        if (isFolder) {
            await folderRows.deleteTree(absPath, path.sep);
        } else {
            await documentRows.deleteByAbsPath(absPath);
        }
    })();
}

export async function importPackage(externalPath, targetRelPath = "") {
    const folderName = path.basename(externalPath);
    const folderRelPath = path.join(targetRelPath, folderName);
    
    const nodeId = await nodeRows.create('Folder');
    const absPath = Files.safePath(folderRelPath);
    const globalHash = crypto.randomUUID();
    const parentId = await _getParentFolderId(absPath);

    if (!fs.existsSync(absPath)) fs.mkdirSync(absPath, { recursive: true });

    await folderRows.insert({
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
            await updateMetadata(folderRelPath, meta, true);
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
                    const mediaDestAbs = Files.safePath(entryRel);
                    if (!fs.existsSync(mediaDestAbs)) fs.mkdirSync(mediaDestAbs, { recursive: true });
                    for (const mFile of fs.readdirSync(srcPath)) {
                        const mSrc = path.join(srcPath, mFile);
                        const mDest = path.join(mediaDestAbs, mFile);
                        
                        if (fs.lstatSync(mSrc).isFile()) {
                            fs.copyFileSync(mSrc, mDest);
                            const mBuf = fs.readFileSync(mDest);
                            const mHash = crypto.createHash('sha256').update(mBuf).digest('hex');
                            await mediaRows.insert({
                                hash: mHash, name: mFile, relativePath: path.join(entryRel, mFile), absolutePath: mDest
                            });
                        }
                    }
                } else {
                    const subNodeId = await nodeRows.create('Folder');
                    const subAbs = Files.safePath(entryRel);
                    if (!fs.existsSync(subAbs)) fs.mkdirSync(subAbs, { recursive: true });
                    const subParentId = await _getParentFolderId(subAbs);
                    await folderRows.insert({
                        nodeId: subNodeId, globalHash: crypto.randomUUID(), parentId: subParentId, relativePath: entryRel, absolutePath: subAbs, name: entry.name
                    });

                    const metaFile = path.join(srcPath, ".flashback");
                    let meta = { globalHash: crypto.randomUUID() };
                    if (fs.existsSync(metaFile)) {
                        meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
                        delete meta.lastRecall; delete meta.level; delete meta.easeFactor; meta.presence = 0;
                        meta.globalHash = crypto.randomUUID();
                    }
                    await updateMetadata(entryRel, meta, true);
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
                await importFile(entry.name, destRel, content, meta);
            }
        }
    };
    await crawl(externalPath, folderRelPath);
}

export async function processZipPackage(zipFilePath, targetRelPath = "") {
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
        await importPackage(pkgPath, targetRelPath);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

export function exportPackage(relativePath) {
    const sourcePath = Files.safePath(relativePath);
    const zip = new AdmZip();
    zip.addLocalFolder(sourcePath, path.basename(sourcePath));
    const zipPath = path.join(os.tmpdir(), `${path.basename(sourcePath)}_${Date.now()}.zip`);
    zip.writeZip(zipPath);
    return zipPath;
}

export async function createFlashcard(relativePath, cardData, mediaItems = []) {
    return await withDocument(relativePath, () =>
        _createFlashcardLocked(relativePath, cardData, mediaItems));
}

async function _createFlashcardLocked(relativePath, cardData, mediaItems = []) {
    const doc = await documentRows.getByPath(relativePath);
    if (!doc) throw new Error(`Document ${relativePath} not found in DB`);

    if (cardData.category && !await categoryRows.getByName(cardData.category)) {
        throw new Error(`Unknown category: "${cardData.category}". Call GET /api/categories for valid values.`);
    }

    const meta = Files.getMetadata(relativePath) || {};
    if (!Array.isArray(meta.flashcards)) meta.flashcards = [];
    const card = { ...cardData };
    delete card.globalHash;
    if (card.origin !== 'ai') delete card.origin;
    meta.flashcards.push(card);
    const cardIndex = meta.flashcards.length - 1;
    Files.writeMetadata(relativePath, meta, false);

    const mediaRels = [];
    const registered = [];
    for (const m of mediaItems) {
        const ext = path.extname(m.originalName || '');
        const base = path.basename(m.originalName || 'media', ext).replace(/[^\w.-]+/g, '_') || 'media';
        const name = `${base}-${crypto.randomUUID().slice(0, 8)}${ext}`;

        Files.addVanillaData(relativePath, m.buffer, name, m.type, m.position, cardIndex);

        const mediaRel = path.join(path.dirname(relativePath), 'media', name);
        mediaRels.push(mediaRel);
        registered.push({ name, mediaRel, hash: crypto.createHash('sha256').update(m.buffer).digest('hex') });
    }

    const finalMeta = Files.getMetadata(relativePath);
    const savedCard = finalMeta.flashcards[cardIndex];
    await db.transaction(async () => {
        if (finalMeta.tags) await _syncTags(doc.node_id, finalMeta.tags);
        await _syncDocumentFlashcards(doc.id, finalMeta.flashcards, doc.node_id);
        for (const r of registered) {
            await mediaRows.insert({
                hash: r.hash, name: r.name,
                relativePath: r.mediaRel, absolutePath: Files.safePath(r.mediaRel),
            });
        }
    })();

    await sealEmitter.edit(relativePath + '.flashback', mediaRels);
    return savedCard;
}

export async function updateFlashcard(relativePath, flashcardHash, patch = {}, { ifMatch } = {}) {
    return await withDocument(relativePath, () =>
        _updateFlashcardLocked(relativePath, flashcardHash, patch, ifMatch));
}

async function _updateFlashcardLocked(relativePath, flashcardHash, patch = {}, ifMatch = undefined) {
    const doc = await documentRows.getByPath(relativePath);
    if (!doc) throw new Error(`Document ${relativePath} not found in DB`);

    if (patch.category && !await categoryRows.getByName(patch.category)) {
        throw new Error(`Unknown category: "${patch.category}". Call GET /api/categories for valid values.`);
    }

    const meta = Files.getMetadata(relativePath) || {};
    const cards = Array.isArray(meta.flashcards) ? meta.flashcards : [];
    const idx = cards.findIndex(f => f.globalHash === flashcardHash);
    if (idx === -1) throw new Error(`Flashcard ${flashcardHash} not found in ${relativePath}`);

    const ex = cards[idx];
    _assertEntityFresh(ex, ifMatch);
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
    Files.writeMetadata(relativePath, meta, false);

    await db.transaction(async () => {
        await _syncDocumentFlashcards(doc.id, meta.flashcards, doc.node_id);
    })();

    await sealEmitter.edit(relativePath + '.flashback');
    return updated;
}

export async function deleteFlashcard(relativePath, flashcardHash) {
    return await withDocument(relativePath, () =>
        _deleteFlashcardLocked(relativePath, flashcardHash));
}

async function _deleteFlashcardLocked(relativePath, flashcardHash) {
    const doc = await documentRows.getByPath(relativePath);
    if (!doc) throw new Error(`Document ${relativePath} not found in DB`);

    const meta = Files.getMetadata(relativePath) || {};
    const cards = Array.isArray(meta.flashcards) ? meta.flashcards : [];
    if (!cards.some(f => f.globalHash === flashcardHash)) {
        throw new Error(`Flashcard ${flashcardHash} not found in ${relativePath}`);
    }

    meta.flashcards = cards.filter(f => f.globalHash !== flashcardHash);
    Files.writeMetadata(relativePath, meta, false);

    await db.transaction(async () => {
        await _syncDocumentFlashcards(doc.id, meta.flashcards, doc.node_id);
        await cardProgressRows.purgeCardBehaviour(flashcardHash);
    })();

    await sealEmitter.edit(relativePath + '.flashback');
}

export async function addMediaToFlashcard(relativePath, flashcardHash, mediaBuffer, mediaName) {
    return await withDocument(relativePath, () =>
        _addMediaToFlashcardLocked(relativePath, flashcardHash, mediaBuffer, mediaName));
}

async function _addMediaToFlashcardLocked(relativePath, flashcardHash, mediaBuffer, mediaName) {
    const meta = Files.getMetadata(relativePath);
    const cardIdx = meta.flashcards.findIndex(f => f.globalHash === flashcardHash);
    if (cardIdx === -1) throw new Error(`Flashcard ${flashcardHash} not found`);

    Files.addCustomMedia(relativePath, mediaBuffer, mediaName, cardIdx);

    const mediaRel = path.join(path.dirname(relativePath), "media", mediaName);
    const mediaAbs = Files.safePath(mediaRel);
    const hash = crypto.createHash('sha256').update(mediaBuffer).digest('hex');

    await db.transaction(async () => {
        await mediaRows.insert({ hash, name: mediaName, relativePath: mediaRel, absolutePath: mediaAbs });
    })();
    await sealEmitter.edit(relativePath + '.flashback', [mediaRel]);
}

export async function submitReview(relativePath, flashcardHash, outcome, easeFactor, newLevel, algorithm = 'leitner', opts = {}) {
    const { documentId, scope, interval } = await Srs.submitReview(
        flashcardHash, outcome, easeFactor, newLevel, algorithm, opts,
    );

    if (isOwnerScope(scope)) await propagatePresence(documentId);
    return { interval };
}

export async function undoReview(relativePath, flashcardHash, algorithm = 'leitner') {
    const { document_id, restored, scope } = await Srs.undoReview(flashcardHash, algorithm);

    if (!isOwnerScope(scope)) return restored;

    if (document_id) await propagatePresence(document_id);
    return restored;
}

async function _ensureFolderPath(relativePath) {
    let root = await folderRows.getByPath("");
    let parentId;
    let parentAbs = Files.workspaceRoot();
    if (root) {
        parentId = root.id;
    } else {
        const nodeId = await nodeRows.create('Folder');
        const info = await folderRows.insert({
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
        let folder = await folderRows.getByPath(builtRel);
        if (!folder) {
            const globalHash = Files.ensureFolderMetadata(priorRel, seg);
            const absPath = Files.safePath(builtRel);
            const nodeId = await nodeRows.create('Folder');
            const info = await folderRows.insert({
                nodeId, globalHash, parentId, relativePath: builtRel, absolutePath: absPath, name: seg,
            });
            const parentFolder = await folderRows.getByAbsolutePath(parentAbs);
            if (parentFolder?.node_id) {
                await nodeRows.insertInheritance(parentFolder.node_id, nodeId);
                await _seedFromParentFolder(parentFolder, nodeId);
            }
            folder = { id: info.lastInsertRowid };
        }
        parentId = folder.id;
        parentAbs = Files.safePath(builtRel);
    }
    return parentId;
}

async function _getParentFolderId(absolutePath) {
    const parentDir = path.dirname(absolutePath);
    if (parentDir === Files.workspaceRoot()) {
        const root = await folderRows.getByPath("");
        if (root) return root.id;

        const nodeId = await nodeRows.create('Folder');
        const info = await folderRows.insert({
            nodeId, globalHash: crypto.randomUUID(), parentId: null,
            relativePath: "", absolutePath: parentDir, name: path.basename(parentDir)
        });
        return info.lastInsertRowid;
    }
    const folder = await folderRows.getByAbsolutePath(parentDir);
    return folder ? folder.id : null;
}

async function _syncTags(nodeId, tagNames) {
    const tagNodeIds = [];
    for (const name of tagNames) {
        let tag = await tagRows.getByName(name);
        if (!tag) {
            const tNodeId = await nodeRows.create('Tag');
            await tagRows.insert(name, tNodeId);
            tagNodeIds.push(tNodeId);
        } else {
            tagNodeIds.push(tag.node_id);
        }
    }
    await tagRows.syncNode(nodeId, tagNodeIds);
}

async function _syncDocumentFlashcards(documentId, flashcardsData, docNodeId = null) {
    const existing = await flashcardRows.getByDocument(documentId, OWNER_SCOPE);
    const existingMap = new Map(existing.map(f => [f.global_hash, f]));
    const incomingHashes = new Set();

    for (const [index, fcData] of flashcardsData.entries()) {
        incomingHashes.add(fcData.globalHash);
        const match = existingMap.get(fcData.globalHash);

        if (match) {
            const payload = { ...fcData };
            if (match.hasProgress) {
                for (const key of PROGRESS_KEYS) delete payload[key];
            }

            await flashcardRows.update(match.id, {
                ...payload,
                fileIndex: index,
                contentId: match.content_id
            }, OWNER_SCOPE);

            if (!match.hasProgress && fcData.easeFactor != null) {
                await cardProgressRows.seedEaseFromSidecar(
                    fcData.globalHash, fcData.easeFactor, fcData.level ?? 0,
                );
            }
            if (Array.isArray(fcData.tags)) await _syncTags(match.node_id, fcData.tags);
        } else {
            const nodeId = await nodeRows.create('Flashcard');
            const payload = { ...fcData };
            const seeding = !await cardProgressRows.hasForHash(fcData.globalHash, OWNER_SCOPE);
            if (!seeding) {
                for (const key of PROGRESS_KEYS) delete payload[key];
            }

            await flashcardRows.insert({
                ...payload, nodeId, documentId, fileIndex: index
            }, OWNER_SCOPE);

            if (seeding && fcData.easeFactor != null) {
                await cardProgressRows.seedEaseFromSidecar(
                    fcData.globalHash, fcData.easeFactor, fcData.level ?? 0,
                );
            }
            if (Array.isArray(fcData.tags)) await _syncTags(nodeId, fcData.tags);
        }
    }

    for (const [hash, fc] of existingMap) {
        if (!incomingHashes.has(hash)) await flashcardRows.remove(fc.id);
    }

    if (docNodeId) {
        await _propagateTagsToFlashcards(documentId, docNodeId, await _tagsPassedDownByDocument(docNodeId));
    }
}

async function _tagsPassedDownByFolder(folderNodeId, folderRelPath) {
    const meta = Files.getMetadata(folderRelPath, true) || {};
    const excluded = new Set(meta.excludedTags || []);
    const inherited = (await tagRows.getInheritedNames(folderNodeId)).filter(t => !excluded.has(t));
    const direct = await tagRows.getDirectNames(folderNodeId);
    return [...new Set([...inherited, ...direct])];
}

async function _seedInheritedTags(parentNodeId, childNodeId, tagNames) {
    if (!parentNodeId || !childNodeId) return;
    const hierarchyType = await nodeRows.getHierarchyTypeId();
    const conn = await nodeRows.getOrCreateConnection(parentNodeId, childNodeId, hierarchyType.id);
    await tagRows.clearInherited(conn.id);
    for (const tagName of tagNames) {
        const tag = await tagRows.getByName(tagName);
        if (tag) await tagRows.insertInherited(conn.id, tag.id);
    }
}

async function _seedFromParentFolder(parentFolder, childNodeId) {
    if (!parentFolder?.node_id) return;
    await _seedInheritedTags(
        parentFolder.node_id,
        childNodeId,
        await _tagsPassedDownByFolder(parentFolder.node_id, parentFolder.relative_path),
    );
}

async function _tagsPassedDownByDocument(docNodeId) {
    const inherited = await tagRows.getInheritedNames(docNodeId);
    const direct = await tagRows.getDirectNames(docNodeId);
    return [...new Set([...inherited, ...direct])];
}

async function _propagateFolderTags(folderId, parentNodeId, metadata) {
    const childDocs = await documentRows.getInFolder(folderId);
    const childFolders = await folderRows.getChildren(folderId);

    const inheritedFromAbove = await tagRows.getInheritedNames(parentNodeId);
    const myDirectTags = new Set(metadata.tags || []);
    const myExclusions = new Set(metadata.excludedTags || []);
    const effectiveInherited = inheritedFromAbove.filter(t => !myExclusions.has(t));
    const effectiveToChildren = [...new Set([...effectiveInherited, ...myDirectTags])];

    const hierarchyType = await nodeRows.getHierarchyTypeId();

    const syncInheritance = async (targetNodeId) => {
        const conn = await nodeRows.getOrCreateConnection(parentNodeId, targetNodeId, hierarchyType.id);
        await tagRows.clearInherited(conn.id);
        for (const tagName of effectiveToChildren) {
            const tag = await tagRows.getByName(tagName);
            if (tag) await tagRows.insertInherited(conn.id, tag.id);
        }
    };

    for (const doc of childDocs) {
        await syncInheritance(doc.node_id);
        await _propagateTagsToFlashcards(doc.id, doc.node_id, await _tagsPassedDownByDocument(doc.node_id));
    }

    for (const folder of childFolders) {
        await syncInheritance(folder.node_id);
        const subMeta = Files.getMetadata(folder.relative_path, true) || {};
        await _propagateFolderTags(folder.id, folder.node_id, subMeta);
    }
}

async function _propagateTagsToFlashcards(docId, docNodeId, tags) {
    const hierarchyType = await nodeRows.getHierarchyTypeId();
    for (const fc of await flashcardRows.getNodeIds(docId)) {
        const conn = await nodeRows.getOrCreateConnection(docNodeId, fc.node_id, hierarchyType.id);
        await tagRows.clearInherited(conn.id);
        for (const tagName of tags) {
            const tag = await tagRows.getByName(tagName);
            if (tag) await tagRows.insertInherited(conn.id, tag.id);
        }
    }
}

function _mediaNamesReferencedBy(relDocPath) {
    const names = new Set();
    const addRefsIn = (text) => {
        if (!text) return;
        for (const m of String(text).matchAll(_MEDIA_REF)) {
            names.add(path.basename(m[1]));
        }
    };

    const meta = Files.getMetadata(relDocPath);
    for (const card of meta?.flashcards ?? []) {
        for (const ref of Object.values(card?.vanillaData?.media ?? {})) {
            if (ref && !_IS_HASH.test(String(ref))) {
                names.add(path.basename(String(ref).replace(/\\/g, '/')));
            }
        }
        addRefsIn(card?.customData?.html);
    }

    try { addRefsIn(Files.readFile(relDocPath).content); } catch { }

    return names;
}

async function _mediaNamesStillNeededIn(folderRel, excludeRelDocPath) {
    const folderAbs = Files.safePath(folderRel);
    const needed = new Set();
    for (const doc of await documentRows.getByAbsPathPrefix(folderAbs + path.sep)) {
        if (doc.relative_path === excludeRelDocPath) continue;
        if (path.dirname(doc.relative_path) !== folderRel) continue;
        for (const name of _mediaNamesReferencedBy(doc.relative_path)) needed.add(name);
    }
    return needed;
}

function _replicateMedia(relDocPath, oldFolder, newFolder) {
    const added = [], carried = [];
    if (oldFolder === newFolder) return { added, carried };

    for (const name of _mediaNamesReferencedBy(relDocPath)) {
        const srcAbs = Files.safePath(path.join(oldFolder, 'media', name));
        if (!fs.existsSync(srcAbs)) continue;

        const destRel = path.join(newFolder, 'media', name);
        const destAbs = Files.safePath(destRel);
        fs.mkdirSync(path.dirname(destAbs), { recursive: true });
        if (!fs.existsSync(destAbs)) fs.copyFileSync(srcAbs, destAbs);
        added.push(destRel);
        carried.push(name);
    }
    return { added, carried };
}

async function _carryMediaAfterMove(oldRelDocPath, newRelDocPath) {
    const oldFolder = path.dirname(oldRelDocPath);
    const newFolder = path.dirname(newRelDocPath);
    if (oldFolder === newFolder) return { added: [], removed: [] };

    const { added, carried } = _replicateMedia(newRelDocPath, oldFolder, newFolder);
    if (carried.length === 0) return { added, removed: [] };

    const stillNeeded = await _mediaNamesStillNeededIn(oldFolder, newRelDocPath);
    const removed = [];

    for (const name of carried) {
        if (stillNeeded.has(name)) {
            continue;
        }
        const srcRel = path.join(oldFolder, 'media', name);
        const srcAbs = Files.safePath(srcRel);
        const destRel = path.join(newFolder, 'media', name);
        fs.rmSync(srcAbs, { force: true });
        removed.push(srcRel);
        await mediaRows.updatePath(srcAbs, destRel, Files.safePath(destRel));
    }

    const srcMediaAbs = Files.safePath(path.join(oldFolder, 'media'));
    try {
        if (fs.existsSync(srcMediaAbs) && fs.readdirSync(srcMediaAbs).length === 0) {
            fs.rmdirSync(srcMediaAbs);
        }
    } catch { }

    return { added, removed };
}

async function _buildMovePaths(oldRelPath, newRelPath, newAbsPath) {
    const prefix = newAbsPath + path.sep;
    const docs = await documentRows.getByAbsPathPrefix(prefix);
    const folders = await folderRows.getByAbsPathPrefix(prefix, newAbsPath);

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

async function _gatherFolderContents(folderRelPath, folderAbsPath) {
    const prefix = folderAbsPath + path.sep;
    const docs = await documentRows.getByAbsPathPrefix(prefix);
    const folders = await folderRows.getByAbsPathPrefix(prefix, folderAbsPath);

    const paths = [];
    for (const doc of docs) {
        paths.push(doc.relative_path, doc.relative_path + '.flashback');
    }
    for (const folder of folders) {
        paths.push(path.join(folder.relative_path, '.flashback'));
    }
    return paths;
}

export async function propagatePresence(documentId) {
    await db.transaction(async () => {
        const stats = await statisticsRows.getAvgLevel(documentId, OWNER_SCOPE);
        await documentRows.updatePresence(documentId, stats.score || 0);

        let currentFolderId = (await documentRows.getFolderIdById(documentId))?.folder_id;
        while (currentFolderId) {
            const docStats = await documentRows.getPresenceStats(currentFolderId);
            const childFolders = await folderRows.getChildPresences(currentFolderId);

            const totalCount = (docStats.cnt || 0) + childFolders.length;
            const totalPresence = (docStats.total || 0) + childFolders.reduce((acc, f) => acc + (f.presence || 0), 0);
            const avg = totalCount > 0 ? (totalPresence / totalCount) : 0;

            await folderRows.updatePresence(currentFolderId, avg);

            currentFolderId = (await folderRows.getParentId(currentFolderId))?.parent_id ?? null;
        }
    })();
}

export async function search(q) { return await searchRows.search(q); }

export async function searchContent(q, limit = 20) {
    const needle = String(q ?? '').toLowerCase();
    if (!needle) return [];
    const results = [];
    for (const doc of await documentRows.getAll()) {
        if (results.length >= limit) break;
        const ext = path.extname(doc.relative_path).toLowerCase();
        if (!['.md', '.txt', '.markdown'].includes(ext)) continue;
        let content;
        try { ({ content } = Files.readFile(doc.relative_path)); } catch { continue; }
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

export async function getLinks(relPath) {
    const doc = await documentRows.getByPath(relPath);
    if (!doc) throw new Error(`Document ${relPath} not found`);
    const { outgoing, backlinks } = await linkRows.getEdges(doc.node_id);
    const pending = (await linkRows.getPendingFromSource(doc.global_hash))
        .map((l) => ({ targetHash: l.target_hash, anchorText: l.anchor_text }));
    return { outgoing, backlinks, pending };
}

export async function getGraphData(scope) {
    const { nodes, edges } = await graphRows.getData(scope ?? currentScope());
    return { nodes: nodes.map(graphNodeLearning), edges };
}

export async function exists(rel, derived, isFolder) {
    if (derived) return isFolder ? await folderRows.getByPath(rel) : await documentRows.getByPath(rel);
    return await Files.exists(rel);
}

export { EDITABLE_BODY_EXTENSIONS } from '../resources/files.js';

export async function superSearch(params) {
    return await searchRows.superSearch(params, currentScope());
}

export function readEntry(relPath) {
    const { content, encoding, binary, size } = Files.readFile(relPath);
    return { content, encoding, binary, size, metadata: Files.getMetadata(relPath), etag: Files.etag(relPath) };
}

export function absolutePath(relPath) {
    return Files.safePath(relPath);
}

export function readSidecar(relPath, isFolder) {
    const sidecar = Files.getMetadata(relPath, isFolder);
    return sidecar ? { sidecar, etag: Files.etag(relPath, isFolder) } : null;
}

export function entityEtag(entity) {
    return Files.entityEtag(entity);
}

export async function getByHash(hash) {
    return await documentRows.getByHash(hash);
}

export async function listTags() {
    return await tagRows.getAll();
}

export async function tagOverview() {
    return await tagRows.getOverview();
}

export async function tagUsage() {
    return await tagRows.getWithCounts();
}

export async function entityTags(relPath, isFolder) {
    const entity = isFolder ? await folderRows.getByPath(relPath) : await documentRows.getByPath(relPath);
    if (!entity) return null;
    const sidecar = Files.getMetadata(relPath, isFolder) || {};
    return {
        direct: await tagRows.getDirectNames(entity.node_id),
        inherited: await tagRows.getInheritedNames(entity.node_id),
        excluded: sidecar.excludedTags || [],
    };
}
