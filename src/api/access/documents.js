/* A bridge for the operations of the flashback canonical data system.
 Default: all file operations are handled inside the flashback directory at userData.
 If the config provides a custom path it will be used instead to mount files elsewhere.

 Some things to be aware of:
 Since the system uses a derived data system, the file reads are done at the document.js level
 The canonical data system is a group of jsons with metadata and a media file at root level of folders check out DATAMODEL.md
 The canonical data makes all writes to the file system, document.js makes all writes to the database and calls  files.js

 Las rutas relativas se resuelven contra el workspaceRoot.
 The metadata of the files is stored as <file>.flashback o <folder>/.flashback
 The globalHash is inmutable after generated, copying a file will generate a new one.
 Insecure operations throw errors to be handled by the UI

*/

import path from 'path';
import fs from 'fs';
import { get as config } from './config.js';
import Files from './files.js';
import db from './database.js';
import crypto from 'crypto';
import AdmZip from 'adm-zip';
import os from 'os';

export default class Documents {
    constructor() {
        this.config = config();
        this.db = db;
        this.files = new Files();
    }

    // ---------- HELPERS ----------

    /**
     * Create a new node of the given type in the database.
     * @param {string} typeString - The name of the node type (e.g. "folder", "document", etc.).
     * @throws {Error} If the node type is missing.
     * @returns {number} The ID of the newly created node.
     */
    _createNode(typeString) {
        const type = this.db.prepare(`SELECT id FROM NodeTypes WHERE name = ?`).get(typeString);
        if (!type) throw new Error(`${typeString} node type missing.`);

        const info = this.db.prepare(`INSERT INTO Nodes (type_id) VALUES (?)`).run(type.id);
        return info.lastInsertRowid;
    }

    /**
     * Gets the ID of the parent folder of the given absolute path.
     * If the absolute path is the root folder, creates a new root folder in the database if it does not already exist.
     * @param {string} absolutePath - The absolute path of the folder or file.
     * @returns {number|null} The ID of the parent folder, or null if the folder does not exist in the database.
     */
    _getParentFolderId(absolutePath) {
        const parentDir = path.dirname(absolutePath);

        // Custom behavior for root folder
        if (parentDir === this.files.workspaceRoot) {
            try {
                const rootFolder = this.db.prepare(`SELECT id FROM Folders WHERE absolute_path = ?`).get(parentDir);
                if (rootFolder) return rootFolder.id;

                console.log("Root folder missing in DB. Creating it now...");

                // Create the Graph Node first
                const nodeId = this._createNode('Folder');

                // Generate metadata for the root
                const globalHash = crypto.randomUUID();
                const rootName = path.basename(parentDir);

                // Insert into Folders table
                const stmt = this.db.prepare(`
                    INSERT INTO Folders 
                    (node_id, global_hash, relative_path, absolute_path, name, presence)
                    VALUES (?, ?, ?, ?, ?, 0)
                `);

                const info = stmt.run(nodeId, globalHash, "", parentDir, rootName);
                console.log("Root folder created successfully.");
                return info.lastInsertRowid;

            } catch (error) {
                console.error("Error creating root folder:", error);
                throw error;
            }
        }

        // Normal behavior for non-root subfolders
        const folder = this.db.prepare(`SELECT id FROM Folders WHERE absolute_path = ?`).get(parentDir);
        return folder ? folder.id : null;
    }

    // ---------- Flashcard / Tag Helpers ----------

    /**
     * Updates a flashcard in the database by its global hash.
     * @param {object} data - An object containing the following properties:
     * - globalHash: The global hash of the flashcard.
     * - lastRecall: The ISO 8601 datetime string of the last recall.
     * - level: The level of the flashcard.
     * - tags: An array of tag names.
     * - category: The category name of the flashcard.
     * - customData: An object containing custom data for the flashcard.
     * - vanillaData: An object containing vanilla data for the flashcard.
     * @throws {Error} If the flashcard with the given global hash does not exist.
     */
    _updateFlashcard(data) {
        const { globalHash, lastRecall, level, tags, category, customData, vanillaData } = data;

        const flashcard = this.db.prepare(`SELECT id, node_id, content_id, reference_id FROM Flashcards WHERE global_hash = ?`).get(globalHash);
        if (!flashcard) throw new Error(`Flashcard with hash ${globalHash} not found.`);

        const transaction = this.db.transaction(() => {
            let categoryId = null;
            if (category) {
                const catRow = this.db.prepare(`SELECT id FROM PedagogicalCategories WHERE name = ?`).get(category);
                if (catRow) categoryId = catRow.id;
            }

            this.db.prepare(`
                UPDATE Flashcards 
                SET last_recall = ?, level = ?, category_id = ?
                WHERE id = ?
            `).run(lastRecall, level, categoryId, flashcard.id);

            // Content Updates
            const contentUpdates = [];
            const contentParams = [];

            if (customData?.html) {
                contentUpdates.push("custom_html = ?");
                contentParams.push(customData.html);
            }

            if (vanillaData) {
                contentUpdates.push("frontText = ?", "backText = ?");
                contentParams.push(vanillaData.frontText || null, vanillaData.backText || null);

                if (vanillaData.media) {
                    contentUpdates.push("front_img = ?", "back_img = ?", "front_sound = ?", "back_sound = ?");
                    contentParams.push(
                        vanillaData.media.frontImg || null, vanillaData.media.backImg || null,
                        vanillaData.media.frontSound || null, vanillaData.media.backSound || null
                    );
                }
            }

            if (contentUpdates.length > 0) {
                const sql = `UPDATE FlashcardContent SET ${contentUpdates.join(", ")} WHERE id = ?`;
                contentParams.push(flashcard.content_id);
                this.db.prepare(sql).run(...contentParams);
            }

            // Reference Updates
            if (vanillaData?.location) {
                const loc = vanillaData.location;
                const d = loc.data || {};
                const bboxJson = d.bbox ? JSON.stringify(d.bbox) : null;

                if (flashcard.reference_id) {
                    this.db.prepare(`
                        UPDATE FlashcardReference 
                        SET type = ?, start = ?, end = ?, page = ?, bbox = ?
                        WHERE id = ?
                    `).run(loc.type, d.start || null, d.end || null, d.page || null, bboxJson, flashcard.reference_id);
                } else {
                    const info = this.db.prepare(`
                        INSERT INTO FlashcardReference (type, start, end, page, bbox)
                        VALUES (?, ?, ?, ?, ?)
                    `).run(loc.type, d.start || null, d.end || null, d.page || null, bboxJson);

                    this.db.prepare(`UPDATE Flashcards SET reference_id = ? WHERE id = ?`).run(info.lastInsertRowid, flashcard.id);
                }
            }

            if (Array.isArray(tags)) {
                this._syncTags(flashcard.node_id, tags);
            }
        });
        transaction();
    }



    /**
     * Creates a flashcard in the database.
     * @param {object} data - Object containing the required flashcard data.
     * @param {number} documentId - The id of the document the flashcard belongs to.
     * @property {string} data.globalHash - Unique hash for the flashcard.
     * @property {string} [data.lastRecall] - Last time the flashcard was recalled.
     * @property {number} [data.level] - Number of consecutive positive recalls.
     * @property {string[]} [data.tags] - Tags associated with the flashcard.
     * @property {string} [data.category] - Pedagogical category of the flashcard.
     * @property {object} [data.customData] - Custom data (html) associated with the flashcard.
     * @property {object} [data.vanillaData] - Vanilla data associated with the flashcard.
     * @property {number} [data.fileIndex] - Index of the flashcard in the file.
     */
    _createFlashcard(data, documentId) {
        const { globalHash, lastRecall, level, tags, category, customData, vanillaData, fileIndex } = data;

        const type = this.db.prepare("SELECT id FROM NodeTypes WHERE name = 'Flashcard'").get();
        const nodeInfo = this.db.prepare("INSERT INTO Nodes (type_id) VALUES (?)").run(type.id);
        const nodeId = nodeInfo.lastInsertRowid;

        let customHtml = customData?.html || null;
        let frontText = null, backText = null, fImg = null, bImg = null, fSnd = null, bSnd = null;

        if (vanillaData) {
            frontText = vanillaData.frontText;
            backText = vanillaData.backText;
            if (vanillaData.media) {
                fImg = vanillaData.media.frontImg; bImg = vanillaData.media.backImg;
                fSnd = vanillaData.media.frontSound; bSnd = vanillaData.media.backSound;
            }
        }

        const contentInfo = this.db.prepare(`
            INSERT INTO FlashcardContent (custom_html, frontText, backText, front_img, back_img, front_sound, back_sound)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(customHtml, frontText, backText, fImg, bImg, fSnd, bSnd);

        let referenceId = null;
        if (vanillaData?.location) {
            const loc = vanillaData.location;
            const d = loc.data || {};
            const bboxJson = d.bbox ? JSON.stringify(d.bbox) : null;
            const refInfo = this.db.prepare(`
                INSERT INTO FlashcardReference (type, start, end, page, bbox) VALUES (?, ?, ?, ?, ?)
            `).run(loc.type, d.start, d.end, d.page, bboxJson);
            referenceId = refInfo.lastInsertRowid;
        }

        let categoryId = null;
        if (category) {
            const cat = this.db.prepare("SELECT id FROM PedagogicalCategories WHERE name = ?").get(category);
            if (cat) categoryId = cat.id;
        }

        this.db.prepare(`
            INSERT INTO Flashcards (global_hash, node_id, document_id, category_id, content_id, reference_id, last_recall, level, fileIndex, presence)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
        `).run(globalHash, nodeId, documentId, categoryId, contentInfo.lastInsertRowid, referenceId, lastRecall, level, fileIndex);

        if (tags && Array.isArray(tags)) this._syncTags(nodeId, tags);
    }

    /**
     * Deletes a flashcard by its id and the id of its associated node.
     * Cascades to deleting the node if DB is set up that way, otherwise manual delete might be needed.
     * Cleans up the associated content/reference if present.
     * @param {number} flashcardId - id of the flashcard to delete
     * @param {number} nodeId - id of the node associated with the flashcard
     */
    _deleteFlashcard(flashcardId, nodeId) {
        const fc = this.db.prepare('SELECT content_id, reference_id FROM Flashcards WHERE id = ?').get(flashcardId);
        this.db.prepare('DELETE FROM Flashcards WHERE id = ?').run(flashcardId);
        this.db.prepare('DELETE FROM Nodes WHERE id = ?').run(nodeId);
        if (fc) {
            if (fc.content_id) this.db.prepare('DELETE FROM FlashcardContent WHERE id = ?').run(fc.content_id);
            if (fc.reference_id) this.db.prepare('DELETE FROM FlashcardReference WHERE id = ?').run(fc.reference_id);
        }
    }


    /**
     * Synchronizes the tags of a flashcard node with the given tag names.
     * Ensures that all given tags exist as tag nodes and are connected to the given node.
     * Removes any connections to tags that are no longer present in the given tag names.
     * @param {number} nodeId - id of the node whose tags should be synced
     * @param {string[]} tagNames - array of tag names to sync
     */
    _syncTags(nodeId, tagNames) {
        // Ensure Tag Nodes exist (NodeType = 'Tag')
        const tagType = this.db.prepare("SELECT id FROM NodeTypes WHERE name = 'Tag'").get();
        // Safety check
        if (!tagType) throw new Error("NodeType 'Tag' missing in DB. Check rebuildDatabase.");

        const targetTagIds = [];

        for (const name of tagNames) {
            let tag = this.db.prepare("SELECT node_id FROM Tags WHERE name = ?").get(name);
            if (!tag) {
                const tNode = this.db.prepare("INSERT INTO Nodes (type_id) VALUES (?)").run(tagType.id);
                this.db.prepare("INSERT INTO Tags (name, node_id, presence) VALUES (?, ?, 0)").run(name, tNode.lastInsertRowid);
                targetTagIds.push(tNode.lastInsertRowid);
            } else {
                targetTagIds.push(tag.node_id);
            }
        }

        // Get Connection Type (ConnectionType = 'tag')
        // CHANGED: 'Association' -> 'tag'
        const connType = this.db.prepare("SELECT id FROM ConnectionTypes WHERE name = 'tag'").get();
        if (!connType) throw new Error("ConnectionType 'tag' missing in DB.");

        const currentConns = this.db.prepare(`
            SELECT c.id, c.destiny_id FROM Connections c 
            JOIN Nodes n ON c.destiny_id = n.id 
            WHERE c.origin_id = ? AND n.type_id = ? AND c.type_id = ?
        `).all(nodeId, tagType.id, connType.id);

        const currentTagIds = currentConns.map(c => c.destiny_id);

        for (const tid of targetTagIds) {
            if (!currentTagIds.includes(tid)) {
                this.db.prepare("INSERT INTO Connections (origin_id, destiny_id, type_id) VALUES (?, ?, ?)").run(nodeId, tid, connType.id);
            }
        }
        for (const conn of currentConns) {
            if (!targetTagIds.includes(conn.destiny_id)) {
                this.db.prepare("DELETE FROM Connections WHERE id = ?").run(conn.id);
            }
        }
    }

    /**
     * Synchronizes the flashcards of a document with the given data.
     * It does so by iterating over the given data and either updating an existing flashcard or creating a new one.
     * The algorithm works as follows:
     * 1. Find all the existing flashcards associated with the document.
     * 2. Create a map of the existing flashcards for quick lookups.
     * 3. Iterate over the given data and update/create the flashcards accordingly.
     * 4. Delete any flashcards that are no longer present in the given data.
     * @param {number} documentId - id of the document whose flashcards should be synced
     * @param {object[]} flashcardsData - array of objects containing the data for each flashcard
     */
    _syncDocumentFlashcards(documentId, flashcardsData) {
        if (!Array.isArray(flashcardsData)) return;
        const existingRows = this.db.prepare('SELECT id, node_id, global_hash, level, last_recall FROM Flashcards WHERE document_id = ?').all(documentId);
        const existingMap = new Map(existingRows.map(r => [r.global_hash, r]));
        const incomingHashes = new Set();

        flashcardsData.forEach((fcData, index) => {
            fcData.fileIndex = index;
            incomingHashes.add(fcData.globalHash);
            
            const existing = existingMap.get(fcData.globalHash);
            if (existing) {
                // Determine merged level: 
                // If incoming has progress (level > 0), use it (allows updates from files).
                // Otherwise, preserve existing DB progress.
                const mergedLevel = (fcData.level > 0) ? fcData.level : (existing.level ?? 0);
                const mergedRecall = (fcData.level > 0) ? fcData.lastRecall : (existing.last_recall ?? fcData.lastRecall);

                const mergedData = {
                    ...fcData,
                    level: mergedLevel,
                    lastRecall: mergedRecall
                };
                
                this._updateFlashcard(mergedData);
                this.db.prepare('UPDATE Flashcards SET fileIndex = ? WHERE global_hash = ?').run(index, fcData.globalHash);
            } else {
                this._createFlashcard(fcData, documentId);
            }
        });

        for (const [hash, row] of existingMap) {
            if (!incomingHashes.has(hash)) this._deleteFlashcard(row.id, row.node_id);
        }
    }


    /**
     * Recursively propagates tags from a parent folder to its children (documents and subfolders).
     * The algorithm works as follows:
     * 1. Find all children (documents and subfolders) of the given parent.
     * 2. Read the metadata of each child to check for excluded tags.
     * 3. Calculate the effective tags for each child by combining the inherited tags from the parent and the child's direct tags.
     * 4. Ensure that the hierarchy connection exists between the parent and each child.
     * 5. Update the InheritedTags table for the given connection.
     * 6. Recurse into the children (if they are folders) or propagate the tags to their flashcards (if they are documents).
     * @param {number} parentNodeId - The node ID of the parent folder.
     * @param {string} parentAbsPath - The absolute path of the parent folder.
     * @param {Set<string>} parentEffectiveTags - The effective tags of the parent folder.
     */
    _propagateTags(parentNodeId, parentAbsPath, parentEffectiveTags) {
        const childDocs = this.db.prepare(`SELECT id, node_id, relative_path, absolute_path FROM Documents WHERE folder_id = (SELECT id FROM Folders WHERE node_id = ?)`).all(parentNodeId);
        const childFolders = this.db.prepare(`
            SELECT id, node_id, relative_path, absolute_path FROM Folders 
            WHERE absolute_path LIKE ? || ? || '%' AND substr(absolute_path, length(?) + 2) NOT LIKE '%` + path.sep + `%'
        `).all(parentAbsPath, path.sep, parentAbsPath);

        const children = [...childDocs.map(d => ({ ...d, type: 'Document' })), ...childFolders.map(f => ({ ...f, type: 'Folder' }))];
        const hierarchyType = this.db.prepare("SELECT id FROM ConnectionTypes WHERE name = 'inheritance'").get();
        if (!hierarchyType) throw new Error("inheritance ConnectionType missing in DB");
        const tagMap = new Map();

        for (const child of children) {
            const meta = this.files.getMetadata(child.relative_path, child.type === 'Folder');
            const excluded = new Set(meta?.excludedTags || []);
            const childDirectTags = new Set(meta?.tags || []);
            const inherited = parentEffectiveTags.filter(t => !excluded.has(t));
            const effective = [...new Set([...inherited, ...childDirectTags])];

            let conn = this.db.prepare(`SELECT id FROM Connections WHERE origin_id = ? AND destiny_id = ? AND type_id = ?`).get(parentNodeId, child.node_id, hierarchyType.id);
            if (!conn) {
                const info = this.db.prepare(`INSERT INTO Connections (origin_id, destiny_id, type_id) VALUES (?, ?, ?)`).run(parentNodeId, child.node_id, hierarchyType.id);
                conn = { id: info.lastInsertRowid };
            }

            this.db.prepare('DELETE FROM InheritedTags WHERE connection_id = ?').run(conn.id);
            const insertInherited = this.db.prepare('INSERT INTO InheritedTags (connection_id, tag_id) VALUES (?, ?)');

            for (const tagName of inherited) {
                let tagId = tagMap.get(tagName);
                if (!tagId) {
                    const t = this.db.prepare('SELECT id FROM Tags WHERE name = ?').get(tagName);
                    if (t) { tagId = t.id; tagMap.set(tagName, tagId); }
                }
                if (tagId) insertInherited.run(conn.id, tagId);
            }

            if (child.type === 'Folder') {
                this._propagateTags(child.node_id, child.absolute_path, effective);
            } else {
                this._propagateTagsToFlashcards(child.id, child.node_id, effective);
            }
        }
    }

    /**
     * Propagates the effective tags of a document to its flashcards.
     * This function is necessary to maintain the correctness of the InheritedTags table.
     * It is called after a document's tags have been updated.
     * @param {number} docId - The id of the document whose tags should be propagated.
     * @param {number} docNodeId - The node id of the document.
     * @param {string[]} docEffectiveTags - The effective tags of the document.
     */
    _propagateTagsToFlashcards(docId, docNodeId, docEffectiveTags) {
        const flashcards = this.db.prepare('SELECT id, node_id FROM Flashcards WHERE document_id = ?').all(docId);
        const hierarchyType = this.db.prepare("SELECT id FROM ConnectionTypes WHERE name = 'inheritance'").get();

        for (const fc of flashcards) {
            let conn = this.db.prepare(`SELECT id FROM Connections WHERE origin_id = ? AND destiny_id = ? AND type_id = ?`).get(docNodeId, fc.node_id, hierarchyType.id);
            if (!conn) {
                const info = this.db.prepare(`INSERT INTO Connections (origin_id, destiny_id, type_id) VALUES (?, ?, ?)`).run(docNodeId, fc.node_id, hierarchyType.id);
                conn = { id: info.lastInsertRowid };
            }
            this.db.prepare('DELETE FROM InheritedTags WHERE connection_id = ?').run(conn.id);
            const insertInherited = this.db.prepare('INSERT INTO InheritedTags (connection_id, tag_id) VALUES (?, ?)');
            for (const tagName of docEffectiveTags) {
                const t = this.db.prepare('SELECT id FROM Tags WHERE name = ?').get(tagName);
                if (t) insertInherited.run(conn.id, t.id);
            }
        }
    }

    /**
     * Updates the presence of all tags associated with the given document.
     * The presence of a tag is calculated as the average level of all flashcards associated with the document that contain the tag.
     * If no flashcards contain the tag, the presence is set to 0.
     * @param {number} documentId - The id of the document for which to update the tag presence.
     */
    _updateTagPresence(documentId) {
        const docNode = this.db.prepare('SELECT node_id FROM Documents WHERE id = ?').get(documentId);
        if (!docNode) return;

        const relevantTagIds = this.db.prepare(`
            SELECT destiny_id as node_id FROM Connections WHERE origin_id = ? 
            UNION SELECT origin_id as node_id FROM Connections WHERE destiny_id = ?
        `).all(docNode.node_id, docNode.node_id).map(x => x.node_id);

        const flashcardTags = this.db.prepare(`
            SELECT t.node_id FROM Tags t
            JOIN Connections c ON c.destiny_id = t.node_id
            JOIN Flashcards f ON f.node_id = c.origin_id
            WHERE f.document_id = ?
        `).all(documentId).map(x => x.node_id);

        const uniqueTagNodeIds = [...new Set([...relevantTagIds, ...flashcardTags])];

        for (const tagNodeId of uniqueTagNodeIds) {
            const stats = this.db.prepare(`
                SELECT AVG(f.level) as score FROM Flashcards f
                JOIN Nodes n ON f.node_id = n.id
                WHERE EXISTS (SELECT 1 FROM Connections c WHERE c.origin_id = n.id AND c.destiny_id = ?)
                OR EXISTS (
                    SELECT 1 FROM Connections c JOIN InheritedTags it ON it.connection_id = c.id
                    JOIN Tags t ON t.id = it.tag_id WHERE c.destiny_id = n.id AND t.node_id = ?
                )
            `).get(tagNodeId, tagNodeId);
            const score = stats.score || 0;
            this.db.prepare('UPDATE Tags SET presence = ? WHERE node_id = ?').run(score, tagNodeId);
        }
    }

    /**
     * Checks if a file or folder exists at the given relative path.
     * If derived is true, checks in the database instead of the file system.
     * If isFolder is true, checks if a folder exists at the given relative path.
     * If isFolder is false, checks if a file exists at the given relative path.
     * @param {string} relativePath - The relative path to check for existence.
     * @param {boolean} [derived=false] - Whether to check in the database or the file system.
     * @param {boolean} [isFolder=false] - Whether to check for a folder or a file.
     * @returns {object|null} The result of the check, or null if the item does not exist.
     */
    exists(relativePath, derived = false, isFolder = false) {
        if (derived) {
            const table = isFolder ? 'Folders' : 'Documents';
            return this.db.prepare(`SELECT id, name, global_hash FROM ${table} WHERE relative_path = ?`).get(relativePath);
        }
        return this.files.exists(relativePath);
    }


    // ---------- File operations ----------

    /**
     * Creates a new file with the given name at the given relative path.
     * If the given relative path is empty, the file is created at the root of the workspace.
     * The file is created with empty contents.
     * The file's metadata is created and written to the file system.
     * The globalHash of the created file is returned.
     * @param {string} name - The name of the file to create.
     * @param {string} [relativePath=""] - The relative path to create the file in.
     * @throws {Error} If there is an error while creating the file or its metadata.
     * @returns {string} The globalHash of the created file.
     */
    createFile(name, relativePath = "") {
        let globalHash = null;
        const fileRelPath = path.join(relativePath, name);

        try {
            // Canonical
            try {
                globalHash = this.files.createFile(relativePath, name);
            } catch (error) {
                console.error("Error creating file on canonical file system:", error);
                throw error;
            }

            // Derived
            try {
                const absolutePath = this.files.safePath(fileRelPath);

                // Transaction to ensure atomicity
                const createDocumentTransaction = this.db.transaction(() => {
                    // Create Node
                    const nodeId = this._createNode('Document');

                    // Find Parent Folder
                    const folderId = this._getParentFolderId(absolutePath);

                    // Insert Document
                    this.db.prepare(`
                    INSERT INTO Documents 
                    (folder_id, node_id, global_hash, relative_path, absolute_path, name, presence)
                    VALUES (?, ?, ?, ?, ?, ?, 0)
                `).run(folderId, nodeId, globalHash, fileRelPath, absolutePath, name);
                });
                createDocumentTransaction();
                console.log("Document created successfully:", name);

            } catch (dbError) {
                console.error("Error updating database. Initiating rollback...", dbError);

                try {
                    // Delete the created file along with its metadata sidecar
                    this.files.delete(fileRelPath, false);
                    console.log("Rollback successful: File deleted.");
                } catch (fsError) {
                    console.error("CRITICAL: Rollback failed. Orphaned file at:", fileRelPath, fsError);
                    throw fsError;
                }
                throw dbError;
            }

        } catch (error) {
            console.error("Error in createFile orchestrator:", error);
            throw error;
        }
    }

    /**
     * Creates a new folder with the given name at the given relative path.
     * If the folder already exists at the given relative path, an error is thrown.
     * The folder is created with empty contents.
     * The folder's metadata is created and written to the file system.
     * The globalHash of the created folder is returned.
     * @param {string} name - The name of the folder to create.
     * @param {string} [relativePath=""] - The relative path to create the folder in.
     * @returns {string} The globalHash of the created folder.
     * @throws {Error} If the folder already exists at the given relative path.
     */
    createFolder(name, relativePath = "") {
        let globalHash = null;
        const folderRelPath = path.join(relativePath, name);
        try {
            // Canonical
            try {
                globalHash = this.files.createFolder(relativePath, name);
            } catch (error) {
                console.error("Canonical createFolder failed:", error);
                throw error;
            }
            // Derived
            try {
                const absolutePath = this.files.safePath(folderRelPath);
                const createTransaction = this.db.transaction(() => {
                    // Create Node
                    const nodeId = this._createNode('Folder');
                    // Insert Folder
                    this.db.prepare(`
                    INSERT INTO Folders 
                    (node_id, global_hash, relative_path, absolute_path, name, presence)
                    VALUES (?, ?, ?, ?, ?, 0)
                `).run(nodeId, globalHash, folderRelPath, absolutePath, name);
                    console.log("Folder created successfully:", name);
                })
                createTransaction();
                console.log("Document created successfully:", name);

            } catch (dbError) {
                console.error("Error updating database. Initiating rollback...", dbError);
                try {
                    this.files.delete(folderRelPath, true);
                    console.log("Rollback successful: Folder deleted.");
                } catch (fsError) {
                    console.error("CRITICAL: Rollback failed. Orphaned file at:", folderRelPath, fsError);
                    throw fsError;
                }
                throw dbError;
            }
        } catch (error) {
            console.error("Error in createFolder orchestrator:", error);
        }
    }

    /**
     * Renames a file or folder at the given relative path to the given new name.
     * If the item does not exist at the given relative path, an error is thrown.
     * If the item already exists at the given relative path with the new name, an error is thrown.
     * The item's metadata is updated to reflect the new name, if applicable.
     * The item's identifier is updated to reflect the new name, if applicable.
     * @param {string} relativePath - The relative path to the item to rename.
     * @param {string} newName - The new name for the item.
     * @param {boolean} [isFolder=false] - Whether the item is a folder or not.
     * @throws {Error} If the item does not exist at the given relative path.
     * @throws {Error} If the item already exists at the given relative path with the new name.
     */
    rename(relativePath, newName, isFolder = false) {
        try {
            const oldAbsPath = this.files.safePath(relativePath);
            const oldName = path.basename(relativePath);

            // Canonical
            try { this.files.rename(relativePath, newName, isFolder); }
            catch (fsError) { console.error("Canonical rename failed:", fsError); throw fsError; }
            // Derived
            try {
                const parentDir = path.dirname(relativePath);
                const newRelPath = path.join(parentDir, newName);
                const newAbsPath = this.files.safePath(newRelPath);
                const table = isFolder ? 'Folders' : 'Documents';

                const updateNameTransaction = this.db.transaction(() => {
                    this.db.prepare(`
                UPDATE ${table} SET name = ?, relative_path = ?, absolute_path = ? WHERE absolute_path = ?
                `).run(newName, newRelPath, newAbsPath, oldAbsPath)

                })
                updateNameTransaction();
                console.log('Name updated successfully:', newName);

                // Update children
                if (isFolder) {
                    const updateChildrenTransaction = this.db.transaction(() => {
                        // Update Documents inside this folder
                        this.db.prepare(`
                    UPDATE Documents 
                    SET relative_path = replace(relative_path, ?, ?),
                        absolute_path = replace(absolute_path, ?, ?)
                    WHERE absolute_path LIKE ? || '%'
                 `).run(relativePath, newRelPath, oldAbsPath, newAbsPath, oldAbsPath);

                        // Update Sub-Folders inside this folder
                        this.db.prepare(`
                    UPDATE Folders
                    SET relative_path = replace(relative_path, ?, ?),
                        absolute_path = replace(absolute_path, ?, ?)
                    WHERE absolute_path LIKE ? || '%'
                 `).run(relativePath, newRelPath, oldAbsPath, newAbsPath, oldAbsPath);
                    })
                    updateChildrenTransaction();
                    console.log('Children paths updated successfully');
                }
            } catch (dbError) {
                console.error("Error updating database. Initiating rollback...", dbError);
                try {
                    this.files.rename(oldName, newRelPath, isFolder);
                }
                catch (fsError) {
                    console.error("CRITICAL: Rollback failed. Orphaned file at:", relativePath, fsError);
                }
                throw dbError;
            }
        } catch (error) {
            console.error("Error renaming:", error);
        }
    }

    /**
     * Moves a file or folder from the given relative path to the given new relative path.
     * If the item does not exist at the given relative path, an error is thrown.
     * If the item already exists at the given relative path with the new name, an error is thrown.
     * The item's metadata is updated to reflect the new path, if applicable.
     * The item's identifier is updated to reflect the new path, if applicable.
     * @param {string} relativePath - The relative path to the item to move.
     * @param {string} newRelativePath - The new relative path to move the item to.
     * @param {boolean} [isFolder=false] - Whether the item is a folder or not.
     * @throws {Error} If the item does not exist at the given relative path.
     * @throws {Error} If the item already exists at the given relative path with the new name.
     */
    move(relativePath, newRelativePath, isFolder = false) {
        try {
            const oldAbsPath = this.files.safePath(relativePath);
            // Canonical
            try { this.files.move(relativePath, newRelativePath, isFolder); } catch (fsError) {
                console.error("Canonical move failed:", fsError);
                throw fsError;
            }
            // Derived
            try {
                const moveTransaction = this.db.transaction(() => {
                    const newAbsPath = this.files.safePath(newRelativePath);
                    // Calculate new parent id for Documents
                    let newFolderId = null;
                    // File 
                    if (!isFolder) {
                        newFolderId = this._getParentFolderId(newAbsPath);
                    }
                    // Update the moved item
                    if (!isFolder) {
                        const stmt = this.db.prepare(`
                    UPDATE Documents
                    SET folder_id = ?, relative_path = ?, absolute_path = ?
                    WHERE absolute_path = ?
                `);
                        stmt.run(newFolderId, newRelativePath, newAbsPath, oldAbsPath);
                    } else {
                        // Folder
                        const stmt = this.db.prepare(`
                    UPDATE Folders
                    SET relative_path = ?, absolute_path = ?
                    WHERE absolute_path = ?
                `);
                        stmt.run(newRelativePath, newAbsPath, oldAbsPath);

                        // Cascade update children paths (similar to rename)
                        this.db.prepare(`UPDATE Documents SET relative_path = replace(relative_path, ?, ?), absolute_path = replace(absolute_path, ?, ?) WHERE absolute_path LIKE ? || '%'`).run(relativePath, newRelativePath, oldAbsPath, newAbsPath, oldAbsPath);
                        this.db.prepare(` UPDATE Folders SET relative_path = replace(relative_path, ?, ?), absolute_path = replace(absolute_path, ?, ?) WHERE absolute_path LIKE ? || '%'`).run(relativePath, newRelativePath, oldAbsPath, newAbsPath, oldAbsPath);
                    }
                })
                moveTransaction();
            } catch (dbError) {
                console.error("Error updating database. Initiating rollback...", dbError);
                try { this.files.move(newRelativePath, relativePath, isFolder); }
                catch (fsError) { console.error("CRITICAL: Rollback failed. Orphaned file at:", newRelativePath, fsError); }
                throw dbError;
            }
        } catch (error) { console.error("Error moving:", error); }
    }

    /**
     * Deletes a file or folder from the given relative path.
     * If the item does not exist at the given relative path, an error is thrown.
     * @param {string} relPath - The relative path to the item to delete.
     * @param {boolean} [isFolder=false] - Whether the item is a folder or not.
     * @throws {Error} If the item does not exist at the given relative path.
     */
    delete(relativePath, isFolder = false) {
        try {
            const absPath = this.files.safePath(relativePath);
            try { this.files.delete(relativePath, isFolder); }
            catch (fsError) { console.error("Canonical delete failed:", fsError); throw fsError; }

            try {
                const deleteTransaction = this.db.transaction(() => {
                    const table = isFolder ? 'Folders' : 'Documents';
                    const absPath = this.files.safePath(relativePath);
                    // Cascade Handles children, Triggers handle Nodes/Content
                    this.db.prepare(`DELETE FROM ${table} WHERE absolute_path = ? OR absolute_path LIKE ? || '%'`).run(absPath, absPath + path.sep);
                    console.log(`Derived delete complete.`);
                });
                deleteTransaction();
            } catch (dbError) {
                console.error("CRITICAL: Error deleting from database.", dbError);
                throw dbError;
            }
        } catch (error) { console.error("Error deleting:", error); throw error; }
    }

    /**
     * Copies a file or folder from the given relative path to a new relative path.
     * If the item does not exist at the given relative path, an error is thrown.
     * If the item already exists at the given new relative path, an error is thrown.
     * If the item is a folder, all its children are also copied.
     * The globalHash of the copied item is returned.
     * @param {string} relPath - The relative path to the item to copy.
     * @param {string} newRelPath - The new relative path to copy the item to.
     * @param {boolean} [isFolder=false] - Whether the item is a folder or not.
     * @returns {string} The globalHash of the copied item.
     * @throws {Error} If the item does not exist at the given relative path.
     * @throws {Error} If the item already exists at the given new relative path.
     */
    copy(relativePath, newRelativePath, isFolder = false) {
        let newItems = [];
        try {
            // Canonical
            try {
                // Copy and get list of ALL new items (re-hashed)
                newItems = this.files.copy(relativePath, newRelativePath, isFolder);
            } catch (fsError) {
                console.error("Canonical copy failed. Aborting DB copy.", fsError);
                throw fsError;
            }

            // Derived
            try {
                if (newItems && newItems.length > 0) {
                    const copyTransaction = this.db.transaction(() => {

                        // Ensuring folders are processed before their children.
                        newItems.sort((a, b) => a.absolutePath.length - b.absolutePath.length);
                        // Cache for folder IDs created in this transaction
                        // Map<AbsolutePath, FolderID>
                        const folderIdCache = new Map();
                        for (const item of newItems) {
                            // Create Graph Node
                            const nodeType = item.type === 'folder' ? 'Folder' : 'Document';
                            const nodeId = this._createNode(nodeType);

                            if (item.type === 'folder') {
                                // Insert Folder
                                const info = this.db.prepare(`
                                INSERT INTO Folders 
                                (node_id, global_hash, relative_path, absolute_path, name, presence)
                                VALUES (?, ?, ?, ?, ?, 0)
                            `).run(nodeId, item.globalHash, item.relativePath, item.absolutePath, item.name);;
                                // Cache ID for children to use
                                folderIdCache.set(item.absolutePath, info.lastInsertRowid);
                            } else {
                                // Insert Document
                                // Find parent folder ID and check cache first (for parents created in this specific copy operation)
                                const parentPath = path.dirname(item.absolutePath);
                                let folderId = folderIdCache.get(parentPath);

                                // If not in cache, check DB (it might be the root of the copy target)
                                if (!folderId) { folderId = this._getParentFolderId(item.absolutePath); }

                                this.db.prepare(`
                                INSERT INTO Documents 
                                (folder_id, node_id, global_hash, relative_path, absolute_path, name, presence)
                                VALUES (?, ?, ?, ?, ?, ?, 0)
                            `).run(folderId, nodeId, item.globalHash, item.relativePath, item.absolutePath, item.name);
                            }
                        }
                    });

                    copyTransaction();
                    console.log(`Copy successful. Created ${newItems.length} new items.`);
                }
            } catch (dbError) {
                console.error("CRITICAL: Error copying info to database. Rolling back...", dbError);
                try { if (newItems.length > 0) this.delete(newItems[0].relativePath); } catch (fsError) { console.error("Error rolling back:", fsError); }
                throw dbError;
            }
        } catch (error) { console.error("Error copying:", error); throw error; }
    }

    /**
     * Updates the content of a file at the given relative path.
     * If the file does not exist at the given relative path, an error is thrown.
     * If the given metadata is not null, the file's metadata is updated with the new values.
     * If the existing metadata has a globalHash, it is preserved in the new metadata.
     * @param {string} relPath - The relative path to the file to update.
     * @param {string} content - The new content of the file.
     * @param {object} [metadata=null] - The new metadata for the file.
     * @param {string} [encoding="utf-8"] - The encoding to use when writing the file.
     * @throws {Error} If the file does not exist at the given relative path.
     * @throws {Error} If there is an error while updating the file or its metadata.
     */
    updateFile(relativePath, content, metadata = null, encoding = "utf-8") {
        // Variables to hold state for potential rollback
        let originalContent = null;
        let originalMetadata = null;
        let fileExists = false;

        try {
            // Preparation: Cache Original State
            try {
                fileExists = this.files.exists(relativePath);
                if (fileExists) {
                    // Assuming files.readFile returns { content: ... }
                    const readResult = this.files.readFile(relativePath, encoding);
                    originalContent = readResult.content;
                    originalMetadata = this.files.getMetadata(relativePath);
                }
            } catch (readError) {
                console.warn("Warning: Could not read original file for rollback protection.", readError);
                throw readError;
            }

            // Update File System
            try {
                this.files.updateFile(relativePath, content, metadata, encoding);
            } catch (fsError) {
                console.error("Error updating file on disk:", fsError);
                throw fsError;
            }

            // Derived: 
            if (metadata) {
                try {
                    const absPath = this.files.safePath(relativePath);
                    const updateTransaction = this.db.transaction(() => {
                        // Get the Parent Document
                        const doc = this.db.prepare('SELECT id, node_id FROM Documents WHERE absolute_path = ?').get(absPath);
                        if (!doc) throw new Error(`Document not found for path: ${absPath}`);

                        if (metadata.tags) this._syncTags(doc.node_id, metadata.tags);
                        if (metadata.flashcards) this._syncDocumentFlashcards(doc.id, metadata.flashcards);
                    });

                    updateTransaction();
                    console.log("Derived data synced successfully.");

                } catch (dbError) {
                    console.error("Error updating derived data. Initiating rollback...", dbError);
                    try { if (fileExists && originalContent !== null) this.files.updateFile(relativePath, originalContent, originalMetadata, encoding); }
                    catch (rollbackError) { console.error("CRITICAL: Rollback failed.", rollbackError); }
                    throw dbError;
                }
            } else {
                console.log("File content updated. No metadata provided, skipping deep sync.");
            }
        } catch (error) { console.error("Error in updateFile orchestrator:", error); throw error; }
    }



    /**
     * Updates the metadata of a file or folder at the given relative path.
     * If the file does not exist at the given relative path, an error is thrown.
     * If the given metadata is not null, the file's metadata is updated with the new values.
     * If the existing metadata has a globalHash, it is preserved in the new metadata.
     * Tags are also updated for the target node.
     * If the target is a folder, the tags are propagated to its children.
     * @param {string} relPath - The relative path to the file/folder to update.
     * @param {object} metadata - The new metadata for the file/folder.
     * @param {boolean} [isFolder=false] - Whether the target is a file (false) or folder (true).
     * @throws {Error} If the file does not exist at the given relative path.
     * @throws {Error} If there is an error while updating the file/folder's metadata.
     */
    updateMetadata(relativePath, metadata, isFolder = false) {
        try {
            this.files.writeMetadata(relativePath, metadata, isFolder);
            const absPath = this.files.safePath(relativePath);

            const transaction = this.db.transaction(() => {
                const table = isFolder ? 'Folders' : 'Documents';

                const entity = this.db.prepare(`SELECT id, node_id, global_hash FROM ${table} WHERE absolute_path = ?`).get(absPath);

                if (!entity) throw new Error(`${table} entry not found for ${absPath}`);

                if (metadata.globalHash && metadata.globalHash !== entity.global_hash) {
                    this.db.prepare(`UPDATE ${table} SET global_hash = ? WHERE id = ?`).run(metadata.globalHash, entity.id);
                }

                if (metadata.tags && Array.isArray(metadata.tags)) this._syncTags(entity.node_id, metadata.tags);
                if (!isFolder && metadata.flashcards) this._syncDocumentFlashcards(entity.id, metadata.flashcards);

                if (isFolder) {
                    const inheritedFromParent = this.db.prepare(`
                        SELECT t.name FROM InheritedTags it
                        JOIN Connections c ON it.connection_id = c.id
                        JOIN Tags t ON t.id = it.tag_id
                        WHERE c.destiny_id = ? AND c.type_id = (SELECT id FROM ConnectionTypes WHERE name = 'inheritance')
                    `).all(entity.node_id).map(t => t.name);

                    const myExclusions = new Set(metadata.excludedTags || []);
                    const myDirectTags = new Set(metadata.tags || []);
                    const keptInherited = inheritedFromParent.filter(t => !myExclusions.has(t));
                    const effectiveTags = [...new Set([...keptInherited, ...myDirectTags])];

                    this._propagateTags(entity.node_id, absPath, effectiveTags);
                }
            });
            transaction();
            console.log(`Metadata full-scale update complete for ${relativePath}`);
        } catch (error) { console.error("Error updating metadata:", error); throw error; }
    }

    /**
     * Imports a file from the given relative path with the given name and content.
     * The file is created with the given content and the given metadata.
     * If the file already exists at the given relative path, an error is thrown.
     * The globalHash of the created file is returned.
     * @param {string} name - The name of the file to import.
     * @param {string} relativePath - The relative path to import the file to.
     * @param {string} content - The content of the file to import.
     * @param {object} metadata - The metadata of the file to import.
     * @param {string} [encoding="utf-8"] - The encoding to use when writing the file.
     * @throws {Error} If the file already exists at the given relative path.
     * @throws {Error} If there is an error while importing the file.
     * @returns {string} The globalHash of the imported file.
     */
    importFile(name, relativePath, content, metadata, encoding = "utf-8") {
        const fileRelPath = path.join(relativePath, name);
        let globalHash = null;

        try {
            // Canonical
            try {
                // Create Empty File Reserves Name and id
                globalHash = this.files.createFile(relativePath, name);
            } catch (fsError) {
                console.error("Import failed: Could not create file:", fsError);
                throw fsError;
            }

            try {
                // This writes the content and the .flashback metadata file to disk
                this.files.updateFile(fileRelPath, content, metadata, encoding);
            } catch (writeError) {
                console.error("Import failed: Could not write content. Rolling back...", writeError);
                this.files.delete(fileRelPath, false); // Rollback: Delete the empty file
                throw writeError;
            }

            // Derived
            try {
                const absolutePath = this.files.safePath(fileRelPath);

                const importTransaction = this.db.transaction(() => {
                    // Create Document Node & Entry
                    const nodeId = this._createNode('Document');
                    const folderId = this._getParentFolderId(absolutePath);

                    const docInfo = this.db.prepare(`
                        INSERT INTO Documents 
                        (folder_id, node_id, global_hash, relative_path, absolute_path, name, presence)
                        VALUES (?, ?, ?, ?, ?, ?, 0)
                    `).run(folderId, nodeId, globalHash, fileRelPath, absolutePath, name);

                    const documentId = docInfo.lastInsertRowid;

                    // Sync Metadata 
                    if (metadata) {
                        if (metadata.tags) this._syncTags(nodeId, metadata.tags);
                        if (metadata.flashcards) this._syncDocumentFlashcards(documentId, metadata.flashcards);
                    }
                });

                importTransaction();
                console.log("File imported and synced successfully:", name);
            } catch (dbError) {
                console.error("Import failed: Database error. Rolling back...", dbError);
                this.files.delete(fileRelPath, false); // Rollback: Delete the file & metadata
                throw dbError;
            }
        } catch (error) { console.error("Error in importFile orchestrator:", error); throw error; }

    }
    /**
         * EXPORT PACKAGE
         * Zips a folder from the workspace to a temporary file for export.
         * The zip file will contain the folder itself as the root element.
         * @param {string} relativePath - The relative path of the folder to export.
         * @returns {string} - The absolute path to the generated zip file.
         */
    exportPackage(relativePath) {
        // 1. Resolve and Validate Path
        const sourcePath = this.files.safePath(relativePath);

        if (!fs.existsSync(sourcePath)) {
            throw new Error(`Export failed: Path not found - ${relativePath}`);
        }

        const stats = fs.statSync(sourcePath);
        if (!stats.isDirectory()) {
            throw new Error(`Export failed: Can only export folders as packages.`);
        }

        // 2. Initialize Zip
        const zip = new AdmZip();
        // We use the folder name as the zip root so extracting it keeps files contained
        const folderName = path.basename(sourcePath) || "Backup";

        // 3. Add content
        // addLocalFolder(localPath, zipPath) puts the contents of localPath into zipPath inside the archive
        zip.addLocalFolder(sourcePath, folderName);

        // 4. Save to Temp
        const tempDir = os.tmpdir();
        // Format: FolderName_Export_Timestamp.zip
        const zipFileName = `${folderName}_Export_${Date.now()}.zip`;
        const zipFilePath = path.join(tempDir, zipFileName);

        try {
            zip.writeZip(zipFilePath);
            console.log(`Exported package '${folderName}' to ${zipFilePath}`);
            return zipFilePath;
        } catch (error) {
            console.error("Failed to write export zip:", error);
            throw error;
        }
    }
    /**
     * Imports a course package from an external directory.
     * Recursively copies the structure, sanitizes learning data, and registers everything in the database.
     * @param {string} externalPath - The absolute path to the source folder.
     * @param {string} [targetRelPath=""] - The destination relative path in the workspace.
     */
    importPackage(externalPath, targetRelPath = "") {
        // Ensure source exists
        if (!fs.existsSync(externalPath)) throw new Error(`Source path not found: ${externalPath}`);

        // Define root name and create it
        const folderName = path.basename(externalPath);

        // We rely on createFolder to handle the root creation (and it creates a new hash)
        try {
            this.createFolder(folderName, targetRelPath);
        } catch (e) {
            // If it exists, we rethrow for now as safe default.
            throw e;
        }

        const newRootRel = path.join(targetRelPath, folderName);

        // Apply Metadata for Root if exists
        const rootMetaPath = path.join(externalPath, ".flashback");
        if (fs.existsSync(rootMetaPath)) {
            try {
                const raw = fs.readFileSync(rootMetaPath, 'utf-8');
                const meta = JSON.parse(raw);

                // Sanitize Root
                delete meta.lastRecall;
                delete meta.level;
                delete meta.easeFactor;
                meta.presence = 0;

                // Keep the NEW hash generated by createFolder
                const currentMeta = this.files.getMetadata(newRootRel, true);
                if (currentMeta) meta.globalHash = currentMeta.globalHash;

                this.updateMetadata(newRootRel, meta, true);
            } catch (err) {
                console.warn("Failed to import root metadata:", err);
            }
        }

        // Helper to crawl
        const crawl = (src, destRel) => {
            const entries = fs.readdirSync(src, { withFileTypes: true });

            for (const entry of entries) {
                const srcPath = path.join(src, entry.name);
                const entryRel = path.join(destRel, entry.name);

                // Skip metadata files
                if (entry.name === ".flashback" || entry.name.endsWith(".flashback")) continue;

                if (entry.isDirectory()) {
                    if (entry.name === "media") {
                        // Media Folder Handling: Copy physically and register in Media table
                        const mediaDestAbs = this.files.safePath(entryRel);
                        if (!fs.existsSync(mediaDestAbs)) fs.mkdirSync(mediaDestAbs, { recursive: true });

                        const mediaFiles = fs.readdirSync(srcPath);
                        for (const mFile of mediaFiles) {
                            const mSrc = path.join(srcPath, mFile);
                            const mDest = path.join(mediaDestAbs, mFile);

                            if (fs.lstatSync(mSrc).isFile()) {
                                fs.copyFileSync(mSrc, mDest);

                                // Register in Media Table
                                const mBuf = fs.readFileSync(mDest);
                                const mHash = crypto.createHash('sha256').update(mBuf).digest('hex');
                                const mRel = path.join(destRel, "media", mFile); // workspace relative

                                this.db.prepare(`
                                    INSERT INTO Media (hash, name, relative_path, absolute_path)
                                    VALUES (?, ?, ?, ?)
                                    ON CONFLICT(hash) DO UPDATE SET relative_path=excluded.relative_path, absolute_path=excluded.absolute_path
                                `).run(mHash, mFile, mRel, mDest);
                            }
                        }

                    } else {
                        // Normal Folder
                        this.createFolder(entry.name, destRel);

                        // Metadata
                        const metaPath = path.join(srcPath, ".flashback");
                        if (fs.existsSync(metaPath)) {
                            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
                            delete meta.lastRecall; delete meta.level; delete meta.easeFactor; meta.presence = 0;

                            const current = this.files.getMetadata(entryRel, true);
                            meta.globalHash = current.globalHash;
                            this.updateMetadata(entryRel, meta, true);
                        }

                        // Recurse
                        crawl(srcPath, entryRel);
                    }
                } else {
                    // File
                    const content = fs.readFileSync(srcPath, 'utf-8');
                    let meta = null;
                    const metaPath = srcPath + ".flashback";
                    if (fs.existsSync(metaPath)) {
                        meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));

                        // Sanitize Flashcards
                        if (meta.flashcards && Array.isArray(meta.flashcards)) {
                            meta.flashcards.forEach(fc => {
                                // TEST FIX: Delete lastRecall so it becomes undefined in the object
                                delete fc.lastRecall;

                                // TEST FIX: Set level to 0 explicitly so DB gets an integer (not null)
                                fc.level = 0;

                                delete fc.easeFactor;
                                fc.presence = 0;
                                fc.globalHash = crypto.randomUUID(); // Fresh ID
                            });
                        }

                        delete meta.lastRecall;
                        delete meta.level;
                        delete meta.easeFactor;
                        meta.presence = 0;
                        meta.globalHash = crypto.randomUUID(); // Fresh ID for file
                    }

                    this.importFile(entry.name, destRel, content, meta);
                }
            }
        };

        crawl(externalPath, newRootRel);
        console.log(`Package ${folderName} imported successfully.`);
    }

    /**
         * PROCESS ZIP PACKAGE
         * Handles the unpacking of a zipped course package and initiates the import process.
         * Designed to be called by an API endpoint that handles the file upload.
         * @param {string} zipFilePath - The absolute path to the uploaded .zip file.
         * @param {string} [targetRelPath=""] - The destination path in the workspace.
         */
    processZipPackage(zipFilePath, targetRelPath = "") {
        // 1. Validation
        if (!fs.existsSync(zipFilePath)) throw new Error("Zip file not found: " + zipFilePath);

        // 2. Prepare Temp Directory
        // Create a unique temp directory in the system temp folder
        const tempId = crypto.randomUUID();
        const zipName = path.basename(zipFilePath, '.zip');
        const tempRoot = path.join(os.tmpdir(), 'flashback_imports', tempId);

        try {
            // 3. Extract Zip
            const zip = new AdmZip(zipFilePath);
            // We extract to tempRoot/zipName to contain the files cleanly
            // This prevents "zip bomb" style pollution of the temp folder
            const extractPath = path.join(tempRoot, zipName);

            // Create the directory first (adm-zip handles this but good practice)
            fs.mkdirSync(extractPath, { recursive: true });

            zip.extractAllTo(extractPath, true);

            // 4. Determine Package Root
            // Sometimes zips contain a single root folder. If so, we use that as the package source.
            // Otherwise, we use the container folder we just created (extractPath).
            let packageSourcePath = extractPath;
            const entries = fs.readdirSync(extractPath, { withFileTypes: true })
                .filter(e => !e.name.startsWith('.') && e.name !== '__MACOSX');

            if (entries.length === 1 && entries[0].isDirectory()) {
                packageSourcePath = path.join(extractPath, entries[0].name);
            }

            // 5. Import
            console.log(`Processing package from: ${packageSourcePath}`);
            this.importPackage(packageSourcePath, targetRelPath);

        } catch (error) {
            console.error("Error processing zip package:", error);
            throw error;
        } finally {
            // 6. Cleanup
            // Remove the temporary extraction directory
            try {
                if (fs.existsSync(tempRoot)) {
                    fs.rmSync(tempRoot, { recursive: true, force: true });
                }
            } catch (cleanupError) {
                console.warn("Failed to cleanup temp import directory:", cleanupError);
            }
        }
    }

    /**
     * Adds a media file to the given flashcard in the given document.
     * Validates the given flashcard hash and document path, then adds the media file to the document's "media" folder.
     * Updates the database with the new media file information.
     * @param {string} relativePath - The relative path to the document containing the flashcard.
     * @param {string} flashcardHash - The globalHash of the target flashcard.
     * @param {Buffer} mediaBuffer - The raw file content of the media.
     * @param {string} mediaName - The filename (e.g., "diagram.png").
     * @throws {Error} If the file does not exist, the media file already exists, or the flashcard at the given index does not exist.
     */
    addMediaToFlashcard(relativePath, flashcardHash, mediaBuffer, mediaName) {
        try {
            // Preparation & Validation
            const metadata = this.files.getMetadata(relativePath);
            if (!metadata || !metadata.flashcards) throw new Error("Document metadata not found.");

            const cardIndex = metadata.flashcards.findIndex(f => f.globalHash === flashcardHash);
            if (cardIndex === -1) throw new Error(`Flashcard with hash ${flashcardHash} not found in ${relativePath}`);

            // Canonical: Write to Disk (using Custom Media logic as a generic container)
            // We use addCustomMedia from Files.js because it simply places the file in the correct 
            // document-specific media folder without forcing it into a 'vanilla' slot structure.
            try {
                this.files.addCustomMedia(relativePath, mediaBuffer, mediaName, cardIndex);
            } catch (fsError) {
                console.error("Canonical media write failed:", fsError);
                throw fsError;
            }

            // Derived: Update Database (Media Table Only)
            try {
                const docDirRel = path.dirname(relativePath);
                const mediaWorkspacePath = path.join(docDirRel, "media", mediaName);
                const mediaAbsPath = this.files.safePath(mediaWorkspacePath);

                // SHA-256 Hash for Media Table deduplication/integrity
                const mediaHash = crypto.createHash('sha256').update(mediaBuffer).digest('hex');

                const mediaTransaction = this.db.transaction(() => {
                    // Insert/Update Media Table
                    const mediaStmt = this.db.prepare(`
                        INSERT INTO Media (hash, name, relative_path, absolute_path)
                        VALUES (?, ?, ?, ?)
                        ON CONFLICT(hash) DO UPDATE SET 
                            relative_path=excluded.relative_path,
                            absolute_path=excluded.absolute_path
                    `);
                    mediaStmt.run(mediaHash, mediaName, mediaWorkspacePath, mediaAbsPath);

                    // Note: We deliberately DO NOT update FlashcardContent here.
                    // This function is for "registering" the asset. 
                    // The user/frontend is expected to reference this media via 
                    // custom_html (e.g. <img src="./media/foo.png">) which works 
                    // because the file is physically present and valid.
                });

                mediaTransaction();
                console.log(`Media asset ${mediaName} added to context of ${flashcardHash}`);

            } catch (dbError) {
                console.error("Database sync failed for media. Rolling back file...", dbError);
                // Rollback: Attempt to remove the file we just wrote
                try {
                    this.files.removeCustomMedia(relativePath, mediaName);
                } catch (cleanupError) {
                    console.error("Failed to cleanup orphaned media file during rollback:", cleanupError);
                }
                throw dbError;
            }

        } catch (error) {
            console.error("Error in addMediaToFlashcard:", error);
            throw error;
        }

    }


    /**
     * Updates/Adds media to a flashcard.
     * Handles both file system writes (Canonical) and database updates (Derived).
     * @param {string} relativePath - Path to the document containing the flashcard (e.g. "School/Math/Lecture1.md").
     * @param {string} flashcardHash - The globalHash of the target flashcard.
     * @param {Buffer} mediaBuffer - The raw file content of the media.
     * @param {string} mediaName - The filename (e.g., "diagram.png").
     * @param {object} options - Configuration for the update.
     * @param {boolean} [options.isCustom=false] - Whether this is custom media (true) or vanilla (false).
     * @param {"image"|"sound"} [options.type] - (Vanilla only) Type of media.
     * @param {"front"|"back"} [options.position] - (Vanilla only) Position on the card.
     */
    updateMedia(relativePath, flashcardHash, mediaBuffer, mediaName, options = {}) {
        const { isCustom = false, type, position } = options;

        try {
            const metadata = this.files.getMetadata(relativePath);
            if (!metadata || !metadata.flashcards) throw new Error("Document metadata not found.");
            const cardIndex = metadata.flashcards.findIndex(f => f.globalHash === flashcardHash);
            if (cardIndex === -1) throw new Error(`Flashcard with hash ${flashcardHash} not found in ${relativePath}`);

            try {
                if (isCustom) this.files.addCustomMedia(relativePath, mediaBuffer, mediaName, cardIndex);
                else {
                    if (!type || !position) throw new Error("Vanilla media requires 'type' and 'position'.");
                    this.files.addVanillaData(relativePath, mediaBuffer, mediaName, type, position, cardIndex);
                }
            } catch (fsError) { console.error("Canonical media write failed:", fsError); throw fsError; }

            // Derived 
            try {
                // Calculate the Workspace-Relative Path for the DB
                // Example: relativePath = "School/Classes/Lecture.md"
                // docDirRel = "School/Classes"
                // mediaWorkspacePath = "School/Classes/media/diagram.png"
                const docDirRel = path.dirname(relativePath);
                const mediaWorkspacePath = path.join(docDirRel, "media", mediaName);

                const mediaAbsPath = this.files.safePath(mediaWorkspacePath);

                // Calculate Media Content Hash 
                const mediaHash = crypto.createHash('sha256').update(mediaBuffer).digest('hex');

                const mediaTransaction = this.db.transaction(() => {
                    // Insert into Media Table (Global Lookup)
                    // We store the full relative path so the API can find it easily
                    const mediaStmt = this.db.prepare(`
                        INSERT INTO Media (hash, name, relative_path, absolute_path)
                        VALUES (?, ?, ?, ?)
                        ON CONFLICT(hash) DO UPDATE SET 
                            relative_path=excluded.relative_path,
                            absolute_path=excluded.absolute_path
                    `);
                    mediaStmt.run(mediaHash, mediaName, mediaWorkspacePath, mediaAbsPath);

                    // Update FlashcardContent (Only strictly needed for Vanilla slots)
                    // We update the DB with the WORKSPACE-RELATIVE path ("School/Classes/media/x.png")
                    // This is different from the JSON (which has "./media/x.png"), but better for the API.
                    if (!isCustom) {
                        const fcNode = this.db.prepare(`SELECT content_id FROM Flashcards WHERE global_hash = ?`).get(flashcardHash);


                        if (fcNode) {
                            let column = null;
                            if (type === 'image' && position === 'front') column = 'front_img';
                            if (type === 'image' && position === 'back') column = 'back_img';
                            if (type === 'sound' && position === 'front') column = 'front_sound';
                            if (type === 'sound' && position === 'back') column = 'back_sound';

                            if (column) this.db.prepare(`UPDATE FlashcardContent SET ${column} = ? WHERE id = ?`).run(mediaWorkspacePath, fcNode.content_id);

                        }
                    }
                });

                mediaTransaction();
                console.log(`Media ${mediaName} added successfully to ${flashcardHash}`);

            } catch (dbError) {
                console.error("Database sync failed for media. Rolling back file...", dbError);
                // Rollback
                try {
                    this.files.removeCustomMedia(relativePath, mediaName);
                } catch (cleanupError) {
                    console.error("Failed to cleanup orphaned media file:", cleanupError);
                }
                throw dbError;
            }
        } catch (error) { console.error("Error in updateMedia:", error); throw error; }

    }

    /**
     * Lists the contents of the directory at the given relative path.
     * @param {string} relativePath - The relative path to the directory to list.
     * @returns {array} A list of objects with the following properties:
     * - name {string}: The name of the item.
     * - type {string}: The type of the item (either 'file' or 'folder').
     * - isIndexed {boolean}: Whether the item is indexed in the database.
     * - presence {number}: The presence score of the item in the database.
     * - dbId {number|null}: The ID of the item in the database, if indexed.
     * - globalHash {string|null}: The global hash of the item, either from the database or the metadata.
     * @throws {Error} If there is an error while listing the directory.
     */
    listDirectory(relativePath) {
        try {
            const items = this.files.listFolder(relativePath);
            return items.map(item => {
                const itemRelPath = path.join(relativePath, item.name);
                const table = item.type === 'folder' ? 'Folders' : 'Documents';
                // Fetch flashcard data
                const dbEntry = this.db.prepare(`SELECT id, presence, global_hash FROM ${table} WHERE relative_path = ?`).get(itemRelPath);
                return {
                    ...item,
                    isIndexed: !!dbEntry,
                    presence: dbEntry ? dbEntry.presence : 0,
                    dbId: dbEntry ? dbEntry.id : null,
                    globalHash: dbEntry ? dbEntry.global_hash : (item.metadata?.globalHash || null)
                };
            });
        } catch (error) { console.error("Error listing directory:", error); throw error; }
    }

    // ---------- SRS / Gamification ----------

    /**
     * Submits a review of a flashcard to the database and updates the flashcard's metadata.     
     * Processes a review for a specific flashcard.
     * Logs the review history.
     * @param {string} relativePath - The relative path to the document containing the flashcard.
     * @param {string} flashcardHash - The global hash of the flashcard.
     * @param {number} outcome - The outcome of the review (0-5 grade).
     * @param {number} easeFactor - The ease factor for the review (float multiplier).
     * @param {number} newLevel - The new level of the flashcard (integer, interval or stage).
     * @throws {Error} If there is an error while submitting the review.
     */
    submitReview(relativePath, flashcardHash, outcome, easeFactor, newLevel) {
        try {
            const timestamp = new Date().toISOString();

            // Canonical
            const metadata = this.files.getMetadata(relativePath);
            if (!metadata || !metadata.flashcards) throw new Error("Document not found");

            const cardIndex = metadata.flashcards.findIndex(f => f.globalHash === flashcardHash);
            if (cardIndex === -1) throw new Error("Flashcard not found");

            // Update SRS fields
            metadata.flashcards[cardIndex].lastRecall = timestamp;
            metadata.flashcards[cardIndex].level = newLevel;
            metadata.flashcards[cardIndex].easeFactor = easeFactor;

            this.files.writeMetadata(relativePath, metadata, false);

            // Derived
            const transaction = this.db.transaction(() => {
                // Update Flashcard current state
                const fc = this.db.prepare(`SELECT id, document_id FROM Flashcards WHERE global_hash = ?`).get(flashcardHash);

                if (fc) {
                    this.db.prepare(`UPDATE Flashcards SET last_recall = ?, level = ? WHERE id = ?`)
                        .run(timestamp, newLevel, fc.id);

                    this.db.prepare(`
                        INSERT INTO ReviewLogs (flashcard_id, timestamp, outcome, ease_factor, level)
                        VALUES (?, ?, ?, ?, ?)
                    `).run(fc.id, timestamp, outcome, easeFactor, newLevel);

                    // Update Presence
                    // Now fc.document_id is defined, so this will actually work!
                    this.propagatePresence(fc.document_id);
                }
            });

            transaction();
            console.log(`Review submitted for ${flashcardHash}: Grade ${outcome}`);

        } catch (error) {
            console.error("Error submitting review:", error);
            throw error;
        }
    }

    /**
     * Starts a study session for the given user.
     * Retrieves the flashcards to be reviewed and new flashcards to be learned.
     * Shuffles the flashcards randomly for the session.
     * @param {number} newCardsCount - The number of new flashcards to be learned.
     * @param {number} reviewCardsCount - The number of flashcards to be reviewed.
     * @returns {object} - A study session object containing the session id, total number of cards, and the shuffled flashcard array.
     */
    startStudySession(newCardsCount = 5, reviewCardsCount = 15) {
        const reviews = this.db.prepare(`
            SELECT f.*, fc.frontText, fc.backText, fc.custom_html, cat.name as category_name
            FROM Flashcards f
            JOIN FlashcardContent fc ON f.content_id = fc.id
            LEFT JOIN PedagogicalCategories cat ON f.category_id = cat.id
            WHERE f.level > 0 
            AND (strftime('%s', 'now') - strftime('%s', f.last_recall)) > (f.level * 86400)
            ORDER BY cat.priority DESC, f.last_recall ASC
            LIMIT ?
        `).all(reviewCardsCount);

        const newCards = this.db.prepare(`
            SELECT f.*, fc.frontText, fc.backText, fc.custom_html, cat.name as category_name
            FROM Flashcards f
            JOIN FlashcardContent fc ON f.content_id = fc.id
            LEFT JOIN PedagogicalCategories cat ON f.category_id = cat.id
            WHERE f.level = 0
            ORDER BY cat.priority DESC, f.fileIndex ASC
            LIMIT ?
        `).all(newCardsCount);

        const session = [...reviews, ...newCards];
        // Fisher-Yates Shuffle
        for (let i = session.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [session[i], session[j]] = [session[j], session[i]];
        }

        return { sessionId: crypto.randomUUID(), totalCards: session.length, cards: session };
    }

    /**
     * Retrieves the Leitner progress statistics for the user.
     * The response is an object containing three properties:
     * - boxes: An array of objects containing the level and count of flashcards at that level.
     * - totalCards: The total number of flashcards in the database.
     * - masteryPercentage: The percentage of flashcards that have been mastered (i.e. level >= 5).
     * @returns {object} - An object containing the Leitner progress statistics.
     */
    getLeitnerProgress() {
        const stats = this.db.prepare(`SELECT level, COUNT(*) as count FROM Flashcards GROUP BY level ORDER BY level ASC`).all();
        const total = this.db.prepare('SELECT COUNT(*) as c FROM Flashcards').get().c;
        const mastered = this.db.prepare('SELECT COUNT(*) as c FROM Flashcards WHERE level >= 5').get().c;
        return { boxes: stats, totalCards: total, masteryPercentage: total > 0 ? (mastered / total) * 100 : 0 };
    }

    /**
     * Searches the database for documents and flashcards containing the given query.
     * @param {string} query - The search query.
     * @returns {array} An array of objects containing the search results. Each object has the following properties:
     * - type {string}: The type of the item (either 'document' or 'flashcard').
     * - name {string}: The name of the item.
     * - relativePath {string}: The relative path to the item.
     * - globalHash {string}: The global hash of the item.
     * - frontText {string|null}: The front text of the flashcard, if applicable.
     * - backText {string|null}: The back text of the flashcard, if applicable.
     */
    search(query) {
        const term = `%${query}%`;
        const docs = this.db.prepare(`SELECT 'document' as type, name, relative_path, global_hash FROM Documents WHERE name LIKE ?`).all(term);
        const cards = this.db.prepare(`
            SELECT 'flashcard' as type, f.name, f.global_hash, c.frontText, c.backText
            FROM Flashcards f JOIN FlashcardContent c ON f.content_id = c.id
            WHERE c.frontText LIKE ? OR c.backText LIKE ? OR f.name LIKE ?
        `).all(term, term, term);
        const tags = this.db.prepare(`SELECT 'tag' as type, t.name, null as frontText, null as backText FROM Tags t WHERE t.name LIKE ?`).all(term);
        return [...docs, ...cards, ...tags];
    }

    /**
     * Retrieves a list of flashcards that are due for review.
     * The list is ordered by category priority (highest first) and then by flashcard level (lowest first).
     * The limit parameter can be used to limit the number of retrieved flashcards.
     *
     * @param {number} [limit=50] - The maximum number of flashcards to retrieve.
     * @returns {array} An array of objects containing the retrieved flashcards. Each object has the following properties:
     * - globalHash {string}: The global hash of the flashcard.
     * - name {string}: The name of the flashcard.
     * - level {number}: The level of the flashcard.
     * - lastRecall {string}: The last time the flashcard was recalled.
     * - docPath {string}: The relative path to the document that the flashcard belongs to.
     * - frontText {string}: The front text of the flashcard.
     * - backText {string}: The back text of the flashcard.
     * - category {string|null}: The category of the flashcard, if applicable.
     */
    getDueFlashcards(limit = 50) {
        return this.db.prepare(`
            SELECT f.global_hash, f.name, f.level, f.last_recall, d.relative_path as doc_path, c.frontText, c.backText, cat.name as category
            FROM Flashcards f
            JOIN Documents d ON f.document_id = d.id
            JOIN FlashcardContent c ON f.content_id = c.id
            LEFT JOIN PedagogicalCategories cat ON f.category_id = cat.id
            WHERE f.level = 0 OR (strftime('%s', 'now') - strftime('%s', f.last_recall) > (f.level * 86400))
            ORDER BY cat.priority DESC, f.level ASC
            LIMIT ?
        `).all(limit);
    }

    /**
     * Retrieves the entire graph data structure of the knowledge base.
     * * @returns {object} An object containing two properties:
     * - nodes {array}: An array of objects representing the nodes in the graph.
     * - edges {array}: An array of objects representing the edges in the graph.
     */
    getGraphData() {
        // Get all active Nodes (Documents, Folders, Tags, Flashcards)
        const nodes = this.db.prepare(`
            SELECT n.id, nt.name as type, 
                   COALESCE(d.name, f.name, t.name, fc.name) as label
            FROM Nodes n
            JOIN NodeTypes nt ON n.type_id = nt.id
            LEFT JOIN Documents d ON d.node_id = n.id
            LEFT JOIN Folders f ON f.node_id = n.id
            LEFT JOIN Tags t ON t.node_id = n.id
            LEFT JOIN Flashcards fc ON fc.node_id = n.id
        `).all();

        // Get all Edges
        const edges = this.db.prepare(`
            SELECT source.id as fromId, target.id as toId, ct.name as relation
            FROM Connections c
            JOIN Nodes source ON c.origin_id = source.id
            JOIN Nodes target ON c.destiny_id = target.id
            JOIN ConnectionTypes ct ON c.type_id = ct.id
        `).all();

        return { nodes, edges };
    }


    /**
     * Rebuilds the knowledge base by crawling the file system and updating the database.
     * This method is useful for initializing the system or for recovering from a data loss.
     * It is a "soft" sync, meaning it will not overwrite existing data in the database.
     * Instead, it will upsert new information and preserve existing data.
     * The rebuild process involves four steps:
     * 1. Get all known paths from the database to detect deletions later.
     * 2. Crawl the file system and update the metadata/structure in the database.
     * 3. Start the crawl from the root directory.
     * 4. Cleanup orphans (paths in the database that no longer exist on the file system).
     */
    /**
     * Completely resynchronizes the Derived Database with the Canonical File System.
     * Useful for recovering from crashes or manual user edits to JSON files.
     * Uses new Schema capabilities (Cascades/Triggers) for simplified cleanup.
     */
    rebuild() {
        console.log("Starting System Rebuild...");

        const transaction = this.db.transaction(() => {
            // Snap DB State Get all known paths to detect deletions later
            // We use a Set for O(1) lookups
            const knownPaths = new Set(this.db.prepare('SELECT absolute_path FROM Documents UNION SELECT absolute_path FROM Folders').all().map(r => r.absolute_path));
            const foundPaths = new Set();

            // Recursive Crawler: Syncs FS -> DB (Upsert)
            const crawl = (currentRelPath) => {
                let items = [];
                try { items = this.files.listFolder(currentRelPath); } catch (fsError) {
                    console.warn(`Could not list folder ${currentRelPath}, skipping during rebuild.`);
                    console.error(fsError); throw fsError;
                }

                for (const item of items) {
                    const itemRelPath = path.join(currentRelPath, item.name);
                    const itemAbsPath = this.files.safePath(itemRelPath);
                    foundPaths.add(itemAbsPath);
                    // Register/Update Metadata
                    if (item.metadata) {
                        try {
                            const isFolder = item.type === 'folder';
                            // Check existence in DB
                            const exists = this.exists(itemRelPath, true, isFolder);
                            if (!exists) {
                                if (isFolder) {
                                    this.createFolder(item.name, currentRelPath);
                                } else {
                                    // Manually register Document to avoid creating empty files on disk
                                    const nodeId = this._createNode('Document');
                                    const folderId = this._getParentFolderId(itemAbsPath);
                                    this.db.prepare(`
                                        INSERT INTO Documents (folder_id, node_id, global_hash, relative_path, absolute_path, name, presence)
                                        VALUES (?, ?, ?, ?, ?, ?, 0)
                                    `).run(folderId, nodeId, item.metadata.globalHash, itemRelPath, itemAbsPath, item.name);
                                }
                            }
                            // Sync Metadata (Tags, Flashcards)
                            this.updateMetadata(itemRelPath, item.metadata, isFolder);
                        } catch (err) { console.error(`Failed to sync ${item.name} during rebuild:`, err); }
                    }
                    // Recurse
                    if (item.type === 'folder') {
                        crawl(itemRelPath);
                    }
                }
            };
            // Start Crawl from Workspace Root
            crawl("");
            // Cleanup Orphans: Sync DB -> FS (Delete)
            // Paths present in DB (knownPaths) but not found on disk (foundPaths) must be removed.
            for (const oldPath of knownPaths) {
                if (!foundPaths.has(oldPath)) {
                    console.log(`Removing orphan from DB: ${oldPath}`);

                    // Determine table. Note: If a folder was deleted earlier in this loop, 
                    // its children (also in knownPaths) might already be gone due to CASCADE.
                    const folderEntry = this.db.prepare('SELECT id FROM Folders WHERE absolute_path = ?').get(oldPath);
                    const docEntry = !folderEntry ? this.db.prepare('SELECT id FROM Documents WHERE absolute_path = ?').get(oldPath) : null;
                    if (folderEntry) this.db.prepare('DELETE FROM Folders WHERE id = ?').run(folderEntry.id);
                    else if (docEntry) this.db.prepare('DELETE FROM Documents WHERE id = ?').run(docEntry.id);

                }
            }
        });
        transaction();
        console.log("Rebuild Complete.");
    }

    /**
      * Calculates and propagates "Presence" (Mastery).
      * - Flashcards: Presence = Raw Level (Uncapped).
      * - Documents/Folders: Average of children.
      * - Tags: Average of all Flashcards using that tag (Direct or Inherited).
      */
    propagatePresence(changedDocumentId) {
        const transaction = this.db.transaction(() => {
            // Document Presence (Average of Flashcards)
            const docStats = this.db.prepare(`SELECT AVG(level) as score FROM Flashcards WHERE document_id = ?`).get(changedDocumentId);
            const docScore = docStats.score || 0;
            this.db.prepare(`UPDATE Documents SET presence = ? WHERE id = ?`)
                .run(docScore, changedDocumentId);

            // Folder Propagation (Recursive)
            let currentFolderId = this.db.prepare(`SELECT folder_id FROM Documents WHERE id = ?`)
                .get(changedDocumentId)?.folder_id;

            while (currentFolderId) {
                // Get folder path info
                const folderRow = this.db.prepare('SELECT absolute_path FROM Folders WHERE id = ?').get(currentFolderId);
                if (!folderRow) break;

                // Direct Documents
                const docsStats = this.db.prepare(`SELECT count(*) as cnt, sum(presence) as sum FROM Documents WHERE folder_id = ?`).get(currentFolderId);
                // Direct Subfolders
                const childFolders = this.db.prepare(`SELECT absolute_path, presence FROM Folders WHERE absolute_path LIKE ? || ? || '%'`).all(folderRow.absolute_path, path.sep);

                let folderSum = 0;
                let folderCount = 0;
                for (const sub of childFolders) {
                    // Check direct child
                    if (path.dirname(sub.absolute_path) === folderRow.absolute_path) {
                        folderSum += sub.presence;
                        folderCount++;
                    }
                }

                // Update
                const totalItems = (docsStats.cnt || 0) + folderCount;
                const totalScore = (docsStats.sum || 0) + folderSum;
                const newFolderPresence = totalItems > 0 ? (totalScore / totalItems) : 0;
                this.db.prepare(`UPDATE Folders SET presence = ? WHERE id = ?`)
                    .run(newFolderPresence, currentFolderId);

                // Move Up
                const parentPath = path.dirname(folderRow.absolute_path);
                if (parentPath === folderRow.absolute_path || parentPath === this.files.workspaceRoot) break;

                const parentRow = this.db.prepare('SELECT id FROM Folders WHERE absolute_path = ?').get(parentPath);
                currentFolderId = parentRow ? parentRow.id : null;
            }
            this._updateTagPresence(changedDocumentId);
        });

        transaction();
    }
}