/**
 * Doctor.js — Tier 3 orchestrator for vault health: keeping the derived SQLite
 * index consistent with the canonical .flashback sidecars.
 *
 * The dual-layer model means the index can drift from the canonical layer
 * (out-of-band edits, Seal rollbacks, crashes, DB corruption). The Doctor
 * closes that loop:
 *
 *   checkIndex()    Read-only whole-vault report. Direct workspace-walk ↔ DB
 *                   comparison — NOT sealTools.inspect(), which diffs against
 *                   git HEAD and is blind right after a rollback (HEAD ==
 *                   workdir while the index is maximally diverged). Git drift
 *                   is included in the report as supplementary context only.
 *   syncIndex()     Applies the diff: disk is truth. Indexes new sidecars,
 *                   reindexes modified ones (SRS max-merge — never regresses
 *                   progress), removes index rows for deleted items, reconciles
 *                   media both directions, repairs decks. By default seals
 *                   remaining out-of-band drift into one `reconcile:` commit.
 *   rebuildIndex()  Nuclear option: wipes all derived content and re-indexes
 *                   the entire canonical layer. Loses ReviewLogs history (level
 *                   and ease survive via sidecars; standalone-card content
 *                   survives via deck inline_card snapshots but its level resets).
 *
 * Import rules (ACCESS.md): Tier 3 may import documents.js (subscriptions.js /
 * obsidianImport.js precedent), other Tier 3 orchestrators, Tier 2, and Seal.
 */

import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import Files from './files.js';
import query from './query.js';
import Documents from './documents.js';
import Decks from './decks.js';
import { sealEmitter, sealTools } from '../seal/seal.js';

// The DB stores relative_path with the platform separator (path.sep), the
// walker uses path.join (also platform), and git paths use '/'. Everything is
// normalized to '/' once, at comparison time — the #1 cross-layer trap.
const norm = p => (p ?? '').split(/[\\/]+/).filter(Boolean).join('/');
const depth = p => norm(p).split('/').length;

export default class Doctor {
    constructor() {
        this.files = new Files();
        this.query = query;
        this.documents = new Documents();
        this.decks = new Decks();
    }

    /**
     * Read-only whole-vault consistency report.
     * @returns {Promise<object>} see shape below; every array holds workspace-relative paths.
     */
    async checkIndex() {
        await sealEmitter.flushEdits();

        const integrity = this.query.integrityCheck();
        const walk = this.files.walkWorkspace();
        const dbDocs = this.query.getAllDocuments();
        const dbFolders = this.query.getAllFolders();

        // --- Folders ---
        const walkFolderByPath = new Map(walk.folders.map(f => [norm(f.relPath), f]));
        const dbFolderPaths = new Set(dbFolders.map(f => norm(f.relative_path)).filter(p => p !== ''));

        const folders = {
            missingInDb: walk.folders.filter(f => !f.sidecarCorrupt && !dbFolderPaths.has(norm(f.relPath))).map(f => f.relPath),
            orphanedInDb: dbFolders
                .filter(f => norm(f.relative_path) !== '' && !walkFolderByPath.has(norm(f.relative_path)))
                .map(f => f.relative_path),
            ghostDirs: walk.folders.filter(f => !f.sidecarExists).map(f => f.relPath),
            corruptSidecars: walk.folders.filter(f => f.sidecarCorrupt).map(f => f.relPath),
        };

        // --- Documents ---
        const walkDocByPath = new Map(walk.documents.map(d => [norm(d.relPath), d]));
        const dbDocByPath = new Map(dbDocs.map(d => [norm(d.relative_path), d]));

        const missingInDb = [];
        const modified = [];
        const corruptDocSidecars = [];
        const hashOwners = new Map(); // sidecar globalHash → [paths]

        for (const wd of walk.documents) {
            if (wd.sidecarCorrupt) { corruptDocSidecars.push(wd.relPath); continue; }
            const hash = wd.meta?.globalHash;
            if (hash) {
                if (!hashOwners.has(hash)) hashOwners.set(hash, []);
                hashOwners.get(hash).push(wd.relPath);
            }

            const dbDoc = dbDocByPath.get(norm(wd.relPath));
            if (!dbDoc) { missingInDb.push(wd.relPath); continue; }

            const reasons = this._diffDocument(wd.meta ?? {}, dbDoc);
            if (reasons.length > 0) modified.push({ relPath: wd.relPath, reasons });
        }

        const hashConflicts = [...hashOwners.entries()]
            .filter(([, paths]) => paths.length > 1)
            .map(([hash, paths]) => ({ hash, paths }));

        const documents = {
            missingInDb,
            orphanedInDb: dbDocs
                .filter(d => !walkDocByPath.has(norm(d.relative_path)))
                .map(d => d.relative_path),
            modified,
            hashConflicts,
            corruptSidecars: corruptDocSidecars,
            untracked: walk.strayItems,
        };

        // --- Media (both directions) ---
        const dbMedia = this.query.getAllMedia();
        const missingOnDisk = dbMedia.filter(m => !fs.existsSync(m.absolute_path)).map(m => m.relative_path);
        const dbMediaAbs = new Set(dbMedia.map(m => norm(m.absolute_path)));
        const unregistered = [];
        for (const dirRel of walk.mediaDirs) {
            const absDir = this.files.safePath(dirRel);
            for (const name of fs.readdirSync(absDir)) {
                const abs = path.join(absDir, name);
                if (fs.lstatSync(abs).isFile() && !dbMediaAbs.has(norm(abs))) {
                    unregistered.push(path.join(dirRel, name));
                }
            }
        }

        return {
            db: { integrity },
            folders,
            documents,
            media: { missingOnDisk, unregistered },
            decks: this.decks.diagnoseDecks(),
            seal: { drift: await sealTools.inspect() },
            counts: {
                documents: dbDocs.length,
                folders: Math.max(0, dbFolders.length - 1), // exclude the root row
                flashcards: this.query.getFlashcardCount(),
                standaloneCards: this.query.getStandaloneCardCount(),
                pendingLinks: this.query.getPendingLinkCount(),
            },
            generatedAt: new Date().toISOString(),
        };
    }

    // Shallow drift detection for a document present in both layers. syncIndex's
    // reindex is idempotent and wholesale, so these reasons only need to answer
    // "does this doc need a reindex", not enumerate every difference.
    _diffDocument(meta, dbDoc) {
        const reasons = [];
        if (meta.globalHash && meta.globalHash !== dbDoc.global_hash) reasons.push('hashChanged');

        const dbCards = this.query.getFlashcardsByDocument(dbDoc.id);
        const dbByHash = new Map(dbCards.map(c => [c.global_hash, c]));
        const metaCards = Array.isArray(meta.flashcards) ? meta.flashcards : [];

        const metaHashes = new Set(metaCards.map(c => c.globalHash).filter(Boolean));
        if (metaHashes.size !== dbByHash.size || [...metaHashes].some(h => !dbByHash.has(h))) {
            reasons.push('cardSetChanged');
        }
        for (const mc of metaCards) {
            const match = mc.globalHash ? dbByHash.get(mc.globalHash) : null;
            if (match && ((mc.level ?? 0) > (match.level ?? 0) || (mc.sm2Reps ?? 0) > (match.sm2_reps ?? 0))) {
                reasons.push('levelAhead');
                break;
            }
        }

        const dbTags = new Set(this.query.getDirectTagNames(dbDoc.node_id));
        const metaTags = new Set(meta.tags ?? []);
        if (dbTags.size !== metaTags.size || [...metaTags].some(t => !dbTags.has(t))) {
            reasons.push('tagsChanged');
        }
        return reasons;
    }

    /**
     * Applies the check report. Disk is the source of truth; SRS progress is
     * preserved by _syncDocumentFlashcards' max-merge. Idempotent — a second
     * run reports zero actions.
     * @param {object} [options]
     * @param {boolean} [options.sealDrift=true] - bind remaining out-of-band changes
     *   (including deletions) into one `reconcile:` commit afterward. Post-rollback
     *   there is no drift, so no commit is created.
     * @returns {Promise<{ actions: object, skipped: object, warnings: string[], sealedOid: string|null, report: object }>}
     */
    async syncIndex({ sealDrift = true } = {}) {
        const report = await this.checkIndex();
        if (report.db.integrity !== 'ok') {
            throw new Error(`Database integrity check failed (${report.db.integrity}). Sync cannot proceed — rebuild the index from files instead.`);
        }

        const actions = {
            foldersIndexed: 0, documentsIndexed: 0, documentsReindexed: 0,
            foldersRemoved: 0, documentsRemoved: 0,
            mediaRowsRemoved: 0, mediaRegistered: 0,
            decks: null,
        };
        const warnings = [];
        const conflictPaths = new Set(report.documents.hashConflicts.flatMap(c => c.paths.map(norm)));

        // 1. Folders on disk but not in the index — parents before children.
        for (const relPath of [...report.folders.missingInDb].sort((a, b) => depth(a) - depth(b))) {
            try {
                this.documents.indexFolder(relPath);
                actions.foldersIndexed++;
            } catch (err) {
                warnings.push(`Folder indexing failed for ${relPath}: ${err.message}`);
            }
        }

        // 2. Documents on disk but not in the index. Hash conflicts are never
        //    auto-resolved — regenerating a globalHash would sever deck entries
        //    and links pointing at it (hashes are immutable by design).
        for (const relPath of report.documents.missingInDb) {
            if (conflictPaths.has(norm(relPath))) continue;
            try {
                await this.documents.indexDocument(relPath);
                actions.documentsIndexed++;
            } catch (err) {
                warnings.push(`Document indexing failed for ${relPath}: ${err.message}`);
            }
        }

        // 3. Documents present in both layers but drifted.
        for (const { relPath } of report.documents.modified) {
            if (conflictPaths.has(norm(relPath))) continue;
            try {
                await this.documents.reindexDocument(relPath);
                actions.documentsReindexed++;
            } catch (err) {
                warnings.push(`Document reindex failed for ${relPath}: ${err.message}`);
            }
        }

        // 4. Deletions — shallowest folders first so FK cascades make the
        //    contained rows' individual deletions no-ops.
        for (const relPath of [...report.folders.orphanedInDb].sort((a, b) => depth(a) - depth(b))) {
            try {
                this.documents.removeFromIndex(relPath, true);
                actions.foldersRemoved++;
            } catch (err) {
                warnings.push(`Folder removal failed for ${relPath}: ${err.message}`);
            }
        }
        for (const relPath of report.documents.orphanedInDb) {
            try {
                if (this.query.getDocumentByPath(relPath)) {
                    this.documents.removeFromIndex(relPath, false);
                    actions.documentsRemoved++;
                }
            } catch (err) {
                warnings.push(`Document removal failed for ${relPath}: ${err.message}`);
            }
        }

        // 5. Media, both directions.
        for (const relPath of report.media.missingOnDisk) {
            this.query.deleteMediaByAbsPath(this.files.safePath(relPath));
            actions.mediaRowsRemoved++;
        }
        for (const relPath of report.media.unregistered) {
            try {
                this._registerMediaFile(relPath);
                actions.mediaRegistered++;
            } catch (err) {
                warnings.push(`Media registration failed for ${relPath}: ${err.message}`);
            }
        }

        // 6. Decks (file wins).
        actions.decks = this.decks.repairFromFiles();

        // 7. Bind the out-of-band changes this sync just reconciled (plus the
        //    idempotent sidecar rewrites reindexing may have produced) into history.
        const sealedOid = sealDrift ? await sealTools.commitDrift() : null;

        return {
            actions,
            skipped: {
                hashConflicts: report.documents.hashConflicts,
                corruptSidecars: [...report.documents.corruptSidecars, ...report.folders.corruptSidecars],
                untracked: report.documents.untracked,
                danglingDeckEntries: report.decks.danglingEntries,
            },
            warnings,
            sealedOid,
            report,
        };
    }

    /**
     * Wipes all derived content and re-indexes the entire canonical layer.
     * Rerunnable but not atomic past the wipe: per-item failures are collected
     * into warnings instead of aborting, so a partial rebuild is finished by
     * running it again. ReviewLogs history does not survive (a synthetic log
     * entry preserves each card's latest ease factor).
     * @returns {Promise<{ summary: object, warnings: string[] }>}
     */
    async rebuildIndex() {
        await sealEmitter.flushEdits();
        const walk = this.files.walkWorkspace();
        const warnings = [];

        // Card categories must exist before any insertFlashcard call — unknown
        // category names are silently dropped at the query layer.
        this._ensureCategories(walk, warnings);

        this.query.wipeDerivedContent();

        // Root folder row, then every folder in pre-order.
        this.documents.indexFolder('');
        let foldersIndexed = 0;
        for (const f of walk.folders) {
            try {
                this.documents.indexFolder(f.relPath);
                foldersIndexed++;
            } catch (err) {
                warnings.push(`Folder indexing failed for ${f.relPath}: ${err.message}`);
            }
        }

        let documentsIndexed = 0;
        for (const d of walk.documents) {
            if (d.sidecarCorrupt) {
                warnings.push(`Corrupt sidecar skipped: ${d.relPath}`);
                continue;
            }
            try {
                await this.documents.indexDocument(d.relPath);
                documentsIndexed++;
            } catch (err) {
                warnings.push(`Document indexing failed for ${d.relPath}: ${err.message}`);
            }
        }

        // One final top-down inheritance pass from the root guards against any
        // ordering gaps (indexFolder propagates recursively).
        this.documents.indexFolder('');

        // Decks + standalone cards from inline snapshots.
        const deckResult = this.decks.rebuildFromFiles();
        warnings.push(...deckResult.warnings);

        // Media registration.
        let mediaRegistered = 0;
        for (const dirRel of walk.mediaDirs) {
            const absDir = this.files.safePath(dirRel);
            for (const name of fs.readdirSync(absDir)) {
                if (!fs.lstatSync(path.join(absDir, name)).isFile()) continue;
                try {
                    this._registerMediaFile(path.join(dirRel, name));
                    mediaRegistered++;
                } catch (err) {
                    warnings.push(`Media registration failed for ${path.join(dirRel, name)}: ${err.message}`);
                }
            }
        }

        // Preserve SM-2 ease: the sidecar carries each card's last easeFactor,
        // but getLatestEaseFactors() reads it from ReviewLogs — re-seed one
        // synthetic log row per card that had one.
        let easeRestored = 0;
        for (const d of walk.documents) {
            for (const fc of d.meta?.flashcards ?? []) {
                if (fc.globalHash == null || fc.easeFactor == null) continue;
                const row = this.query.getFlashcardByHash(fc.globalHash);
                if (row) {
                    this.query.insertSyntheticReviewLog(row.id, fc.easeFactor, fc.level ?? 0);
                    easeRestored++;
                }
            }
        }

        return {
            summary: {
                foldersIndexed,
                documentsIndexed,
                flashcards: this.query.getFlashcardCount(),
                decks: deckResult.decks,
                standaloneCardsRestored: deckResult.restoredCards,
                mediaRegistered,
                easeFactorsRestored: easeRestored,
            },
            warnings,
        };
    }

    _ensureCategories(walk, warnings) {
        const wanted = new Set();
        for (const d of walk.documents) {
            for (const fc of d.meta?.flashcards ?? []) {
                if (fc.category) wanted.add(fc.category);
            }
        }
        for (const f of this.decks.listDeckFiles()) {
            for (const e of f.data?.entries ?? []) {
                if (e.card?.category) wanted.add(e.card.category);
            }
        }
        for (const name of wanted) {
            if (!this.query.getCategoryByName(name)) {
                try {
                    this.query.insertCategory({ name, priority: 1, description: 'Recovered by Vault Doctor' });
                } catch (err) {
                    warnings.push(`Could not recreate category "${name}": ${err.message}`);
                }
            }
        }
    }

    _registerMediaFile(relPath) {
        const abs = this.files.safePath(relPath);
        const hash = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
        this.query.insertMedia({
            hash,
            name: path.basename(relPath),
            relativePath: relPath,
            absolutePath: abs,
        });
    }
}
