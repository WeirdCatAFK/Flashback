/**
 * Query.js
 * Data Access Layer for Flashback.
 * Handles all direct SQLite interactions.
 */

import db from './database.js';

class DocumentQuery {
    constructor() {
        this.db = db;
    }

    /**
     * Creates a new graph node.
     * @param {string} typeName - e.g., 'Folder', 'Document', 'Flashcard', 'Tag'
     * @returns {number} The node ID.
     */
    createNode(typeName) {
        const type = this.db.prepare('SELECT id FROM NodeTypes WHERE name = ?').get(typeName);
        if (!type) throw new Error(`${typeName} node type missing.`);
        const info = this.db.prepare('INSERT INTO Nodes (type_id) VALUES (?)').run(type.id);
        return info.lastInsertRowid;
    }

    // --- Folders ---

    getFolderByHash(hash) {
        return this.db.prepare('SELECT * FROM Folders WHERE global_hash = ?').get(hash);
    }

    getFolderByPath(relPath) {
        return this.db.prepare('SELECT * FROM Folders WHERE relative_path = ?').get(relPath);
    }

    insertFolder(data) {
        const stmt = this.db.prepare(`
            INSERT INTO Folders (node_id, global_hash, parent_id, relative_path, absolute_path, name, presence)
            VALUES (?, ?, ?, ?, ?, ?, 0)
        `);
        return stmt.run(data.nodeId, data.globalHash, data.parentId ?? null, data.relativePath, data.absolutePath, data.name);
    }

    getFolderByAbsolutePath(absPath) {
        return this.db.prepare('SELECT * FROM Folders WHERE absolute_path = ?').get(absPath);
    }

    getFolderByNodeId(nodeId) {
        return this.db.prepare('SELECT * FROM Folders WHERE node_id = ?').get(nodeId);
    }

    getFolderParentId(folderId) {
        return this.db.prepare('SELECT parent_id FROM Folders WHERE id = ?').get(folderId);
    }

    getChildDocuments(folderId) {
        return this.db.prepare('SELECT id, node_id, relative_path FROM Documents WHERE folder_id = ?').all(folderId);
    }

    getChildFolders(parentId) {
        return this.db.prepare('SELECT id, node_id, relative_path, absolute_path FROM Folders WHERE parent_id = ?').all(parentId);
    }

    updateFolderMetadata(id, data) {
        if (data.globalHash) {
            this.db.prepare('UPDATE Folders SET global_hash = ? WHERE id = ?').run(data.globalHash, id);
        }
    }

    // --- Documents ---

    getDocumentByHash(hash) {
        return this.db.prepare('SELECT * FROM Documents WHERE global_hash = ?').get(hash);
    }

    getDocumentByPath(relPath) {
        return this.db.prepare('SELECT * FROM Documents WHERE relative_path = ?').get(relPath);
    }

    insertDocument(data) {
        const stmt = this.db.prepare(`
            INSERT INTO Documents (folder_id, node_id, global_hash, relative_path, absolute_path, name, presence)
            VALUES (?, ?, ?, ?, ?, ?, 0)
        `);
        const info = stmt.run(data.folderId, data.nodeId, data.globalHash, data.relativePath, data.absolutePath, data.name);
        return info;
    }

    updateDocumentMetadata(id, data) {
        if (data.globalHash) {
            this.db.prepare('UPDATE Documents SET global_hash = ? WHERE id = ?').run(data.globalHash, id);
        }
    }

    deleteDocument(id) {
        this.db.prepare('DELETE FROM Documents WHERE id = ?').run(id);
    }

    // --- Flashcards ---

    getFlashcardsByDocument(documentId) {
        return this.db.prepare('SELECT id, node_id, global_hash, level, last_recall, content_id FROM Flashcards WHERE document_id = ?').all(documentId);
    }

    insertFlashcard(data) {
        let customHtml = data.customData?.html || null;
        let frontText = null, backText = null, fImg = null, bImg = null, fSnd = null, bSnd = null;

        if (data.vanillaData) {
            frontText = data.vanillaData.frontText || null;
            backText = data.vanillaData.backText || null;
            if (data.vanillaData.media) {
                fImg = data.vanillaData.media.frontImg || null; 
                bImg = data.vanillaData.media.backImg || null;
                fSnd = data.vanillaData.media.frontSound || null; 
                bSnd = data.vanillaData.media.backSound || null;
            }
        }

        // 1. Content
        const contentStmt = this.db.prepare(`
            INSERT INTO FlashcardContent (custom_html, frontText, backText, front_img, back_img, front_sound, back_sound)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        const contentInfo = contentStmt.run(customHtml, frontText, backText, fImg, bImg, fSnd, bSnd);

        // 2. Reference
        let referenceId = null;
        if (data.vanillaData?.location) {
            const loc = data.vanillaData.location;
            const d = loc.data || {};
            const bboxJson = d.bbox ? JSON.stringify(d.bbox) : null;
            const refStmt = this.db.prepare(`
                INSERT INTO FlashcardReference (type, start, end, page, bbox) VALUES (?, ?, ?, ?, ?)
            `);
            const refInfo = refStmt.run(loc.type, d.start || null, d.end || null, d.page || null, bboxJson);
            referenceId = refInfo.lastInsertRowid;
        }

        let categoryId = null;
        if (data.category) {
            const cat = this.db.prepare("SELECT id FROM PedagogicalCategories WHERE name = ?").get(data.category);
            if (cat) categoryId = cat.id;
        }

        // 3. Main Entry
        const stmt = this.db.prepare(`
            INSERT INTO Flashcards (global_hash, node_id, document_id, category_id, content_id, reference_id, last_recall, level, name, fileIndex, presence)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
        `);
        return stmt.run(
            data.globalHash, data.nodeId, data.documentId, categoryId,
            contentInfo.lastInsertRowid, referenceId, data.lastRecall || null, data.level || 0, data.name || null, data.fileIndex || 0
        );
    }

    updateFlashcard(id, data) {
        let categoryId = null;
        if (data.category) {
            const cat = this.db.prepare("SELECT id FROM PedagogicalCategories WHERE name = ?").get(data.category);
            if (cat) categoryId = cat.id;
        }

        this.db.prepare(`
            UPDATE Flashcards
            SET last_recall = ?, level = ?, category_id = ?, name = ?, fileIndex = ?
            WHERE id = ?
        `).run(data.lastRecall, data.level, categoryId, data.name || null, data.fileIndex, id);

        // Content
        const contentUpdates = [];
        const params = [];

        if (data.customData?.html !== undefined) { 
            contentUpdates.push("custom_html = ?"); 
            params.push(data.customData.html); 
        }

        if (data.vanillaData) {
            if (data.vanillaData.frontText !== undefined) { 
                contentUpdates.push("frontText = ?"); 
                params.push(data.vanillaData.frontText); 
            }
            if (data.vanillaData.backText !== undefined) { 
                contentUpdates.push("backText = ?"); 
                params.push(data.vanillaData.backText); 
            }
            if (data.vanillaData.media) {
                contentUpdates.push("front_img = ?", "back_img = ?", "front_sound = ?", "back_sound = ?");
                params.push(
                    data.vanillaData.media.frontImg || null, data.vanillaData.media.backImg || null,
                    data.vanillaData.media.frontSound || null, data.vanillaData.media.backSound || null
                );
            }
        }
        
        if (contentUpdates.length > 0) {
            params.push(data.contentId);
            this.db.prepare(`UPDATE FlashcardContent SET ${contentUpdates.join(', ')} WHERE id = ?`).run(...params);
        }
    }

    deleteFlashcard(id) {
        const fc = this.db.prepare('SELECT content_id, reference_id, node_id FROM Flashcards WHERE id = ?').get(id);
        if (fc) {
            this.db.prepare('DELETE FROM Flashcards WHERE id = ?').run(id);
            this.db.prepare('DELETE FROM Nodes WHERE id = ?').run(fc.node_id);
            if (fc.content_id) this.db.prepare('DELETE FROM FlashcardContent WHERE id = ?').run(fc.content_id);
            if (fc.reference_id) this.db.prepare('DELETE FROM FlashcardReference WHERE id = ?').run(fc.reference_id);
        }
    }

    // --- Tags ---

    getTagByName(name) {
        return this.db.prepare('SELECT * FROM Tags WHERE name = ?').get(name);
    }

    insertTag(name, nodeId) {
        return this.db.prepare('INSERT INTO Tags (name, node_id, presence) VALUES (?, ?, 0)').run(name, nodeId);
    }

    syncNodeTags(nodeId, tagNodeIds) {
        const tagType = this.db.prepare("SELECT id FROM NodeTypes WHERE name = 'Tag'").get();
        const connType = this.db.prepare("SELECT id FROM ConnectionTypes WHERE name = 'tag'").get();

        const currentConns = this.db.prepare(`
            SELECT c.id, c.destiny_id FROM Connections c 
            JOIN Nodes n ON c.destiny_id = n.id 
            WHERE c.origin_id = ? AND n.type_id = ? AND c.type_id = ?
        `).all(nodeId, tagType.id, connType.id);

        const currentTagIds = currentConns.map(c => c.destiny_id);

        for (const tid of tagNodeIds) {
            if (!currentTagIds.includes(tid)) {
                this.db.prepare("INSERT INTO Connections (origin_id, destiny_id, type_id) VALUES (?, ?, ?)").run(nodeId, tid, connType.id);
            }
        }
        for (const conn of currentConns) {
            if (!tagNodeIds.includes(conn.destiny_id)) {
                this.db.prepare("DELETE FROM Connections WHERE id = ?").run(conn.id);
            }
        }
    }

    // --- Media ---

    insertMedia(data) {
        const stmt = this.db.prepare(`
            INSERT INTO Media (hash, name, relative_path, absolute_path)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(hash) DO UPDATE SET 
                relative_path=excluded.relative_path,
                absolute_path=excluded.absolute_path
        `);
        return stmt.run(data.hash, data.name, data.relativePath, data.absolutePath);
    }

    // --- Subscriptions ---

    getSubscription(magazineId) {
        return this.db.prepare('SELECT * FROM Subscriptions WHERE magazine_id = ?').get(magazineId);
    }

    upsertSubscription(data) {
        const stmt = this.db.prepare(`
            INSERT INTO Subscriptions (magazine_id, issue_id, version, target_path, last_sync)
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(magazine_id) DO UPDATE SET
                issue_id = excluded.issue_id,
                version = excluded.version,
                target_path = excluded.target_path,
                last_sync = CURRENT_TIMESTAMP
        `);
        return stmt.run(data.magazineId, data.issueId, data.version, data.targetPath);
    }

    // --- Path Mutations ---

    renameFolderRecord(newName, newRelPath, newAbsPath, oldAbsPath) {
        this.db.prepare('UPDATE Folders SET name = ?, relative_path = ?, absolute_path = ? WHERE absolute_path = ?')
            .run(newName, newRelPath, newAbsPath, oldAbsPath);
    }

    renameDocumentRecord(newName, newRelPath, newAbsPath, oldAbsPath) {
        this.db.prepare('UPDATE Documents SET name = ?, relative_path = ?, absolute_path = ? WHERE absolute_path = ?')
            .run(newName, newRelPath, newAbsPath, oldAbsPath);
    }

    _escapeLike(str) {
        return str.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    }

    cascadeRenameDocumentPaths(oldRelPath, newRelPath, oldAbsPath, newAbsPath) {
        this.db.prepare(`UPDATE Documents SET relative_path = replace(relative_path, ?, ?), absolute_path = replace(absolute_path, ?, ?) WHERE absolute_path LIKE ? || '%' ESCAPE '\\'`)
            .run(oldRelPath, newRelPath, oldAbsPath, newAbsPath, this._escapeLike(oldAbsPath));
    }

    cascadeRenameFolderPaths(oldRelPath, newRelPath, oldAbsPath, newAbsPath) {
        this.db.prepare(`UPDATE Folders SET relative_path = replace(relative_path, ?, ?), absolute_path = replace(absolute_path, ?, ?) WHERE absolute_path LIKE ? || '%' ESCAPE '\\'`)
            .run(oldRelPath, newRelPath, oldAbsPath, newAbsPath, this._escapeLike(oldAbsPath));
    }

    moveDocumentRecord(newFolderId, newRelPath, newAbsPath, oldAbsPath) {
        this.db.prepare('UPDATE Documents SET folder_id = ?, relative_path = ?, absolute_path = ? WHERE absolute_path = ?')
            .run(newFolderId, newRelPath, newAbsPath, oldAbsPath);
    }

    moveFolderRecord(newRelPath, newAbsPath, oldAbsPath, newParentId) {
        this.db.prepare('UPDATE Folders SET relative_path = ?, absolute_path = ?, parent_id = ? WHERE absolute_path = ?')
            .run(newRelPath, newAbsPath, newParentId ?? null, oldAbsPath);
    }

    deleteFolderTree(absPath, sep) {
        this.db.prepare(`DELETE FROM Folders WHERE absolute_path = ? OR absolute_path LIKE ? ESCAPE '\\'`)
            .run(absPath, this._escapeLike(absPath) + sep + '%');
    }

    deleteDocumentByAbsPath(absPath) {
        this.db.prepare('DELETE FROM Documents WHERE absolute_path = ?').run(absPath);
    }

    // --- Search & Graph ---

    search(query) {
        const term = `%${query}%`;
        const docs = this.db.prepare(`SELECT 'document' as type, name, relative_path, global_hash FROM Documents WHERE name LIKE ?`).all(term);
        const cards = this.db.prepare(`
            SELECT 'flashcard' as type, f.global_hash, c.frontText, c.backText
            FROM Flashcards f JOIN FlashcardContent c ON f.content_id = c.id
            WHERE c.frontText LIKE ? OR c.backText LIKE ? OR f.global_hash LIKE ? OR f.name LIKE ?
        `).all(term, term, term, term);
        const tags = this.db.prepare(`SELECT 'tag' as type, t.name, null as frontText, null as backText FROM Tags t WHERE t.name LIKE ?`).all(term);
        return [...docs, ...cards, ...tags];
    }

    // --- Presence ---

    getFlashcardAvgLevel(documentId) {
        return this.db.prepare('SELECT AVG(level) as score FROM Flashcards WHERE document_id = ?').get(documentId);
    }

    getDocumentFolderIdById(documentId) {
        return this.db.prepare('SELECT folder_id FROM Documents WHERE id = ?').get(documentId);
    }

    getFolderById(folderId) {
        return this.db.prepare('SELECT * FROM Folders WHERE id = ?').get(folderId);
    }

    getDocumentPresenceStats(folderId) {
        return this.db.prepare('SELECT count(*) as cnt, sum(presence) as total FROM Documents WHERE folder_id = ?').get(folderId);
    }

    getChildFolderPresences(parentId) {
        return this.db.prepare('SELECT presence FROM Folders WHERE parent_id = ?').all(parentId);
    }

    updateDocumentPresence(documentId, score) {
        return this.db.prepare('UPDATE Documents SET presence = ? WHERE id = ?').run(score, documentId);
    }

    updateFolderPresence(folderId, presence) {
        return this.db.prepare('UPDATE Folders SET presence = ? WHERE id = ?').run(presence, folderId);
    }

    // --- Inheritance ---

    getHierarchyTypeId() {
        return this.db.prepare("SELECT id FROM ConnectionTypes WHERE name = 'inheritance'").get();
    }

    getInheritedTagNames(nodeId) {
        return this.db.prepare(`
            SELECT t.name FROM InheritedTags it
            JOIN Connections c ON it.connection_id = c.id
            JOIN Tags t ON t.id = it.tag_id
            WHERE c.destiny_id = ? AND c.type_id = (SELECT id FROM ConnectionTypes WHERE name = 'inheritance')
        `).all(nodeId).map(t => t.name);
    }

    getOrCreateConnection(originId, destId, typeId) {
        let conn = this.db.prepare('SELECT id FROM Connections WHERE origin_id = ? AND destiny_id = ? AND type_id = ?').get(originId, destId, typeId);
        if (!conn) {
            const info = this.db.prepare('INSERT INTO Connections (origin_id, destiny_id, type_id) VALUES (?, ?, ?)').run(originId, destId, typeId);
            conn = { id: info.lastInsertRowid };
        }
        return conn;
    }

    clearInheritedTags(connectionId) {
        return this.db.prepare('DELETE FROM InheritedTags WHERE connection_id = ?').run(connectionId);
    }

    insertInheritedTag(connectionId, tagId) {
        return this.db.prepare('INSERT INTO InheritedTags (connection_id, tag_id) VALUES (?, ?)').run(connectionId, tagId);
    }

    getFlashcardNodeIds(documentId) {
        return this.db.prepare('SELECT node_id FROM Flashcards WHERE document_id = ?').all(documentId);
    }

    getGraphData() {
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

        const edges = this.db.prepare(`
            SELECT source.id as fromId, target.id as toId, ct.name as relation
            FROM Connections c
            JOIN Nodes source ON c.origin_id = source.id
            JOIN Nodes target ON c.destiny_id = target.id
            JOIN ConnectionTypes ct ON c.type_id = ct.id
        `).all();

        return { nodes, edges };
    }
}

export default new DocumentQuery();
