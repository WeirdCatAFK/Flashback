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

export default class Documents {
    constructor() {
        this.files = new Files();
        this.query = query;
        this.srs = srsService;
    }

    // --- Core Operations ---

    async createFile(name, relativePath = "") {
        const fileRelPath = path.join(relativePath, name);
        const globalHash = this.files.createFile(relativePath, name);

        try {
            const absPath = this.files.safePath(fileRelPath);
            db.transaction(() => {
                const nodeId = this.query.createNode('Document');
                const folderId = this._getParentFolderId(absPath);
                this.query.insertDocument({
                    folderId, nodeId, globalHash, 
                    relativePath: fileRelPath, absolutePath: absPath, name
                });
            })();
        } catch (err) {
            this.files.delete(fileRelPath, false);
            throw err;
        }
    }

    async createFolder(name, relativePath = "") {
        const folderRelPath = path.join(relativePath, name);
        const globalHash = this.files.createFolder(relativePath, name);

        try {
            const absPath = this.files.safePath(folderRelPath);
            db.transaction(() => {
                const nodeId = this.query.createNode('Folder');
                const parentId = this._getParentFolderId(absPath);
                this.query.insertFolder({
                    nodeId, globalHash, parentId, relativePath: folderRelPath, absolutePath: absPath, name
                });
            })();
        } catch (err) {
            this.files.delete(folderRelPath, true);
            throw err;
        }
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
    }

    async move(relativePath, newRelativePath, isFolder = false) {
        const oldAbsPath = this.files.safePath(relativePath);
        const newAbsPath = this.files.safePath(newRelativePath);

        this.files.move(relativePath, newRelativePath, isFolder);

        try {
            db.transaction(() => {
                if (!isFolder) {
                    const newFolderId = this._getParentFolderId(newAbsPath);
                    this.query.moveDocumentRecord(newFolderId, newRelativePath, newAbsPath, oldAbsPath);
                } else {
                    const newParentId = this._getParentFolderId(newAbsPath);
                    this.query.moveFolderRecord(newRelativePath, newAbsPath, oldAbsPath, newParentId);
                    this.query.cascadeRenameDocumentPaths(relativePath, newRelativePath, oldAbsPath, newAbsPath);
                    this.query.cascadeRenameFolderPaths(relativePath, newRelativePath, oldAbsPath, newAbsPath);
                }
            })();
        } catch (err) {
            this.files.move(newRelativePath, relativePath, isFolder);
            throw err;
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
    }

    async delete(relativePath, isFolder = false) {
        this.files.delete(relativePath, isFolder);
        const absPath = this.files.safePath(relativePath);

        db.transaction(() => {
            if (isFolder) {
                this.query.deleteFolderTree(absPath, path.sep);
            } else {
                this.query.deleteDocumentByAbsPath(absPath);
            }
        })();
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

            if (isFolder) this._propagateFolderTags(entity.id, entity.node_id, metadata);
        })();
    }

    // --- Import / Export ---

    async importFile(name, relativePath, content, metadata) {
        const fileRelPath = path.join(relativePath, name);
        this.files.createFile(relativePath, name);
        this.files.updateFile(fileRelPath, content, metadata);

        try {
            const absPath = this.files.safePath(fileRelPath);
            db.transaction(() => {
                const nodeId = this.query.createNode('Document');
                const folderId = this._getParentFolderId(absPath);
                const info = this.query.insertDocument({
                    folderId, nodeId, globalHash: metadata.globalHash,
                    relativePath: fileRelPath, absolutePath: absPath, name
                });
                const docId = info.lastInsertRowid;

                if (metadata.tags) this._syncTags(nodeId, metadata.tags);
                if (metadata.flashcards) this._syncDocumentFlashcards(docId, metadata.flashcards);
            })();
        } catch (err) {
            this.files.delete(fileRelPath, false);
            throw err;
        }
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
    }

    // --- SRS Support ---

    async submitReview(relativePath, flashcardHash, outcome, easeFactor, newLevel) {
        const metadata = this.files.getMetadata(relativePath);
        const card = metadata?.flashcards?.find(f => f.globalHash === flashcardHash);
        if (!card) throw new Error(`Flashcard ${flashcardHash} not found in sidecar for ${relativePath}`);

        card.level = newLevel;
        card.easeFactor = easeFactor;
        card.lastRecall = new Date().toISOString();
        this.files.writeMetadata(relativePath, metadata);

        const docId = this.srs.submitReview(flashcardHash, outcome, easeFactor, newLevel);
        this.propagatePresence(docId);
    }

    // --- Private / Internal ---

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
                const mergedRecall = (mergedLevel === (fcData.level ?? 0) && fcData.lastRecall)
                    ? fcData.lastRecall
                    : (match.last_recall ?? fcData.lastRecall);

                this.query.updateFlashcard(match.id, {
                    ...fcData,
                    level: mergedLevel,
                    lastRecall: mergedRecall,
                    fileIndex: index,
                    contentId: match.content_id
                });
            } else {
                const nodeId = this.query.createNode('Flashcard');
                this.query.insertFlashcard({
                    ...fcData, nodeId, documentId, fileIndex: index
                });
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
    getGraphData() { return this.query.getGraphData(); }
    exists(rel, derived, isFolder) {
        if (derived) return isFolder ? this.query.getFolderByPath(rel) : this.query.getDocumentByPath(rel);
        return this.files.exists(rel);
    }
}
