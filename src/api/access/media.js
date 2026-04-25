/**
 * Media.js — Tier 3 orchestrator for media asset lifecycle.
 *
 * Responsibilities:
 *   - serve(hash)          → resolve a media file for API delivery
 *   - list(folderRelPath)  → enumerate all media files in a folder's media/ dir
 *   - addVanillaMedia(...) → write vanilla media (FS + sidecar + DB + Seal)
 *   - removeMedia(...)     → remove media (FS + sidecar + DB + Seal)
 *   - reconcile(...)       → drop DB entries whose files no longer exist on disk
 *
 * Does NOT handle flashcard-to-media linkage for custom HTML flashcards — that
 * belongs to Documents.addMediaToFlashcard(), which already owns that flow.
 *
 * HTML engine note: custom HTML in customData.html references media via
 * ./media/<name> for sidecar portability. The API serves media by hash at
 * GET /api/media/:hash so the renderer never needs the absolute workspace path.
 */

import Files from './files.js';
import query from './query.js';
import db from './database.js';
import { sealEmitter } from '../seal/seal.js';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';

export default class Media {
    constructor() {
        this.files = new Files();
        this.query = query;
    }

    /**
     * Resolves a media entry by its SHA-256 hash.
     * Used by the API route to stream the file to the client.
     * @param {string} hash
     * @returns {{ id, hash, name, relative_path, absolute_path }}
     * @throws if the hash is unknown or the file is missing on disk
     */
    serve(hash) {
        const entry = this.query.getMediaByHash(hash);
        if (!entry) throw new Error(`Media not found: ${hash}`);
        if (!fs.existsSync(entry.absolute_path)) {
            throw new Error(`Media file missing on disk: ${entry.absolute_path}`);
        }
        return entry;
    }

    /**
     * Lists all files inside a folder's media/ subdirectory.
     * Cross-references DB entries to include hash info where available.
     * @param {string} folderRelPath - relative path to the parent folder
     * @returns {Array<{ name, relativePath, absolutePath, hash|null }>}
     */
    list(folderRelPath) {
        const absDir = path.join(this.files.workspaceRoot, folderRelPath, 'media');
        if (!fs.existsSync(absDir)) return [];

        const prefix = absDir + path.sep;
        const dbEntries = this.query.getMediaByAbsPathPrefix(prefix);
        const byAbsPath = new Map(dbEntries.map(e => [e.absolute_path, e]));

        return fs.readdirSync(absDir).map(name => {
            const absolutePath = path.join(absDir, name);
            const relativePath = path.join(folderRelPath, 'media', name);
            const entry = byAbsPath.get(absolutePath);
            return { name, relativePath, absolutePath, hash: entry?.hash ?? null };
        });
    }

    /**
     * Adds a vanilla media asset (image or sound for front/back) to a flashcard.
     * Orchestrates: FS write → sidecar update → DB registration → Seal commit.
     *
     * @param {string} relDocPath - relative path to the document
     * @param {string} flashcardHash - globalHash of the target flashcard
     * @param {Buffer} buffer - raw file data
     * @param {string} name - filename (e.g. "narration.mp3")
     * @param {"image"|"sound"} type
     * @param {"front"|"back"} position
     */
    async addVanillaMedia(relDocPath, flashcardHash, buffer, name, type, position) {
        const meta = this.files.getMetadata(relDocPath);
        const cardIdx = meta?.flashcards?.findIndex(f => f.globalHash === flashcardHash) ?? -1;
        if (cardIdx === -1) throw new Error(`Flashcard ${flashcardHash} not found in ${relDocPath}`);

        // FS write + sidecar update (Files layer)
        this.files.addVanillaData(relDocPath, buffer, name, type, position, cardIdx);

        // DB registration
        const mediaRel = path.join(path.dirname(relDocPath), 'media', name);
        const mediaAbs = this.files.safePath(mediaRel);
        const hash = crypto.createHash('sha256').update(buffer).digest('hex');

        db.transaction(() => {
            this.query.insertMedia({ hash, name, relativePath: mediaRel, absolutePath: mediaAbs });
        })();

        await sealEmitter.edit(relDocPath + '.flashback', [mediaRel]);
    }

    /**
     * Removes a media file from a document's media/ directory.
     * Cleans up: FS file → all sidecar references (both vanillaData and customData) → DB entry → Seal commit.
     *
     * @param {string} relDocPath - relative path to the document that owns the media
     * @param {string} mediaName - filename to remove (e.g. "diagram.png")
     */
    async removeMedia(relDocPath, mediaName) {
        const mediaRel = path.join(path.dirname(relDocPath), 'media', mediaName);
        const mediaAbs = this.files.safePath(mediaRel);

        // FS delete + sidecar cleanup (handles both vanillaData and customData refs)
        this.files.removeCustomMedia(relDocPath, mediaName);

        // DB cleanup
        db.transaction(() => {
            this.query.deleteMediaByAbsPath(mediaAbs);
        })();

        await sealEmitter.edit(relDocPath + '.flashback', []);
    }

    /**
     * Drops DB entries for media files that no longer exist on disk within a folder.
     * Safe to call at any time — purely additive from the FS perspective.
     * @param {string} folderRelPath
     * @returns {Array} orphaned entries that were removed from the DB
     */
    reconcile(folderRelPath) {
        const absDir = path.join(this.files.workspaceRoot, folderRelPath, 'media');
        const prefix = absDir + path.sep;
        const entries = this.query.getMediaByAbsPathPrefix(prefix);
        const orphans = entries.filter(e => !fs.existsSync(e.absolute_path));

        db.transaction(() => {
            for (const orphan of orphans) {
                this.query.deleteMediaByAbsPath(orphan.absolute_path);
            }
        })();

        return orphans;
    }
}
