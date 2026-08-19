/**
 * Documents.js
 * The Orchestrator. Coordinates File System, Database, and specialized services.
 */

import path from 'path';
import fs from 'fs';
import Files from '../resources/files.js';
import { withDocument, withStructure } from '../resources/pathLock.js';
import query from '../resources/query.js';
import srsService from './srs.js';
import db from '../primitives/database.js';
import crypto from 'crypto';
import os from 'os';
import AdmZip from 'adm-zip';
import { sealEmitter } from '../../seal/seal.js';
import highlightsService from './highlights.js';
import newFileMetadata from '../../config/defaults/FlashbackFile.js';
import { OWNER_SCOPE, currentScope, isOwnerScope } from '../../requestContext.js';

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

// Best-effort audio extension from an HTTP content-type header. Separate from the
// image map because the two loops must never accept each other's formats: an <audio>
// pointing at a PNG is a broken page, not a sound to cache.
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

// Best-effort image extension from a URL path.
function extFromUrl(u) {
    try {
        const m = new URL(u).pathname.match(/\.([a-z0-9]{1,5})$/i);
        return m ? m[1].toLowerCase() : null;
    } catch { return null; }
}

// Whitelist for stored clip HTML — readable structure only, no scripts/handlers.
// A fresh clip's media src are the absolute URLs Readability resolved, and they
// survive here because they are how the clip displays at all; relative `./media/`
// src survive too (verified), which is what an asset saved to the vault becomes.
//
// `audio`/`source` are here for the same reason `img` is: Readability preserves
// them and rewrites their src to absolute URLs, so a page's sound reaches us
// intact and would be thrown away here otherwise. `controls` is allowed because a
// clipped sound with no way to play it is not worth storing; no other media
// attribute is — `autoplay` especially, which would make opening a clip noisy.
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

// Clipping downloads the page and nothing else. A page's pictures and sound stay
// where they are and load from their own host as the clip is read — which is what
// a browser does anyway, one unremarkable request at a time. Mirroring all of them
// up front was both slow and the exact traffic pattern asset hosts throttle:
// Wikimedia's limiter lets three or four rapid requests through and answers the
// rest with 429, so the clipper spent a minute and a half arguing with it over
// files nobody had asked for. An asset is downloaded when the user puts it on a
// card — see saveClipAsset.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** The file name an asset's src is known by — the last path segment, no query or fragment. */
function assetName(src) {
    const bare = src.split('?')[0].split('#')[0].split('/').pop() || src;
    try { return decodeURIComponent(bare); } catch { return bare; }
}

// Whether a link points at a sound a browser can play. Most of the web publishes
// sound as a link rather than an <audio> — every Wikipedia player is
// `<a href="…mp3" title="Play audio">Play</a>` — so a clip's sounds are frequently
// all links and nothing else. MIDI is excluded (no browser plays it, and on Wikipedia
// a `.mid` URL is the file's description page), as is any last segment with a colon
// in it, which is what `File:Something.ogg` looks like: a page about a sound.
// Mirrors mcpReader.isSoundLink, which lists the same assets for reading.
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

/**
 * Every element in a clip body that carries an asset: pictures and players by `src`,
 * plus links that point at a playable sound — the form most of the web's audio takes.
 * An ordinary link is not an asset and never appears here, which is what keeps the
 * lookup below from turning "save this" into "download any page".
 */
function clipAssetNodes(cdoc) {
    return Array.from(cdoc.querySelectorAll('img[src], audio[src], source[src], a[href]'))
        .filter((n) => n.tagName.toUpperCase() !== 'A'
            || isSoundLink(n.getAttribute('href'))
            || isSoundLink(n.getAttribute('data-src')));
}

/**
 * The element in a clip body that `wanted` names, by the same addressing rules
 * /api/reader/media-file uses: the exact src, the src without its `./` prefix, or
 * the asset's bare file name. Matching them here rather than only accepting an exact
 * src is not a nicety — the MCP tools document a bare file name as a valid address,
 * and a caller who reads a clip's media list should be able to save from it with
 * what that list gave them.
 *
 * An ambiguous name is an error rather than a guess, and an address that names
 * nothing is refused: this lookup is what stops the endpoint behind it from
 * downloading arbitrary URLs into the vault.
 */
function resolveClipAsset(cdoc, wanted) {
    const nodes = clipAssetNodes(cdoc);
    const bare = wanted.replace(/^\.?\//, '');
    const matches = (value) => value && (value === wanted || value.replace(/^\.?\//, '') === bare);
    // `data-src` is the address a saved asset used to load from, kept when its src was
    // rewritten. It is what lets a caller still holding the web address — an open
    // reader that has not reloaded, a media list read a minute ago — ask again and be
    // told "already saved" instead of "not part of this clip".
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
// Sound is capped far tighter than pictures, and deliberately: the clip-worthy
// cases are short — a pronunciation button, a language sample, a bird call, a
// heart sound. A podcast episode is a 60-minute file that no flashcard wants, so
// it is left playing from its own server rather than copied into the vault.
const MAX_AUDIO_BYTES = 15 * 1024 * 1024;

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

/**
 * Rolls each graph node's raw learning columns up into the two scalars the graph
 * draws with, and drops the intermediate sums from the payload.
 *
 * These are deliberately separate channels, because one cannot substitute for
 * the other:
 *
 *   `mass`    — how much knowledge the node stands for, in mastered-card-
 *               equivalents. Unbounded. Drives halo *size*.
 *   `learned` — how well that knowledge is held, 0..1. A mean, so it is scale-
 *               free by construction. Drives halo *opacity*.
 *
 * A node holding two perfect cards and a node holding eighty cards at half
 * strength both used to be described by `learned` alone, which made the smaller
 * one look like the stronger knowledge area (mass 2 vs mass 40). `mass` is what
 * tells them apart.
 *
 * `cardCount` rides along because it is the only thing that separates "this node
 * has no cards" from "this node's cards are all brand new" — both score 0.
 *
 * Tags and Decks are left at zero here and filled in client-side: their members
 * are already-summed Documents and Flashcards, so aggregating them needs the
 * edge list rather than another join. See `aggregateMass` in ui/views/graphMetrics.js.
 */
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
        // Card-weighted, not Folders.presence. presence is an unweighted recursive
        // average of document presences, so a single perfect two-card document
        // lifts a folder exactly as hard as a hundred-card one — the same
        // scale-free error this whole split exists to correct, one level up.
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
     * Refuses a write whose caller was working from a version of the document that is no
     * longer the one on disk. Call it INSIDE the lock — outside one it is a race with a
     * wider window rather than a check.
     *
     * An absent `ifMatch` means "no check", and that is deliberate rather than an oversight:
     * the MCP server, the test suite, `scripts/seed.js` and every script written before this
     * existed send no version, and the single-writer desktop case they serve has no conflict
     * to detect. The renderer always sends one. A server build makes it mandatory, because
     * that is the first configuration where a second writer exists.
     *
     * Only the half of the etag the write REPLACES is compared (see Files.etag for the
     * `"<body>.<sidecar>"` shape). A write carrying `content` is replacing the body, and its
     * sidecar — if it sends one — was merged from a fresh read moments earlier, so comparing
     * the sidecar half there would refuse a save because of a change the writer had already
     * incorporated. A metadata-only write is the mirror image: it replaces the sidecar and
     * never looks at the body.
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
     * The etag of one card as it stands in its document's sidecar — what a client sends back
     * as `ifMatch` when it patches that card.
     *
     * Read from the sidecar rather than from the derived row on purpose: the sidecar is what
     * the patch will be applied to, and a version taken from anywhere else could agree with
     * the caller while the file it is about to overwrite has moved on.
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
     * The patch counterpart of `_assertFresh`: refuses a patch to an entity somebody else has
     * changed since the caller read it, while leaving patches to its neighbours alone.
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

    // --- Listing ---

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

    // --- Core Operations ---

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

    // Structural: it changes which paths exist, so it takes the tree exclusively. An edit
    // already in flight anywhere finishes first, and one queued behind it waits — otherwise a
    // writer holds a path that this operation is in the middle of invalidating, and the index
    // ends up describing a tree that is not on disk.
    //
    // Creation (createFile/createFolder/importPackage) deliberately does NOT take this lock:
    // it only ADDS paths, so it invalidates nothing anyone is holding — and importPackage
    // calls updateMetadata internally, which would deadlock against a lock it already held.
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

    // Structural: it changes which paths exist, so it takes the tree exclusively. An edit
    // already in flight anywhere finishes first, and one queued behind it waits — otherwise a
    // writer holds a path that this operation is in the middle of invalidating, and the index
    // ends up describing a tree that is not on disk.
    //
    // Creation (createFile/createFolder/importPackage) deliberately does NOT take this lock:
    // it only ADDS paths, so it invalidates nothing anyone is holding — and importPackage
    // calls updateMetadata internally, which would deadlock against a lock it already held.
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
                        // The document's cards inherit through it, so they follow the move too.
                        await this._propagateTagsToFlashcards(
                            moved.id, moved.node_id, await this._tagsPassedDownByDocument(moved.node_id));
                    }
                } else {
                    const newParentId = await this._getParentFolderId(newAbsPath);
                    await this.query.moveFolderRecord(newRelativePath, newAbsPath, oldAbsPath, newParentId);
                    await this.query.cascadeRenameDocumentPaths(relativePath, newRelativePath, oldAbsPath, newAbsPath);
                    await this.query.cascadeRenameFolderPaths(relativePath, newRelativePath, oldAbsPath, newAbsPath);
                    // media/ dirs ride along inside the folder on disk; only the index needs catching up.
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
                        // Re-push the whole subtree: everything under the moved folder now
                        // inherits from a different branch of the tree.
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
            // The document changed folder, so its folder-relative media refs have to
            // be re-grounded — otherwise every one of them points at an empty dir.
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
     * Whole-object: the caller sends the state it wants the document to be in, so it can only
     * be applied safely to the state the caller last read. `ifMatch` is that state's etag —
     * checked INSIDE the lock, because a check outside one is a race with a longer window,
     * not a guarantee.
     *
     * @param {string} relativePath
     * @param {string|null} [content] - body; undefined/null leaves the body alone.
     * @param {object} [metadata] - the whole sidecar.
     * @param {object} [opts]
     * @param {string} [opts.ifMatch] - etag the caller read. Omitted means no check; see
     *   `routes/documents.js` for why that stays permitted.
     * @returns {Promise<{etag: string|null}>} the document's etag after the write.
     */
    async updateFile(relativePath, content, metadata, { ifMatch } = {}) {
        return await withDocument(relativePath, async () => {
            // A body write is checked against the body; a metadata-only write against the
            // sidecar. Both are "the part I am replacing".
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
        const doc = await this.query.getDocumentByPath(relPath);
        if (doc) await this._writeLinkConnections(doc, links);
    }

    // Read-only path (Vault Doctor): re-derive a document's link Connections from
    // its content without writing the sidecar or emitting a Seal event.
    async indexDocumentLinks(relPath) {
        const links = this._extractLinks(relPath);
        if (links === null) return;
        const doc = await this.query.getDocumentByPath(relPath);
        if (doc) await this._writeLinkConnections(doc, links);
    }

    // When a document is indexed, resolve any pending DocumentLinks that were
    // waiting for it, then index its own outbound links. DB-only: the caller owns
    // the sidecar's links write (importFile does it before sealing; a live save
    // goes through syncDocumentLinks).
    async _resolvePendingLinks(globalHash, nodeId, relPath) {
        const pending = await this.query.getPendingLinksForTarget(globalHash);
        if (pending.length > 0) {
            await db.transaction(async () => {
                for (const row of pending) {
                    const sourceDoc = await this.query.getDocumentByHash(row.source_hash);
                    if (sourceDoc) {
                        await this.query.insertDocumentLinkConnection(sourceDoc.node_id, nodeId);
                        await this.query.deleteDocumentLinkQueueBySource(row.source_hash);
                        // Re-queue remaining entries from this source that are still unresolved
                        const remaining = await this.query.getPendingLinksFromSource(row.source_hash);
                        for (const r of remaining) {
                            await this.query.upsertDocumentLinkQueue(r.source_hash, r.target_hash, r.anchor_text);
                        }
                    }
                }
            })();
        }
        // Index this document's own outbound links into the derived layer (DB-only).
        await this.indexDocumentLinks(relPath);
    }

    // Structural: it changes which paths exist, so it takes the tree exclusively. An edit
    // already in flight anywhere finishes first, and one queued behind it waits — otherwise a
    // writer holds a path that this operation is in the middle of invalidating, and the index
    // ends up describing a tree that is not on disk.
    //
    // Creation (createFile/createFolder/importPackage) deliberately does NOT take this lock:
    // it only ADDS paths, so it invalidates nothing anyone is holding — and importPackage
    // calls updateMetadata internally, which would deadlock against a lock it already held.
    async delete(relativePath, isFolder = false) {
        return await withStructure(() => this._deleteLocked(relativePath, isFolder));
    }

    async _deleteLocked(relativePath, isFolder = false) {
        const absPath = this.files.safePath(relativePath);

        // 1. Gather seal paths from DB before deleting anything
        const sealExtra = isFolder
            ? await this._gatherFolderContents(relativePath, absPath)
            : [relativePath];

        // 2. Delete from DB first — if this fails, FS is still intact
        await db.transaction(async () => {
            if (isFolder) {
                await this.query.deleteFolderTree(absPath, path.sep);
            } else {
                await this.query.deleteDocumentByAbsPath(absPath);
            }
        })();

        // 3. Delete from FS — DB is already clean; any FS orphan is recoverable via inspect()
        await this.files.delete(relativePath, isFolder);

        // 4. Commit to Seal
        const sealSidecar = isFolder ? path.join(relativePath, '.flashback') : relativePath + '.flashback';
        await sealEmitter.delete(sealSidecar, sealExtra);
    }

    // Structural: it changes which paths exist, so it takes the tree exclusively. An edit
    // already in flight anywhere finishes first, and one queued behind it waits — otherwise a
    // writer holds a path that this operation is in the middle of invalidating, and the index
    // ends up describing a tree that is not on disk.
    //
    // Creation (createFile/createFolder/importPackage) deliberately does NOT take this lock:
    // it only ADDS paths, so it invalidates nothing anyone is holding — and importPackage
    // calls updateMetadata internally, which would deadlock against a lock it already held.
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

        // A copied folder brings its own media/ dir along in the recursive copy, but a
        // single copied file does not — and its refs are folder-relative, so without
        // this the copy renders against an empty media/ dir. Nothing is removed from
        // the source: the original document still resolves against it.
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

    // --- Metadata Helpers ---

    /**
     * Replaces a document's or folder's whole sidecar. Whole-object, so it takes the same
     * `ifMatch` treatment as updateFile — see `_assertFresh`.
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

    /** The body of updateMetadata, with the lock and the freshness check already applied. */
    async _updateMetadataLocked(relativePath, metadata, isFolder = false) {
        this.files.writeMetadata(relativePath, metadata, isFolder);

        await db.transaction(async () => {
            const entity = isFolder ? await this.query.getFolderByPath(relativePath) : await this.query.getDocumentByPath(relativePath);
            if (!entity) throw new Error(`Entity ${relativePath} not found`);

            if (isFolder) await this.query.updateFolderMetadata(entity.id, metadata);
            else await this.query.updateDocumentMetadata(entity.id, metadata);

            if (metadata.tags) await this._syncTags(entity.node_id, metadata.tags);
            if (!isFolder && metadata.flashcards) await this._syncDocumentFlashcards(entity.id, metadata.flashcards, entity.node_id);
            if (!isFolder && metadata.highlights) await highlightsService.syncFromSidecar(entity.id, metadata.highlights);

            if (!isFolder && metadata.tags !== undefined) {
                // Propagate to flashcards: document's own tags + any inherited from parent folders.
                const inherited = await this.query.getInheritedTagNames(entity.node_id);
                const effective = [...new Set([...inherited, ...(metadata.tags || [])])];
                await this._propagateTagsToFlashcards(entity.id, entity.node_id, effective);
            }

            if (isFolder) await this._propagateFolderTags(entity.id, entity.node_id, metadata);
        })();

        const sidecar = isFolder ? path.join(relativePath, '.flashback') : relativePath + '.flashback';
        await sealEmitter.edit(sidecar);
    }

    // --- Import / Export ---

    async importFile(name, relativePath, content, metadata) {
        const { name: resolvedName } = await this.files.createFile(relativePath, name);
        const fileRelPath = path.join(relativePath, resolvedName);
        const encoding = await this.files.updateFile(fileRelPath, content, metadata);

        try {
            const absPath = this.files.safePath(fileRelPath);
            // When the caller's metadata carries no identity of its own (a blank
            // template, e.g. webclip/youtube), adopt the real globalHash createFile
            // assigned to the sidecar so the derived row matches the canonical file.
            // Blank ("") hashes would otherwise collide on the second such import.
            const registerMeta = metadata?.globalHash
                ? metadata
                : { ...metadata, globalHash: this.files.getMetadata(fileRelPath)?.globalHash };
            await this._registerDocumentDerived({ name, fileRelPath, absPath, encoding, metadata: registerMeta });
        } catch (err) {
            await this.files.delete(fileRelPath, false);
            throw err;
        }

        // Fold any flashback:// links into the sidecar BEFORE sealing, so the
        // single create commit captures them — a post-seal link write would leave
        // the sidecar permanently diverged from its sealed version (out-of-band drift).
        this._writeSidecarLinks(fileRelPath, this._extractLinks(fileRelPath));
        await sealEmitter.create(fileRelPath + '.flashback', [fileRelPath]);

        // Resolve any pending DocumentLinks targeting this doc, and index its own outbound links.
        const imported = await this.query.getDocumentByPath(fileRelPath);
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
        return await this.importFile(name, relativePath, body, metadata);
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
        if (!await this.files.exists(relPath)) throw new Error("File not found");
        const { body, source } = await this._buildYoutubeDoc(url);
        const existing = this.files.getMetadata(relPath) || newFileMetadata();
        await this.files.updateFile(relPath, body, { ...existing, source });
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
        if (!await this.files.exists(relPath)) throw Object.assign(new Error("File not found"), { status: 404 });
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

    /**
     * Downloads one remote asset into `<mediaFolder>/media/`, registers it in the
     * Media table, and returns the `./media/<name>` reference the clip body should
     * point at.
     *
     * Content-addressed, so the same picture saved twice costs one file — and a
     * second save of one already in the vault is a rewrite of the same name over
     * identical bytes.
     *
     * Throws rather than returning null on failure: the only caller is a user
     * waiting on one asset they asked for, and "nothing happened" is not an answer
     * they can act on. It was best-effort when it ran over a whole page's worth of
     * pictures nobody had chosen.
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
            r = await fetch(absSrc, { headers: { 'User-Agent': CLIP_USER_AGENT } });
        } catch (err) {
            throw new Error(`Could not reach ${new URL(absSrc).hostname}: ${err.message}`);
        }
        if (!r.ok) throw new Error(`The site refused that file (status ${r.status})`);
        // A page, not a file. Reachable when a sound was published as a link and the
        // link turns out to point at a description page rather than the recording —
        // the one way the link filter can be wrong, and storing an HTML document as a
        // flashcard's audio is a failure nobody would notice until review time.
        if (/^text\/html/i.test(r.headers.get('content-type') ?? '')) {
            throw new Error('That address answers with a web page, not a file');
        }

        // Checked before the body is buffered: an image that overshoots 10 MB is
        // cheap to discard, but a podcast episode advertising 90 MB must never be
        // pulled into memory just to be thrown away. Servers that omit the header
        // fall through to the post-buffer check below.
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

    // Fetches a page, extracts its readable article, and returns the sanitized HTML
    // + `source` block. Nothing is downloaded but the page itself — the article's
    // pictures and sound keep the absolute URLs Readability resolved and load from
    // their own host until saveClipAsset pulls one into the vault. Throws on
    // fetch/extraction failure.
    async _buildClipDoc(url) {
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
        // <img> src resolve to absolute URLs — the form every asset is stored in,
        // and the address saveClipAsset later downloads from.
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
     * Highlights anchor by text offset. See _buildClipDoc for the pipeline.
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
     * Populates an existing (e.g. blank, hand-created) `.clip` file from a URL —
     * fetches/parses the page, writes the sanitized HTML body, and merges the
     * `source` block into the sidecar (preserving existing highlights/tags).
     * Backs the renderer's empty-state URL form.
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
     * Downloads one of a saved clip's remote assets into the vault and points the
     * clip at the local copy: the picture or sound becomes `./media/clip-<hash>.<ext>`
     * next to the clip file, is registered in the Media table, and the edit is sealed.
     *
     * This is the whole of the clipper's media strategy. Clipping saves the page's
     * prose; an asset is only worth a request once someone wants it on a card, and
     * this is that request. A clip therefore fills in over time with exactly the
     * figures and sounds that were used, and stays readable offline in those parts.
     *
     * The `href` must already name an asset in this clip's body. That check is not
     * a formality — without it the endpoint is an open downloader that writes any URL
     * on the internet into the vault, under the user's own token.
     *
     * A sound published as a **link** rather than a player (how Wikipedia and much of
     * the web do it) is saved the same way, and the link becomes a real `<audio>` on
     * the way in — so the clip ends up playing it where the page only pointed at it,
     * and everything downstream sees the shape it already understands.
     *
     * Safe to call unconditionally: an href that is already local returns as-is with
     * no IO, so a caller never has to know whether the asset was saved before.
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

        // A <source> is a candidate for its parent <audio>; everything else is
        // itself. The distinction matters because it is the parent whose remaining
        // alternatives have to go, and because an <audio> is a sound whatever its
        // file name looks like. A link only reaches here if it points at a playable
        // sound, so it is one too.
        const tag = el.tagName.toUpperCase();
        const audioEl = tag === 'SOURCE' ? el.closest('audio') : (tag === 'AUDIO' ? el : null);
        const kind = (audioEl || tag === 'A') ? 'audio' : 'image';

        const local = src.match(/^\.?\/?media\/(.+)$/);
        if (local) {
            // Already in the vault. Reported as a success rather than an error so a
            // caller can save on every pick without first asking where the asset
            // currently lives.
            let name = local[1];
            try { name = decodeURIComponent(name); } catch { /* keep as written */ }
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

        // A saved sound that was published as a link becomes the player the page never
        // had. The anchor's own content is the site's play-button chrome — three empty
        // spans and the word "Play" here — so nothing of value is lost, and a reader
        // that could only send you to the file can now play it, offline.
        let target = el;
        if (tag === 'A') {
            target = cdoc.createElement('audio');
            target.setAttribute('controls', '');
            target.setAttribute('preload', 'none');
            el.replaceWith(target);
        }

        target.setAttribute('src', saved.localRef);
        // Where this file came from, kept on the element. It is provenance a content
        // hash cannot carry, and it keeps the asset addressable by its web URL after
        // the src stops being one — see resolveClipAsset.
        target.setAttribute('data-src', src);
        target.removeAttribute('srcset');
        // An <audio> usually offers the same recording in several formats (an mp3 and
        // an ogg). Now that one of them is local the alternatives have to go: left in
        // place, they let the browser pick the one that still needs the network.
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
        if (await this.query.getDocumentByPath(relPath)) return await this.reindexDocument(relPath);

        const metadata = this.files.getMetadata(relPath, false);
        if (!metadata?.globalHash) throw new Error(`No valid sidecar for ${relPath}`);

        const absPath = this.files.safePath(relPath);
        const parentDir = path.dirname(relPath);
        // _ensureFolderPath registers every missing ancestor folder (DB row +
        // sidecar backfill for ghost directories) so _getParentFolderId resolves.
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
     * Refreshes an existing document's index rows from its sidecar: adopts the
     * sidecar's globalHash (sidecar is canonical), diffs flashcards by hash with
     * max-merge of SRS progress (via _syncDocumentFlashcards — a level lowered
     * out-of-band never regresses the DB), and replaces tags/highlights/links
     * wholesale so out-of-band removals propagate too.
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
            // query-level sync (not highlightsService.syncFromSidecar, which
            // no-ops on an empty array): out-of-band highlight deletions must
            // clear the derived rows as well.
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

        // Read-only: re-derive link Connections from content without rewriting the
        // sidecar or sealing — the Doctor reconciles the index, it doesn't mutate files.
        await this.indexDocumentLinks(relPath);
        return doc.id;
    }

    /**
     * Indexes a folder that exists on disk (row for every missing ancestor
     * included) and syncs its tags + inheritance from its sidecar. Idempotent
     * for already-indexed folders.
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
     * Removes a document's or folder tree's index rows for an item already
     * deleted on disk. DB-only counterpart of delete(): no filesystem call, no
     * Seal event. Folder FK cascades clean up contained documents/flashcards.
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
        return await withDocument(relativePath, () =>
            this._createFlashcardLocked(relativePath, cardData, mediaItems));
    }

    async _createFlashcardLocked(relativePath, cardData, mediaItems = []) {
        const doc = await this.query.getDocumentByPath(relativePath);
        if (!doc) throw new Error(`Document ${relativePath} not found in DB`);

        // Reject an unrecognized category up front rather than silently writing it
        // to the sidecar with no matching category_id in the DB — a mismatch here
        // used to persist as a split-brain (sidecar keeps the literal string forever,
        // the derived layer silently links to no category) with no error surfaced.
        if (cardData.category && !await this.query.getCategoryByName(cardData.category)) {
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

        // 4. One Seal commit covering the sidecar and every new media file.
        await sealEmitter.edit(relativePath + '.flashback', mediaRels);
        return savedCard;
    }

    /**
     * Edits a document-anchored flashcard's content in place.
     *
     * Like deleteFlashcard, this exists so the read and the write happen inside one
     * server operation. Every client that did its own fetch-filter-save on the sidecar
     * silently reverted whatever else landed on that file in between — the same race
     * deleteFlashcard was created to close.
     *
     * Partial: fields the caller omits keep their stored values. The card object is
     * spread rather than rebuilt, which is what preserves its globalHash, SRS progress
     * (`level`, `lastRecall`, every `fsrs*` field), its media, and its `location`
     * anchor back into the document.
     *
     * @param {string} relativePath - document the card is anchored to.
     * @param {string} flashcardHash - globalHash of the card to edit.
     * @param {object} patch - any of { frontText, backText, answerText, name, cardType, category, customHtml, tags }.
     * @returns {object} the updated card as written to the sidecar.
     */
    /**
     * Patches ONE card inside a document's sidecar.
     *
     * A patch, not a whole-object write: it names its target by hash, re-reads the sidecar
     * under the lock and puts back everything it was not asked to change. Two people editing
     * different cards of the same document therefore both succeed — the conflict that matters
     * is two people editing the SAME card, which `opts.ifMatch` detects when the caller
     * supplies the entity etag it read.
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

        // Same up-front rejection as createFlashcard: an unrecognized category would
        // otherwise persist in the sidecar with no matching category_id in the DB.
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
                ...(ex.vanillaData || {}),   // keeps media + location
                frontText: patch.frontText !== undefined ? patch.frontText : (ex.vanillaData?.frontText ?? ''),
                backText: patch.backText !== undefined ? patch.backText : (ex.vanillaData?.backText ?? ''),
            };
            // type_answer's compared value. Only written for that type, and only once the
            // caller has one: a card that still keeps its answer in backText must not gain
            // an empty answerText here, or it would read as "answer deliberately blank"
            // instead of "predates the split".
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
            // Re-syncs content, tags and category; SRS columns are max-merged there,
            // so editing a card can never roll its progress back.
            await this._syncDocumentFlashcards(doc.id, meta.flashcards, doc.node_id);
        })();

        await sealEmitter.edit(relativePath + '.flashback');
        return updated;
    }

    /**
     * Permanently deletes a document-anchored flashcard: drops it from the sidecar's
     * `flashcards[]` and lets the derived-layer sync remove the row (and, by trigger,
     * its content, reference and review history).
     *
     * The sidecar is the canonical home of a document's cards, so this is a
     * read-modify-write of that file rather than a DB delete. It lives here — instead
     * of being done by each caller — so the read and the write happen inside one server
     * operation: a client doing its own fetch-filter-save races every other write to
     * the same sidecar and silently reverts whatever landed in between.
     *
     * Deck cleanup is NOT done here (`decks.removeCardEverywhere` owns the deck files);
     * the caller must run it first, while the card's node still exists.
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
            // Any card whose hash is no longer in the incoming array is deleted.
            await this._syncDocumentFlashcards(doc.id, meta.flashcards, doc.node_id);
        })();

        await sealEmitter.edit(relativePath + '.flashback');
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

        await db.transaction(async () => {
            await this.query.insertMedia({ hash, name: mediaName, relativePath: mediaRel, absolutePath: mediaAbs });
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
        const { documentId, fsrs, scope } = await this.srs.submitReview(
            flashcardHash, outcome, easeFactor, newLevel, algorithm, opts,
        );

        // ONLY the owner's grade reaches the file. Everyone else's durable copy is already in
        // the accounts store (srs.js mirrors it inside the same transaction), and writing it
        // here instead would put one person's study record into a git history that travels
        // with the folder to whoever gets a copy. It also means a reader's review produces no
        // Seal commit at all, which is the behaviour you want: reading is not editing.
        if (!isOwnerScope(scope)) {
            await this.propagatePresence(documentId);
            return;
        }

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

        await this.propagatePresence(documentId);
        // review(), not edit(): a graded card's new schedule is the one write whose commit
        // nobody will ever roll back to, and a session produces one per card. See the
        // SealEventEmitter class comment.
        await sealEmitter.review(relativePath + '.flashback');
    }

    // Reverse the last review of a document-linked card: undo it in the derived
    // layer, then mirror the restored SRS state back into the sidecar and seal the
    // change so the canonical layer stays authoritative. Returns the restored state.
    async undoReview(relativePath, flashcardHash, algorithm = 'leitner') {
        const { document_id, restored, scope } = await this.srs.undoReview(flashcardHash, algorithm);

        // Same rule as submitReview, and for the same reason: a non-owner's undo is already
        // durable in the accounts store, and the sidecar is not theirs to rewrite.
        if (!isOwnerScope(scope)) {
            if (document_id) await this.propagatePresence(document_id);
            return restored;
        }

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
            // Coalesced like the review it reverses — see submitReview above.
            await sealEmitter.review(relativePath + '.flashback');
        }

        if (document_id) await this.propagatePresence(document_id);
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

    /**
     * Mirrors a sidecar's flashcards[] into the derived layer.
     *
     * `docNodeId` is what lets a card created *after* its document was tagged inherit
     * those tags at creation instead of only on the next tag write — the document's
     * effective tags are re-pushed to every card once the set has been synced. Callers
     * that genuinely have no node id (legacy paths) may omit it and get the old
     * cards-only behaviour.
     */
    // ALWAYS the owner's scope, and not because of who is logged in: this method reconciles
    // the derived layer with a `.flashback` sidecar, and the sidecar is by definition the
    // owner's record of the owner's progress. A collaborator editing a document must not have
    // their own schedule written into the file, and must not have the file's schedule written
    // over theirs. Everyone else's progress lives in the accounts store and is untouched here.
    async _syncDocumentFlashcards(documentId, flashcardsData, docNodeId = null) {
        const existing = await this.query.getFlashcardsByDocument(documentId, OWNER_SCOPE);
        const existingMap = new Map(existing.map(f => [f.global_hash, f]));
        const incomingHashes = new Set();

        // for...of rather than forEach: the body writes through the data layer, which is
        // async, and an async forEach callback would fire every iteration concurrently and
        // return before any of them finished.
        for (const [index, fcData] of flashcardsData.entries()) {
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

    /**
     * The tag set a folder hands down to its children: whatever it inherits on its own
     * incoming edge (minus its own exclusions) plus its direct tags. This is the same
     * `effectiveToChildren` set _propagateFolderTags computes, factored out so a *newly
     * created* child can be given it immediately instead of waiting for someone to
     * re-save the parent's tags.
     */
    async _tagsPassedDownByFolder(folderNodeId, folderRelPath) {
        const meta = this.files.getMetadata(folderRelPath, true) || {};
        const excluded = new Set(meta.excludedTags || []);
        const inherited = (await this.query.getInheritedTagNames(folderNodeId)).filter(t => !excluded.has(t));
        const direct = await this.query.getDirectTagNames(folderNodeId);
        return [...new Set([...inherited, ...direct])];
    }

    /**
     * Fills a parent→child inheritance edge with the parent's effective tags.
     *
     * insertInheritance() only creates the Connections row — it copies no InheritedTags.
     * Without this, anything created under an already-tagged parent (a document imported
     * into a tagged folder, a folder created inside one, a card added to a tagged
     * document) inherits nothing, and the tag only "arrives" the next time the parent's
     * own tags are written. Idempotent: clears the edge before refilling it.
     */
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

    // Seeds a new child edge from its parent folder, looked up by folder row.
    async _seedFromParentFolder(parentFolder, childNodeId) {
        if (!parentFolder?.node_id) return;
        await this._seedInheritedTags(
            parentFolder.node_id,
            childNodeId,
            await this._tagsPassedDownByFolder(parentFolder.node_id, parentFolder.relative_path),
        );
    }

    // A document's effective tags — what it hands down to its own flashcards.
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

    // --- Media carrying (see _carryMediaAfterMove) ---

    // Every `./media/<name>` occurrence in a blob of text (custom card HTML, or a
    // clip/markdown body). Media refs are always folder-relative by design, which
    // is exactly why they have to be kept in step with the folder a document sits in.
    static _MEDIA_REF = /\.\/media\/([^"')\s>]+)/g;

    // A 64-hex ref is a content hash served from the Media table (Anki imports use
    // these), not a path — those are location-independent and need no carrying.
    static _IS_HASH = /^[a-f0-9]{64}$/i;

    // Collects the media file names a single document references, across all the
    // places a ref can hide: vanilla card slots, custom card HTML, and the body.
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

        // Bodies only carry refs in text formats; binary ones simply throw here.
        try { addRefsIn(this.files.readFile(relDocPath).content); } catch { /* binary or unreadable body */ }

        return names;
    }

    // The union of media names still referenced by the documents sitting directly
    // in `folderRel`. Only direct children matter: a sub-folder has its own media/.
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

    // Replicates the media a document references from one folder's media/ dir into
    // another's. Pure addition: nothing is removed and no DB row is re-pointed, so
    // it is safe for both halves of a copy and as the first half of a move.
    //
    // Returns { added, carried } — the rel-paths written, and the names that were
    // actually found at the source (the caller decides what to do with the originals).
    _replicateMedia(relDocPath, oldFolder, newFolder) {
        const added = [], carried = [];
        if (oldFolder === newFolder) return { added, carried };

        for (const name of this._mediaNamesReferencedBy(relDocPath)) {
            const srcAbs = this.files.safePath(path.join(oldFolder, 'media', name));
            if (!fs.existsSync(srcAbs)) continue;   // already missing; nothing to carry

            const destRel = path.join(newFolder, 'media', name);
            const destAbs = this.files.safePath(destRel);
            fs.mkdirSync(path.dirname(destAbs), { recursive: true });
            if (!fs.existsSync(destAbs)) fs.copyFileSync(srcAbs, destAbs);
            added.push(destRel);
            carried.push(name);
        }
        return { added, carried };
    }

    // Media lives at `<dirname(document)>/media/<name>` and is referenced folder-
    // relatively, so a document that changes folder leaves every one of its refs
    // pointing into an empty directory unless the files travel with it. Replicates
    // each referenced file into the destination folder, then drops the source copy
    // only when no sibling left behind still needs it (media/ is shared folder-wide).
    //
    // Returns the media rel-paths touched, so the caller can fold them into the
    // one Seal commit that records the move.
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
                // A sibling still resolves `./media/<name>` against the old folder,
                // so both copies are live. The Media row keys on the content hash,
                // which is identical for both, so it stays pointed at the original.
                continue;
            }
            const srcRel = path.join(oldFolder, 'media', name);
            const srcAbs = this.files.safePath(srcRel);
            const destRel = path.join(newFolder, 'media', name);
            fs.rmSync(srcAbs, { force: true });
            removed.push(srcRel);
            await this.query.updateMediaPath(srcAbs, destRel, this.files.safePath(destRel));
        }

        // Drop the source media/ dir once it has gone empty, so reorganising does
        // not litter the vault with husks the user is tempted to delete by hand.
        const srcMediaAbs = this.files.safePath(path.join(oldFolder, 'media'));
        try {
            if (fs.existsSync(srcMediaAbs) && fs.readdirSync(srcMediaAbs).length === 0) {
                fs.rmdirSync(srcMediaAbs);
            }
        } catch { /* non-empty or racing another write; harmless to leave */ }

        return { added, removed };
    }

    // Returns { removed, added } path arrays for a folder rename/move.
    // Queries the DB after the rename so new paths are already stored; derives old paths by replacing the prefix.
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

    // Returns all file + sidecar paths inside a folder, queried before deletion.
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

    async propagatePresence(documentId) {
        await db.transaction(async () => {
            // OWNER_SCOPE deliberately. `presence` is written onto the Documents row and
            // mirrored into the sidecar, so it is part of what the canonical layer claims
            // about this document — not a per-reader number. A reader's grade must not
            // rewrite it. Per-viewer "how well do I know this" is the graph's job.
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

    async search(q) { return await this.query.search(q); }

    // Case-insensitive substring search across text document BODIES. Name/card
    // matching lives in query.search / superSearch — bodies exist only on disk,
    // so this reads each text document (same whitelist as _extractLinks) and
    // returns per-document match counts with context snippets.
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

    // Outgoing flashback:// links and backlinks for one document. Resolved edges
    // come from the graph Connections; unresolved outgoing targets (a linked
    // hash whose document doesn't exist yet) come from the DocumentLinks queue.
    async getLinks(relPath) {
        const doc = await this.query.getDocumentByPath(relPath);
        if (!doc) throw new Error(`Document ${relPath} not found`);
        const { outgoing, backlinks } = await this.query.getDocumentLinkEdges(doc.node_id);
        const pending = (await this.query.getPendingLinksFromSource(doc.global_hash))
            .map((l) => ({ targetHash: l.target_hash, anchorText: l.anchor_text }));
        return { outgoing, backlinks, pending };
    }

    // Graph nodes carry a `learned` scalar (0..1) so the view can show which
    // parts of the vault are actually committed to memory. The per-card score
    // is computed in SQL (CARD_LEARNED_SQL); this only rolls it up per node
    // type and strips the intermediate sums off the payload.
    async getGraphData(scope) {
        const { nodes, edges } = await this.query.getGraphData(scope ?? currentScope());
        return { nodes: nodes.map(graphNodeLearning), edges };
    }
    async exists(rel, derived, isFolder) {
        if (derived) return isFolder ? await this.query.getFolderByPath(rel) : await this.query.getDocumentByPath(rel);
        return await this.files.exists(rel);
    }
}
