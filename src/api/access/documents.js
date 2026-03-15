/**
 * Documents.js
 * The Orchestrator. Coordinates File System, Database, and specialized services.
 */

import path from 'path';
import fs from 'fs';
import Files from './files.js';
import query from './query.js';
import metadataService from './metadata.js';
import srsService from './srs.js';
import db from './database.js';
import crypto from 'crypto';
import os from 'os';
import AdmZip from 'adm-zip';

export default class Documents {
    constructor() {
        this.files = new Files();
        this.query = query;
        this.metadata = metadataService;
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
                this.query.insertFolder({
                    nodeId, globalHash, relativePath: folderRelPath, absolutePath: absPath, name
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
                const table = isFolder ? 'Folders' : 'Documents';
                db.prepare(`UPDATE ${table} SET name = ?, relative_path = ?, absolute_path = ? WHERE absolute_path = ?`)
                  .run(newName, newRelPath, newAbsPath, oldAbsPath);

                if (isFolder) {
                    db.prepare(`UPDATE Documents SET relative_path = replace(relative_path, ?, ?), absolute_path = replace(absolute_path, ?, ?) WHERE absolute_path LIKE ? || '%'`)
                      .run(relativePath, newRelPath, oldAbsPath, newAbsPath, oldAbsPath);
                    db.prepare(`UPDATE Folders SET relative_path = replace(relative_path, ?, ?), absolute_path = replace(absolute_path, ?, ?) WHERE absolute_path LIKE ? || '%'`)
                      .run(relativePath, newRelPath, oldAbsPath, newAbsPath, oldAbsPath);
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
                    db.prepare(`UPDATE Documents SET folder_id = ?, relative_path = ?, absolute_path = ? WHERE absolute_path = ?`)
                      .run(newFolderId, newRelativePath, newAbsPath, oldAbsPath);
                } else {
                    db.prepare(`UPDATE Folders SET relative_path = ?, absolute_path = ? WHERE absolute_path = ?`)
                      .run(newRelativePath, newAbsPath, oldAbsPath);
                    
                    db.prepare(`UPDATE Documents SET relative_path = replace(relative_path, ?, ?), absolute_path = replace(absolute_path, ?, ?) WHERE absolute_path LIKE ? || '%'`)
                      .run(relativePath, newRelativePath, oldAbsPath, newAbsPath, oldAbsPath);
                    db.prepare(`UPDATE Folders SET relative_path = replace(relative_path, ?, ?), absolute_path = replace(absolute_path, ?, ?) WHERE absolute_path LIKE ? || '%'`)
                      .run(relativePath, newRelativePath, oldAbsPath, newAbsPath, oldAbsPath);
                }
            })();
        } catch (err) {
            this.files.move(newRelativePath, relativePath, isFolder);
            throw err;
        }
    }

    async updateFile(relativePath, content, metadata = null) {
        this.files.updateFile(relativePath, content, metadata);

        if (metadata) {
            const doc = this.query.getDocumentByPath(relativePath);
            if (!doc) throw new Error(`Document ${relativePath} not found in DB`);

            db.transaction(() => {
                if (metadata.tags) this._syncTags(doc.node_id, metadata.tags);
                if (metadata.flashcards) this._syncDocumentFlashcards(doc.id, metadata.flashcards);
                
                const folderId = doc.folder_id;
                if (folderId) {
                    const folder = db.prepare('SELECT node_id, absolute_path FROM Folders WHERE id = ?').get(folderId);
                    if (folder) {
                        const folderMeta = this.metadata.getMetadata(folder.absolute_path, true) || {};
                        this._propagateFolderTags(folder.node_id, folder.absolute_path, folderMeta);
                    }
                }
            })();
        }
    }

    async delete(relativePath, isFolder = false) {
        this.files.delete(relativePath, isFolder);
        const table = isFolder ? 'Folders' : 'Documents';
        const absPath = this.files.safePath(relativePath);
        
        db.transaction(() => {
            db.prepare(`DELETE FROM ${table} WHERE absolute_path = ? OR absolute_path LIKE ? || '%'`).run(absPath, absPath + path.sep);
        })();
    }

    // --- Metadata Helpers ---

    async updateMetadata(relativePath, metadata, isFolder = false) {
        this.files.writeMetadata(relativePath, metadata, isFolder);
        const absPath = this.files.safePath(relativePath);

        db.transaction(() => {
            const entity = isFolder ? this.query.getFolderByPath(relativePath) : this.query.getDocumentByPath(relativePath);
            if (!entity) throw new Error(`Entity ${relativePath} not found`);

            if (isFolder) this.query.updateFolderMetadata(entity.id, metadata);
            else this.query.updateDocumentMetadata(entity.id, metadata);

            if (metadata.tags) this._syncTags(entity.node_id, metadata.tags);
            if (!isFolder && metadata.flashcards) this._syncDocumentFlashcards(entity.id, metadata.flashcards);

            if (isFolder) this._propagateFolderTags(entity.node_id, absPath, metadata);
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
        
        if (!fs.existsSync(absPath)) fs.mkdirSync(absPath, { recursive: true });
        
        this.query.insertFolder({
            nodeId, globalHash, relativePath: folderRelPath, absolutePath: absPath, name: folderName
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
                meta.globalHash = globalHash; // Keep the newly generated hash
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
                        this.query.insertFolder({
                            nodeId: subNodeId, globalHash: crypto.randomUUID(), relativePath: entryRel, absolutePath: subAbs, name: entry.name
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
        const meta = this.metadata.getMetadata(relativePath);
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
        const metadata = this.metadata.getMetadata(relativePath);
        const card = metadata.flashcards.find(f => f.globalHash === flashcardHash);
        if (card) {
            card.level = newLevel;
            card.easeFactor = easeFactor;
            card.lastRecall = new Date().toISOString();
            this.metadata.writeMetadata(relativePath, metadata);
        }

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
                nodeId, globalHash: crypto.randomUUID(), relativePath: "", absolutePath: parentDir, name: path.basename(parentDir)
            });
            return info.lastInsertRowid;
        }
        const folder = db.prepare('SELECT id FROM Folders WHERE absolute_path = ?').get(parentDir);
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
                const mergedLevel = (fcData.level > 0) ? fcData.level : (match.level ?? 0);
                const mergedRecall = (fcData.level > 0) ? fcData.lastRecall : (match.last_recall ?? fcData.lastRecall);

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

    _propagateFolderTags(parentNodeId, parentAbsPath, metadata) {
        const childDocs = db.prepare(`SELECT id, node_id, relative_path FROM Documents WHERE folder_id = (SELECT id FROM Folders WHERE node_id = ?)`).all(parentNodeId);
        const childFolders = db.prepare(`SELECT id, node_id, relative_path, absolute_path FROM Folders WHERE absolute_path LIKE ? || ? || '%' AND absolute_path NOT LIKE ? || ? || '%' || ?`).all(parentAbsPath, path.sep, parentAbsPath, path.sep, path.sep);

        const inheritedFromAbove = db.prepare(`
            SELECT t.name FROM InheritedTags it
            JOIN Connections c ON it.connection_id = c.id
            JOIN Tags t ON t.id = it.tag_id
            WHERE c.destiny_id = ? AND c.type_id = (SELECT id FROM ConnectionTypes WHERE name = 'inheritance')
        `).all(parentNodeId).map(t => t.name);

        const myDirectTags = new Set(metadata.tags || []);
        const myExclusions = new Set(metadata.excludedTags || []);
        const effectiveInherited = inheritedFromAbove.filter(t => !myExclusions.has(t));
        const effectiveToChildren = [...new Set([...effectiveInherited, ...myDirectTags])];

        const hierarchyType = db.prepare("SELECT id FROM ConnectionTypes WHERE name = 'inheritance'").get();

        const syncInheritance = (targetNodeId, tagsToInherit) => {
            let conn = db.prepare(`SELECT id FROM Connections WHERE origin_id = ? AND destiny_id = ? AND type_id = ?`).get(parentNodeId, targetNodeId, hierarchyType.id);
            if (!conn) {
                const info = db.prepare(`INSERT INTO Connections (origin_id, destiny_id, type_id) VALUES (?, ?, ?)`).run(parentNodeId, targetNodeId, hierarchyType.id);
                conn = { id: info.lastInsertRowid };
            }
            db.prepare('DELETE FROM InheritedTags WHERE connection_id = ?').run(conn.id);
            const insertInherited = db.prepare('INSERT INTO InheritedTags (connection_id, tag_id) VALUES (?, ?)');
            for (const tagName of tagsToInherit) {
                const tag = this.query.getTagByName(tagName);
                if (tag) insertInherited.run(conn.id, tag.id);
            }
        };

        for (const doc of childDocs) {
            syncInheritance(doc.node_id, effectiveToChildren);
            this._propagateTagsToFlashcards(doc.id, doc.node_id, effectiveToChildren);
        }

        for (const folder of childFolders) {
            syncInheritance(folder.node_id, effectiveToChildren);
            const subMeta = this.metadata.getMetadata(folder.relative_path, true) || {};
            this._propagateFolderTags(folder.node_id, folder.absolute_path, subMeta);
        }
    }

    _propagateTagsToFlashcards(docId, docNodeId, tags) {
        const fcs = db.prepare('SELECT node_id FROM Flashcards WHERE document_id = ?').all(docId);
        const hierarchyType = db.prepare("SELECT id FROM ConnectionTypes WHERE name = 'inheritance'").get();
        for (const fc of fcs) {
            let conn = db.prepare(`SELECT id FROM Connections WHERE origin_id = ? AND destiny_id = ? AND type_id = ?`).get(docNodeId, fc.node_id, hierarchyType.id);
            if (!conn) {
                const info = db.prepare(`INSERT INTO Connections (origin_id, destiny_id, type_id) VALUES (?, ?, ?)`).run(docNodeId, fc.node_id, hierarchyType.id);
                conn = { id: info.lastInsertRowid };
            }
            db.prepare('DELETE FROM InheritedTags WHERE connection_id = ?').run(conn.id);
            const insertInherited = db.prepare('INSERT INTO InheritedTags (connection_id, tag_id) VALUES (?, ?)');
            for (const tagName of tags) {
                const tag = this.query.getTagByName(tagName);
                if (tag) insertInherited.run(conn.id, tag.id);
            }
        }
    }

    propagatePresence(documentId) {
        db.transaction(() => {
            const stats = db.prepare('SELECT AVG(level) as score FROM Flashcards WHERE document_id = ?').get(documentId);
            const score = stats.score || 0;
            db.prepare('UPDATE Documents SET presence = ? WHERE id = ?').run(score, documentId);

            let currentFolderId = db.prepare('SELECT folder_id FROM Documents WHERE id = ?').get(documentId)?.folder_id;
            while (currentFolderId) {
                const folder = db.prepare('SELECT absolute_path FROM Folders WHERE id = ?').get(currentFolderId);
                if (!folder) break;

                const docStats = db.prepare('SELECT count(*) as cnt, sum(presence) as total FROM Documents WHERE folder_id = ?').get(currentFolderId);
                const subFolders = db.prepare('SELECT presence FROM Folders WHERE absolute_path LIKE ? || ? || \'%\' AND absolute_path NOT LIKE ? || ? || \'%\' || ?').all(folder.absolute_path, path.sep, folder.absolute_path, path.sep, path.sep);
                
                const totalCount = (docStats.cnt || 0) + subFolders.length;
                const totalPresence = (docStats.total || 0) + subFolders.reduce((acc, f) => acc + f.presence, 0);
                const avg = totalCount > 0 ? (totalPresence / totalCount) : 0;

                db.prepare('UPDATE Folders SET presence = ? WHERE id = ?').run(avg, currentFolderId);
                
                const parentPath = path.dirname(folder.absolute_path);
                if (parentPath === this.files.workspaceRoot) break;
                currentFolderId = db.prepare('SELECT id FROM Folders WHERE absolute_path = ?').get(parentPath)?.id;
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
