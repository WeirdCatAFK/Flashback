/**
 * Query.js
 * Data Access Layer for Flashback.
 * Handles all direct SQLite interactions.
 */

import db from './Database.js';

class DocumentQuery {
    constructor() {
        this.db = db;
        this._typeCache = null;
    }

    // Lazily resolves stable lookup IDs for NodeTypes/ConnectionTypes that never
    // change at runtime, so callers in hot paths avoid repeated SELECT lookups.
    _typeIds() {
        if (!this._typeCache) {
            const tagNodeType  = this.db.prepare("SELECT id FROM NodeTypes WHERE name = 'Tag'").get();
            const deckNodeType = this.db.prepare("SELECT id FROM NodeTypes WHERE name = 'Deck'").get();
            const inheritType  = this.db.prepare("SELECT id FROM ConnectionTypes WHERE name = 'inheritance'").get();
            const tagConnType  = this.db.prepare("SELECT id FROM ConnectionTypes WHERE name = 'tag'").get();
            const deckConnType = this.db.prepare("SELECT id FROM ConnectionTypes WHERE name = 'deck'").get();
            const linkConnType = this.db.prepare("SELECT id FROM ConnectionTypes WHERE name = 'link'").get();
            this._typeCache = {
                tagNodeTypeId:  tagNodeType?.id,
                deckNodeTypeId: deckNodeType?.id,
                inheritanceTypeId: inheritType?.id,
                tagConnTypeId:  tagConnType?.id,
                deckConnTypeId: deckConnType?.id,
                linkConnTypeId: linkConnType?.id,
            };
        }
        return this._typeCache;
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

    getDocumentByPath(relPath) {
        return this.db.prepare('SELECT * FROM Documents WHERE relative_path = ?').get(relPath);
    }

    insertDocument(data) {
        const stmt = this.db.prepare(`
            INSERT INTO Documents (folder_id, node_id, global_hash, relative_path, absolute_path, name, encoding, presence)
            VALUES (?, ?, ?, ?, ?, ?, ?, 0)
        `);
        const info = stmt.run(data.folderId, data.nodeId, data.globalHash, data.relativePath, data.absolutePath, data.name, data.encoding ?? null);
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
        return this.db.prepare('SELECT id, node_id, global_hash, level, sm2_reps, last_recall, content_id, card_type FROM Flashcards WHERE document_id = ?').all(documentId);
    }

    getFlashcardCountsByFolder(folderId) {
        return this.db.prepare(`
            SELECT d.name, COUNT(fc.id) AS count
            FROM Documents d
            LEFT JOIN Flashcards fc ON fc.document_id = d.id
            WHERE d.folder_id = ?
            GROUP BY d.id
        `).all(folderId);
    }

    getFlashcardCountInFolderTree(folderId) {
        return this.db.prepare(`
            WITH RECURSIVE folder_tree AS (
                SELECT id FROM Folders WHERE id = ?
                UNION ALL
                SELECT fo.id FROM Folders fo
                JOIN folder_tree ft ON fo.parent_id = ft.id
            )
            SELECT COUNT(fc.id) AS count
            FROM Documents d
            JOIN folder_tree ft ON d.folder_id = ft.id
            LEFT JOIN Flashcards fc ON fc.document_id = d.id
        `).get(folderId).count;
    }

    getFoldersByPaths(relPaths) {
        if (relPaths.length === 0) return [];
        const placeholders = relPaths.map(() => '?').join(', ');
        return this.db.prepare(`SELECT * FROM Folders WHERE relative_path IN (${placeholders})`).all(...relPaths);
    }

    // Returns a Map<folderId, count> covering each root and its entire subtree.
    getFlashcardCountsInFolderTrees(folderIds) {
        if (folderIds.length === 0) return new Map();
        const placeholders = folderIds.map(() => '?').join(', ');
        const rows = this.db.prepare(`
            WITH RECURSIVE folder_tree AS (
                SELECT id, id AS root_id FROM Folders WHERE id IN (${placeholders})
                UNION ALL
                SELECT fo.id, ft.root_id FROM Folders fo
                JOIN folder_tree ft ON fo.parent_id = ft.id
            )
            SELECT ft.root_id, COUNT(fc.id) AS count
            FROM folder_tree ft
            JOIN Documents d ON d.folder_id = ft.id
            LEFT JOIN Flashcards fc ON fc.document_id = d.id
            GROUP BY ft.root_id
        `).all(...folderIds);
        return new Map(rows.map(r => [r.root_id, r.count]));
    }

    insertFlashcard(data) {
        let customHtml = data.customData?.html || null;
        let frontText = null, backText = null, fImg = null, bImg = null, fSnd = null, bSnd = null;

        if (data.vanillaData) {
            frontText = data.vanillaData.frontText || null;
            backText = data.vanillaData.backText || null;
            if (data.vanillaData.media) {
                fImg = data.vanillaData.media.front_img || null;
                bImg = data.vanillaData.media.back_img || null;
                fSnd = data.vanillaData.media.front_sound || null;
                bSnd = data.vanillaData.media.back_sound || null;
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
            INSERT INTO Flashcards (global_hash, node_id, document_id, category_id, content_id, reference_id, last_recall, level, sm2_reps, name, fileIndex, presence, card_type)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
        `);
        return stmt.run(
            data.globalHash, data.nodeId, data.documentId, categoryId,
            contentInfo.lastInsertRowid, referenceId, data.lastRecall || null, data.level || 0, data.sm2Reps || 0,
            data.name || null, data.fileIndex || 0, data.cardType || 'basic'
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
            SET last_recall = ?, level = ?, sm2_reps = ?, category_id = ?, name = ?, fileIndex = ?, card_type = ?
            WHERE id = ?
        `).run(data.lastRecall, data.level ?? 0, data.sm2Reps ?? 0, categoryId, data.name || null, data.fileIndex, data.cardType || 'basic', id);

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
                    data.vanillaData.media.front_img || null, data.vanillaData.media.back_img || null,
                    data.vanillaData.media.front_sound || null, data.vanillaData.media.back_sound || null
                );
            }
        }
        
        if (contentUpdates.length > 0) {
            params.push(data.contentId);
            this.db.prepare(`UPDATE FlashcardContent SET ${contentUpdates.join(', ')} WHERE id = ?`).run(...params);
        }
    }

    deleteFlashcard(id) {
        this.db.prepare('DELETE FROM Flashcards WHERE id = ?').run(id);
        // Triggers handle: Nodes, FlashcardContent, FlashcardReference
    }

    getFlashcardByHash(hash) {
        return this.db.prepare('SELECT id, document_id FROM Flashcards WHERE global_hash = ?').get(hash);
    }

    setFlashcardSrsState(id, level, sm2Reps) {
        this.db.prepare('UPDATE Flashcards SET level = ?, sm2_reps = ? WHERE id = ?').run(level, sm2Reps, id);
    }

    getAllFlashcardSrsState() {
        return this.db.prepare('SELECT global_hash, level, sm2_reps, last_recall FROM Flashcards').all();
    }

    getLatestEaseFactors() {
        const rows = this.db.prepare(`
            SELECT f.global_hash, lr.ease_factor
            FROM Flashcards f
            JOIN ReviewLogs lr ON lr.flashcard_id = f.id
            WHERE lr.id IN (SELECT MAX(id) FROM ReviewLogs GROUP BY flashcard_id)
        `).all();
        return new Map(rows.map(r => [r.global_hash, r.ease_factor]));
    }

    batchSetSm2Reps(cards) {
        const stmt = this.db.prepare('UPDATE Flashcards SET sm2_reps = ? WHERE global_hash = ?');
        this.db.transaction((rows) => {
            for (const c of rows) stmt.run(c.sm2_reps, c.global_hash);
        })(cards);
    }

    batchSetLeitnerLevel(cards) {
        const stmt = this.db.prepare('UPDATE Flashcards SET level = ? WHERE global_hash = ?');
        this.db.transaction((rows) => {
            for (const c of rows) stmt.run(c.level, c.global_hash);
        })(cards);
    }

    batchRestoreFlashcardSrsState(states) {
        const stmt = this.db.prepare('UPDATE Flashcards SET level = ?, sm2_reps = ?, last_recall = ? WHERE global_hash = ?');
        this.db.transaction((rows) => {
            for (const s of rows) stmt.run(s.level ?? 0, s.sm2_reps ?? 0, s.last_recall, s.global_hash);
        })(states);
    }

    updateFlashcardReview(id, timestamp, newValue, algorithm = 'leitner') {
        if (algorithm === 'sm2') {
            this.db.prepare('UPDATE Flashcards SET last_recall = ?, sm2_reps = ? WHERE id = ?')
                .run(timestamp, newValue, id);
        } else {
            this.db.prepare('UPDATE Flashcards SET last_recall = ?, level = ? WHERE id = ?')
                .run(timestamp, newValue, id);
        }
    }

    insertReviewLog(data) {
        this.db.prepare(`
            INSERT INTO ReviewLogs (flashcard_id, timestamp, outcome, ease_factor, level)
            VALUES (?, ?, ?, ?, ?)
        `).run(data.flashcardId, data.timestamp, data.outcome, data.easeFactor, data.level);
    }

    // Undo support: drop a card's most recent review so a misgraded result can be
    // taken back. Returns true if a row was removed, false if the card had no logs.
    deleteLatestReviewLog(flashcardId) {
        const row = this.db.prepare(
            'SELECT id FROM ReviewLogs WHERE flashcard_id = ? ORDER BY id DESC LIMIT 1'
        ).get(flashcardId);
        if (!row) return false;
        this.db.prepare('DELETE FROM ReviewLogs WHERE id = ?').run(row.id);
        return true;
    }

    // The card's now-latest review after an undo — the state to restore it to.
    // Null when no reviews remain (the card is new again).
    getLatestReviewLog(flashcardId) {
        return this.db.prepare(
            'SELECT timestamp, outcome, ease_factor, level FROM ReviewLogs WHERE flashcard_id = ? ORDER BY id DESC LIMIT 1'
        ).get(flashcardId) ?? null;
    }

    // Restore a card's SRS state after an undo. Mirrors updateFlashcardReview but
    // allows a null last_recall (card reverts to never-reviewed) and touches only
    // the algorithm's own progress column.
    undoFlashcardReview(id, value, lastRecall, algorithm = 'leitner') {
        if (algorithm === 'sm2') {
            this.db.prepare('UPDATE Flashcards SET last_recall = ?, sm2_reps = ? WHERE id = ?')
                .run(lastRecall, value, id);
        } else {
            this.db.prepare('UPDATE Flashcards SET last_recall = ?, level = ? WHERE id = ?')
                .run(lastRecall, value, id);
        }
    }

    getLeitnerBoxes() {
        return this.db.prepare('SELECT level, COUNT(*) as count FROM Flashcards GROUP BY level ORDER BY level ASC').all();
    }

    getFlashcardCount() {
        return this.db.prepare('SELECT COUNT(*) as c FROM Flashcards').get().c;
    }

    getMasteredFlashcardCount(threshold) {
        return this.db.prepare('SELECT COUNT(*) as c FROM Flashcards WHERE level >= ?').get(threshold).c;
    }

    getDueFlashcards({ algorithm = 'leitner', folder = null, deck = null, tags = null, maxNew = 20, minPriority = 0 } = {}) {
        const params = [];
        const cteParts = [];
        const whereConditions = [];

        // Folder CTE is pushed first so its ? aligns with params[0].
        // The folder_tree CTE appears before the cards CTE in the SQL string,
        // so the bind order must match: folder → deck → tags → minPriority.
        if (folder !== null) {
            cteParts.push(`folder_tree AS (
                SELECT id FROM Folders WHERE relative_path = ?
                UNION ALL
                SELECT fo.id FROM Folders fo
                JOIN folder_tree ft ON fo.parent_id = ft.id
            )`);
            params.push(folder);
            whereConditions.push('d.folder_id IN (SELECT id FROM folder_tree)');
        }

        if (deck !== null) {
            whereConditions.push(`f.global_hash IN (
                SELECT de.card_hash FROM DeckEntries de
                JOIN Decks dk ON dk.id = de.deck_id
                WHERE dk.global_hash = ?
            )`);
            params.push(deck);
        }

        if (algorithm === 'sm2') {
            cteParts.push(`latest_ef AS (
                SELECT flashcard_id, ease_factor FROM ReviewLogs
                WHERE id IN (SELECT MAX(id) FROM ReviewLogs GROUP BY flashcard_id)
            )`);
        }

        if (tags && tags.length > 0) {
            const placeholders = tags.map(() => '?').join(', ');
            whereConditions.push(`EXISTS (
                SELECT 1 FROM Connections ctag
                JOIN Tags tg ON tg.node_id = ctag.destiny_id
                WHERE ctag.origin_id = f.node_id
                  AND ctag.type_id = (SELECT id FROM ConnectionTypes WHERE name = 'tag')
                  AND tg.name IN (${placeholders})
            )`);
            params.push(...tags);
        }

        if (minPriority > 0) {
            whereConditions.push('COALESCE(pc.priority, 0) >= ?');
            params.push(minPriority);
        }

        const extraWhere = whereConditions.length > 0
            ? 'AND ' + whereConditions.join('\n          AND ')
            : '';

        const sm2Join = algorithm === 'sm2'
            ? 'LEFT JOIN latest_ef lr ON lr.flashcard_id = f.id'
            : '';

        // SM-2 ease factor: standard range is 1.3–3.0 (default 2.5).
        // Values < 1.3 are from the old 0–1 scale and are treated as the default.
        const easeFactorExpr = algorithm === 'sm2'
            ? `CASE WHEN lr.ease_factor IS NULL OR lr.ease_factor < 1.3 THEN 2.5 ELSE lr.ease_factor END`
            : `2.5`;

        // Leitner: interval doubles each box (level 1 → 1d, 2 → 2d, 3 → 4d, ...)
        // SM-2: I1=1d, I2=6d, In=round(6 * ef^(n-2)) for n>2 using sm2_reps
        // Both capped at 365 days — no card should be hidden for more than a year.
        const intervalExpr = algorithm === 'sm2'
            ? `CASE
                WHEN COALESCE(f.sm2_reps, 0) <= 1 THEN 1
                WHEN f.sm2_reps = 2 THEN 6
                ELSE min(365, CAST(ROUND(6.0 * pow(${easeFactorExpr}, CAST(f.sm2_reps - 2 AS REAL))) AS INTEGER))
               END`
            : `CASE
                WHEN COALESCE(f.level, 0) <= 0 THEN 0
                ELSE min(365, CAST(pow(2.0, CAST(COALESCE(f.level, 0) - 1 AS REAL)) AS INTEGER))
               END`;

        // Expose the algorithm-relevant count as "level" so the frontend shows a
        // meaningful number regardless of which algorithm is active.
        const levelExpr = algorithm === 'sm2'
            ? 'COALESCE(f.sm2_reps, 0)'
            : 'COALESCE(f.level, 0)';

        cteParts.push(`cards AS (
            SELECT
                f.global_hash,
                ${levelExpr} AS level,
                f.last_recall,
                f.name,
                f.card_type,
                d.relative_path AS document_path,
                pc.name AS category,
                COALESCE(pc.priority, 0) AS category_priority,
                fc.custom_html,
                fc.render_html,
                fc.frontText,
                fc.backText,
                fc.front_img,
                fc.back_img,
                fc.front_sound,
                fc.back_sound,
                ${easeFactorExpr} AS ease_factor,
                ${intervalExpr} AS interval_days
            FROM Flashcards f
            LEFT JOIN Documents d ON d.id = f.document_id
            JOIN FlashcardContent fc ON fc.id = f.content_id
            LEFT JOIN PedagogicalCategories pc ON pc.id = f.category_id
            ${sm2Join}
            WHERE 1=1
            ${extraWhere}
        )`);

        const allRows = this.db.prepare(`
            WITH RECURSIVE ${cteParts.join(',\n')}
            SELECT *,
              CASE
                WHEN last_recall IS NULL THEN NULL
                ELSE datetime(last_recall, '+' || CAST(interval_days AS TEXT) || ' days')
              END AS due_date,
              CASE
                WHEN last_recall IS NULL THEN 'new'
                WHEN datetime(last_recall, '+' || CAST(interval_days AS TEXT) || ' days') <= datetime('now') THEN 'due'
                ELSE 'future'
              END AS _status
            FROM cards
        `).all(...params);

        // Sort by category_priority ASC (lower = more foundational = study first),
        // then by due_date for due cards to surface the most overdue within each priority.
        const due = allRows
            .filter(r => r._status === 'due')
            .sort((a, b) => (a.category_priority - b.category_priority)
                || (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0));
        const newCards = allRows
            .filter(r => r._status === 'new')
            .sort((a, b) => a.category_priority - b.category_priority)
            .slice(0, maxNew);
        let nextDue = null;
        for (const r of allRows) {
            if (r._status === 'future' && (nextDue === null || r.due_date < nextDue)) nextDue = r.due_date;
        }

        return { due, newCards, nextDue };
    }

    // --- Tags ---

    getAllTags() {
        return this.db.prepare('SELECT DISTINCT name FROM Tags ORDER BY name ASC').all().map(r => r.name);
    }

    getTagByName(name) {
        return this.db.prepare('SELECT * FROM Tags WHERE name = ?').get(name);
    }

    insertTag(name, nodeId) {
        return this.db.prepare('INSERT INTO Tags (name, node_id, presence) VALUES (?, ?, 0)').run(name, nodeId);
    }

    syncNodeTags(nodeId, tagNodeIds) {
        const { tagNodeTypeId, tagConnTypeId } = this._typeIds();

        const currentConns = this.db.prepare(`
            SELECT c.id, c.destiny_id FROM Connections c
            JOIN Nodes n ON c.destiny_id = n.id
            WHERE c.origin_id = ? AND n.type_id = ? AND c.type_id = ?
        `).all(nodeId, tagNodeTypeId, tagConnTypeId);

        const currentTagIdSet = new Set(currentConns.map(c => c.destiny_id));
        const tagNodeIdSet = new Set(tagNodeIds);

        for (const tid of tagNodeIds) {
            if (!currentTagIdSet.has(tid)) {
                this.db.prepare("INSERT INTO Connections (origin_id, destiny_id, type_id) VALUES (?, ?, ?)").run(nodeId, tid, tagConnTypeId);
            }
        }
        for (const conn of currentConns) {
            if (!tagNodeIdSet.has(conn.destiny_id)) {
                this.db.prepare("DELETE FROM Connections WHERE id = ?").run(conn.id);
                this.deleteTagIfOrphaned(conn.destiny_id);
            }
        }
    }

    // Removes a Tag whose node no longer has any 'tag' connection pointing to it,
    // so tags with zero references stop showing up in getAllTags()/list_tags.
    // Deleting the Tags row cascades to its Node (AFTER DELETE trigger) and to any
    // InheritedTags via tag_id ON DELETE CASCADE.
    deleteTagIfOrphaned(tagNodeId) {
        const { tagConnTypeId } = this._typeIds();
        const remaining = this.db.prepare(
            "SELECT 1 FROM Connections WHERE destiny_id = ? AND type_id = ? LIMIT 1"
        ).get(tagNodeId, tagConnTypeId);
        if (!remaining) {
            this.db.prepare("DELETE FROM Tags WHERE node_id = ?").run(tagNodeId);
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

    getMediaByHash(hash) {
        return this.db.prepare('SELECT * FROM Media WHERE hash = ?').get(hash);
    }

    deleteMediaByAbsPath(absolutePath) {
        return this.db.prepare('DELETE FROM Media WHERE absolute_path = ?').run(absolutePath);
    }

    getMediaByAbsPathPrefix(prefix) {
        return this.db.prepare('SELECT * FROM Media WHERE absolute_path LIKE ?').all(prefix + '%');
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
        this.db.prepare(`UPDATE Documents SET relative_path = ? || substr(relative_path, length(?) + 1), absolute_path = ? || substr(absolute_path, length(?) + 1) WHERE absolute_path LIKE ? || '%' ESCAPE '\\'`)
            .run(newRelPath, oldRelPath, newAbsPath, oldAbsPath, this._escapeLike(oldAbsPath));
    }

    cascadeRenameFolderPaths(oldRelPath, newRelPath, oldAbsPath, newAbsPath) {
        this.db.prepare(`UPDATE Folders SET relative_path = ? || substr(relative_path, length(?) + 1), absolute_path = ? || substr(absolute_path, length(?) + 1) WHERE absolute_path LIKE ? || '%' ESCAPE '\\'`)
            .run(newRelPath, oldRelPath, newAbsPath, oldAbsPath, this._escapeLike(oldAbsPath));
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

    getDocumentsByAbsPathPrefix(absPrefix) {
        return this.db.prepare(`SELECT absolute_path, relative_path FROM Documents WHERE absolute_path LIKE ? || '%' ESCAPE '\\'`)
            .all(this._escapeLike(absPrefix));
    }

    getFoldersByAbsPathPrefix(absPrefix, excludeAbsPath) {
        return this.db.prepare(`SELECT absolute_path, relative_path FROM Folders WHERE absolute_path LIKE ? || '%' ESCAPE '\\' AND absolute_path != ?`)
            .all(this._escapeLike(absPrefix), excludeAbsPath);
    }

    // --- Connections ---

    insertInheritance(parentNodeId, childNodeId) {
        const typeId = this._typeIds().inheritanceTypeId;
        if (!typeId) throw new Error('inheritance connection type missing');
        return this.db.prepare(
            'INSERT INTO Connections (origin_id, destiny_id, type_id) VALUES (?, ?, ?)'
        ).run(parentNodeId, childNodeId, typeId);
    }

    deleteInheritance(parentNodeId, childNodeId) {
        const typeId = this._typeIds().inheritanceTypeId;
        if (!typeId) return;
        this.db.prepare(
            'DELETE FROM Connections WHERE origin_id = ? AND destiny_id = ? AND type_id = ?'
        ).run(parentNodeId, childNodeId, typeId);
    }

    getNodeIdByFolderAbsPath(absPath) {
        const row = this.db.prepare('SELECT node_id FROM Folders WHERE absolute_path = ?').get(absPath);
        return row ? row.node_id : null;
    }

    getNodeIdByDocumentAbsPath(absPath) {
        const row = this.db.prepare('SELECT node_id FROM Documents WHERE absolute_path = ?').get(absPath);
        return row ? row.node_id : null;
    }

    // --- Search & Graph ---

    search(query) {
        const term = `%${query}%`;
        const docs = this.db.prepare(`SELECT 'document' as type, name, relative_path, global_hash FROM Documents WHERE name LIKE ?`).all(term);
        const cards = this.db.prepare(`
            SELECT 'flashcard' as type, f.global_hash, c.frontText, c.backText
            FROM Flashcards f JOIN FlashcardContent c ON f.content_id = c.id
            WHERE c.frontText LIKE ? OR c.backText LIKE ? OR f.global_hash = ? OR f.name LIKE ?
        `).all(term, term, query, term);
        const tags = this.db.prepare(`SELECT 'tag' as type, t.name, null as frontText, null as backText FROM Tags t WHERE t.name LIKE ?`).all(term);
        return [...docs, ...cards, ...tags];
    }

    // Unified search across all entity types.
    // - Global mode (only q): returns { folders, documents, flashcards, tags, decks }
    // - Filter mode (tag/deck/document/folder): returns { flashcards } matching all supplied filters
    superSearch({ q = null, tag = null, deck = null, document: docQ = null, folder = null, limit = 20 } = {}) {
        const hasFilter = tag || deck || docQ || folder;
        if (hasFilter) {
            return { flashcards: this._searchFlashcards({ q, tag, deck, docQ, folder, limit }) };
        }

        if (!q || !q.trim()) return { folders: [], documents: [], flashcards: [], tags: [], decks: [] };
        const term = `%${q.trim()}%`;

        const folders = this.db.prepare(
            `SELECT name, relative_path as path, global_hash FROM Folders WHERE name LIKE ? LIMIT ?`
        ).all(term, limit);

        const documents = this.db.prepare(
            `SELECT name, relative_path as path, global_hash FROM Documents WHERE name LIKE ? LIMIT ?`
        ).all(term, limit);

        const flashcards = this.db.prepare(`
            SELECT f.global_hash, f.name, f.card_type, f.level,
                   c.frontText, c.backText,
                   d.relative_path as document_path, d.name as document_name
            FROM Flashcards f
            JOIN FlashcardContent c ON f.content_id = c.id
            LEFT JOIN Documents d ON d.id = f.document_id
            WHERE c.frontText LIKE ? OR c.backText LIKE ? OR f.name LIKE ?
            LIMIT ?
        `).all(term, term, term, limit);

        const tags = this.db.prepare(
            `SELECT name FROM Tags WHERE name LIKE ? LIMIT ?`
        ).all(term, limit);

        const decks = this.db.prepare(
            `SELECT name, global_hash FROM Decks WHERE name LIKE ? LIMIT ?`
        ).all(term, limit);

        return { folders, documents, flashcards, tags, decks };
    }

    _searchFlashcards({ q = null, tag = null, deck = null, docQ = null, folder = null, limit = 50 } = {}) {
        const conditions = [];
        const cteParams = [];
        const condParams = [];
        let cteSQL = '';

        if (folder) {
            const fTerm = `%${folder}%`;
            cteSQL = `WITH RECURSIVE folder_tree AS (
                SELECT id FROM Folders WHERE name LIKE ? OR relative_path LIKE ?
                UNION ALL
                SELECT fo.id FROM Folders fo
                JOIN folder_tree ft ON fo.parent_id = ft.id
            )`;
            cteParams.push(fTerm, fTerm);
            conditions.push('d.folder_id IN (SELECT id FROM folder_tree)');
        }

        if (tag) {
            conditions.push(`(
                EXISTS (
                    SELECT 1 FROM Connections ctag
                    JOIN Tags tg ON tg.node_id = ctag.destiny_id
                    WHERE ctag.origin_id = f.node_id
                      AND ctag.type_id = (SELECT id FROM ConnectionTypes WHERE name = 'tag')
                      AND tg.name LIKE ?
                )
                OR EXISTS (
                    SELECT 1 FROM InheritedTags it
                    JOIN Connections c ON it.connection_id = c.id
                    JOIN Tags tg ON tg.id = it.tag_id
                    WHERE c.destiny_id = f.node_id
                      AND c.type_id = (SELECT id FROM ConnectionTypes WHERE name = 'inheritance')
                      AND tg.name LIKE ?
                )
            )`);
            condParams.push(`%${tag}%`, `%${tag}%`);
        }

        if (deck) {
            // Accepts either an exact globalHash (programmatic callers — MCP tools,
            // getDueFlashcards elsewhere uses hash-only) or a name substring (the
            // in-app search modal's `deck:<name>` prefix syntax, human-typed).
            conditions.push(`f.global_hash IN (
                SELECT de.card_hash FROM DeckEntries de
                JOIN Decks dk ON dk.id = de.deck_id
                WHERE dk.global_hash = ? OR dk.name LIKE ?
            )`);
            condParams.push(deck, `%${deck}%`);
        }

        if (docQ) {
            conditions.push('(d.name LIKE ? OR d.relative_path LIKE ?)');
            condParams.push(`%${docQ}%`, `%${docQ}%`);
        }

        if (q) {
            conditions.push('(c.frontText LIKE ? OR c.backText LIKE ? OR f.name LIKE ?)');
            condParams.push(`%${q}%`, `%${q}%`, `%${q}%`);
        }

        const whereSQL = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        const allParams = [...cteParams, ...condParams, limit];

        return this.db.prepare(`
            ${cteSQL}
            SELECT f.global_hash, f.name, f.card_type, f.level,
                   c.frontText, c.backText,
                   d.relative_path as document_path, d.name as document_name
            FROM Flashcards f
            JOIN FlashcardContent c ON f.content_id = c.id
            LEFT JOIN Documents d ON d.id = f.document_id
            ${whereSQL}
            LIMIT ?
        `).all(...allParams);
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
        return { id: this._typeIds().inheritanceTypeId };
    }

    getInheritedTagNames(nodeId) {
        return this.db.prepare(`
            SELECT t.name FROM InheritedTags it
            JOIN Connections c ON it.connection_id = c.id
            JOIN Tags t ON t.id = it.tag_id
            WHERE c.destiny_id = ? AND c.type_id = (SELECT id FROM ConnectionTypes WHERE name = 'inheritance')
        `).all(nodeId).map(t => t.name);
    }

    getDirectTagNames(nodeId) {
        const { tagConnTypeId } = this._typeIds();
        return this.db.prepare(`
            SELECT t.name FROM Connections c
            JOIN Tags t ON t.node_id = c.destiny_id
            WHERE c.origin_id = ? AND c.type_id = ?
        `).all(nodeId, tagConnTypeId).map(r => r.name);
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
                   COALESCE(d.name, f.name, t.name, fc.name, dk.name) as label,
                   COALESCE(d.presence, f.presence, fc.presence, 0) as presence,
                   d.relative_path  as documentPath,
                   fc.global_hash   as flashcardHash,
                   fcc.frontText    as flashcardFront,
                   fcd.relative_path as flashcardDocPath,
                   dk.is_system      as deckIsSystem
            FROM Nodes n
            JOIN NodeTypes nt ON n.type_id = nt.id
            LEFT JOIN Documents d   ON d.node_id   = n.id
            LEFT JOIN Folders f     ON f.node_id   = n.id
            LEFT JOIN Tags t        ON t.node_id   = n.id
            LEFT JOIN Flashcards fc ON fc.node_id  = n.id
            LEFT JOIN FlashcardContent fcc ON fcc.id = fc.content_id
            LEFT JOIN Documents fcd        ON fcd.id = fc.document_id
            LEFT JOIN Decks dk ON dk.node_id = n.id
            WHERE NOT (
                nt.name = 'Deck' AND NOT EXISTS (
                    SELECT 1 FROM Connections c2
                    JOIN ConnectionTypes ct2 ON c2.type_id = ct2.id
                    WHERE c2.origin_id = n.id AND ct2.name = 'deck'
                )
            )
        `).all();

        const edges = this.db.prepare(`
            SELECT source.id as fromId, target.id as toId, ct.name as relation
            FROM Connections c
            JOIN Nodes source ON c.origin_id = source.id
            JOIN Nodes target ON c.destiny_id = target.id
            JOIN ConnectionTypes ct ON c.type_id = ct.id

            UNION ALL

            SELECT fc.node_id as fromId, d.node_id as toId, 'reference' as relation
            FROM Flashcards fc
            JOIN Documents d ON fc.document_id = d.id

            UNION ALL

            SELECT c.destiny_id as fromId, tg.node_id as toId, 'tag' as relation
            FROM InheritedTags it
            JOIN Connections c ON it.connection_id = c.id
            JOIN Tags tg ON tg.id = it.tag_id
        `).all();

        return { nodes, edges };
    }

    // --- Document Links ---

    getDocumentByHash(hash) {
        return this.db.prepare('SELECT id, node_id, relative_path, name FROM Documents WHERE global_hash = ?').get(hash);
    }

    upsertDocumentLinkQueue(sourceHash, targetHash, anchorText) {
        return this.db.prepare(
            'INSERT OR IGNORE INTO DocumentLinks (source_hash, target_hash, anchor_text) VALUES (?, ?, ?)'
        ).run(sourceHash, targetHash, anchorText ?? '');
    }

    getPendingLinksForTarget(targetHash) {
        return this.db.prepare('SELECT * FROM DocumentLinks WHERE target_hash = ?').all(targetHash);
    }

    getPendingLinksFromSource(sourceHash) {
        return this.db.prepare('SELECT * FROM DocumentLinks WHERE source_hash = ?').all(sourceHash);
    }

    deleteDocumentLinkQueueBySource(sourceHash) {
        return this.db.prepare('DELETE FROM DocumentLinks WHERE source_hash = ?').run(sourceHash);
    }

    deleteDocumentLinkConnections(nodeId) {
        const { linkConnTypeId } = this._typeIds();
        if (!linkConnTypeId) return;
        return this.db.prepare(
            'DELETE FROM Connections WHERE origin_id = ? AND type_id = ?'
        ).run(nodeId, linkConnTypeId);
    }

    insertDocumentLinkConnection(sourceNodeId, targetNodeId) {
        const { linkConnTypeId } = this._typeIds();
        if (!linkConnTypeId) throw new Error('link ConnectionType missing — run migrations');
        return this.db.prepare(
            'INSERT INTO Connections (origin_id, destiny_id, type_id) VALUES (?, ?, ?)'
        ).run(sourceNodeId, targetNodeId, linkConnTypeId);
    }

    // --- Decks ---

    insertDeck(data) {
        const { deckNodeTypeId } = this._typeIds();
        if (!deckNodeTypeId) throw new Error('Deck node type missing — run migrations');
        const nodeInfo = this.db.prepare('INSERT INTO Nodes (type_id) VALUES (?)').run(deckNodeTypeId);
        const nodeId = nodeInfo.lastInsertRowid;
        const info = this.db.prepare(`
            INSERT INTO Decks (node_id, global_hash, name, description, is_system)
            VALUES (?, ?, ?, ?, ?)
        `).run(nodeId, data.globalHash, data.name, data.description ?? null, data.isSystem ?? 0);
        return info.lastInsertRowid;
    }

    getDeckByHash(hash) {
        return this.db.prepare('SELECT id, node_id, global_hash, name, description, is_system, created_at, updated_at FROM Decks WHERE global_hash = ?').get(hash);
    }

    getSystemDeck() {
        return this.db.prepare('SELECT id, node_id, global_hash, name, description, is_system, created_at, updated_at FROM Decks WHERE is_system = 1 LIMIT 1').get();
    }

    getFlashcardNodeIdByHash(cardHash) {
        const row = this.db.prepare('SELECT node_id FROM Flashcards WHERE global_hash = ?').get(cardHash);
        return row?.node_id ?? null;
    }

    insertDeckConnection(deckNodeId, cardNodeId) {
        const { deckConnTypeId } = this._typeIds();
        if (!deckConnTypeId) return;
        this.db.prepare(
            'INSERT INTO Connections (origin_id, destiny_id, type_id) VALUES (?, ?, ?)'
        ).run(deckNodeId, cardNodeId, deckConnTypeId);
    }

    deleteDeckConnection(deckNodeId, cardNodeId) {
        const { deckConnTypeId } = this._typeIds();
        if (!deckConnTypeId) return;
        this.db.prepare(
            'DELETE FROM Connections WHERE origin_id = ? AND destiny_id = ? AND type_id = ?'
        ).run(deckNodeId, cardNodeId, deckConnTypeId);
    }

    getAllDecks() {
        return this.db.prepare(`
            SELECT d.*, COUNT(e.id) as entry_count
            FROM Decks d
            LEFT JOIN DeckEntries e ON e.deck_id = d.id
            GROUP BY d.id
            ORDER BY d.updated_at DESC
        `).all();
    }

    updateDeck(id, data) {
        this.db.prepare(`
            UPDATE Decks SET name = ?, description = ?, updated_at = datetime('now')
            WHERE id = ?
        `).run(data.name, data.description ?? null, id);
    }

    deleteDeck(id) {
        this.db.prepare('DELETE FROM Decks WHERE id = ?').run(id);
    }

    insertDeckEntry(data) {
        return this.db.prepare(`
            INSERT INTO DeckEntries (deck_id, card_hash, document_path, position, inline_card)
            VALUES (?, ?, ?, ?, ?)
        `).run(data.deckId, data.cardHash, data.documentPath ?? null, data.position ?? 0, data.inlineCard ?? null);
    }

    getDeckEntries(deckId) {
        return this.db.prepare(`
            SELECT e.*, f.level, f.last_recall, f.card_type, f.name as card_name,
                   c.frontText, c.backText, c.custom_html
            FROM DeckEntries e
            LEFT JOIN Flashcards f ON f.global_hash = e.card_hash
            LEFT JOIN FlashcardContent c ON c.id = f.content_id
            WHERE e.deck_id = ?
            ORDER BY e.position ASC, e.id ASC
        `).all(deckId);
    }

    getDeckEntryByCardHash(deckId, cardHash) {
        return this.db.prepare('SELECT id FROM DeckEntries WHERE deck_id = ? AND card_hash = ?').get(deckId, cardHash);
    }

    deleteDeckEntry(deckId, cardHash) {
        this.db.prepare('DELETE FROM DeckEntries WHERE deck_id = ? AND card_hash = ?').run(deckId, cardHash);
    }

    getDeckEntryCount(deckId) {
        return this.db.prepare('SELECT COUNT(*) as c FROM DeckEntries WHERE deck_id = ?').get(deckId).c;
    }

    // --- Card Browser ---

    getAllFlashcards({ search = null, level = null, cardType = null, sortBy = 'level', sortDir = 'desc', limit = 50, offset = 0 } = {}) {
        const params = [];
        const conditions = [];

        if (search) {
            const term = `%${search}%`;
            conditions.push('(c.frontText LIKE ? OR c.backText LIKE ? OR f.name LIKE ?)');
            params.push(term, term, term);
        }
        if (level !== null) {
            conditions.push('f.level = ?');
            params.push(level);
        }
        if (cardType) {
            conditions.push('f.card_type = ?');
            params.push(cardType);
        }

        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        const sortCols = { level: 'f.level', name: 'f.name', last_recall: 'f.last_recall' };
        const sortCol = sortCols[sortBy] ?? 'f.level';
        const dir = sortDir === 'asc' ? 'ASC' : 'DESC';

        params.push(limit, offset);

        return this.db.prepare(`
            SELECT f.global_hash, f.name, f.level, f.last_recall, f.card_type,
                   c.frontText, c.backText, c.custom_html,
                   d.relative_path as document_path, d.name as document_name,
                   pc.name as category
            FROM Flashcards f
            JOIN FlashcardContent c ON f.content_id = c.id
            LEFT JOIN Documents d ON f.document_id = d.id
            LEFT JOIN PedagogicalCategories pc ON f.category_id = pc.id
            ${where}
            ORDER BY ${sortCol} ${dir}, f.name ASC
            LIMIT ? OFFSET ?
        `).all(...params);
    }

    getFlashcardCountFiltered({ search = null, level = null, cardType = null } = {}) {
        const params = [];
        const conditions = [];

        if (search) {
            const term = `%${search}%`;
            conditions.push('(c.frontText LIKE ? OR c.backText LIKE ? OR f.name LIKE ?)');
            params.push(term, term, term);
        }
        if (level !== null) {
            conditions.push('f.level = ?');
            params.push(level);
        }
        if (cardType) {
            conditions.push('f.card_type = ?');
            params.push(cardType);
        }

        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        const contentJoin = search ? 'JOIN FlashcardContent c ON f.content_id = c.id' : '';

        return this.db.prepare(`
            SELECT COUNT(*) as c FROM Flashcards f ${contentJoin} ${where}
        `).get(...params).c;
    }

    updateFlashcardContentByHash(hash, { frontText, backText, name, cardType, category }) {
        const card = this.db.prepare('SELECT id, content_id FROM Flashcards WHERE global_hash = ?').get(hash);
        if (!card) return false;
        let categoryId = null;
        if (category) {
            const cat = this.db.prepare("SELECT id FROM PedagogicalCategories WHERE name = ?").get(category);
            if (cat) categoryId = cat.id;
        }
        this.db.prepare('UPDATE Flashcards SET name = ?, card_type = ?, category_id = ? WHERE id = ?')
            .run(name || null, cardType || 'basic', categoryId, card.id);
        this.db.prepare('UPDATE FlashcardContent SET frontText = ?, backText = ? WHERE id = ?')
            .run(frontText || null, backText || null, card.content_id);
        return true;
    }

    deleteFlashcardDeckEntries(cardHash) {
        return this.db.prepare('DELETE FROM DeckEntries WHERE card_hash = ?').run(cardHash);
    }

    // --- Doctor / Reconciliation ---

    integrityCheck() {
        return this.db.prepare('PRAGMA integrity_check').get().integrity_check;
    }

    getAllDocuments() {
        return this.db.prepare('SELECT id, folder_id, node_id, global_hash, relative_path, absolute_path, name, encoding FROM Documents').all();
    }

    getAllFolders() {
        return this.db.prepare('SELECT id, parent_id, node_id, global_hash, relative_path, absolute_path, name FROM Folders').all();
    }

    getAllMedia() {
        return this.db.prepare('SELECT id, hash, name, relative_path, absolute_path FROM Media').all();
    }

    getStandaloneCardCount() {
        return this.db.prepare('SELECT COUNT(*) as c FROM Flashcards WHERE document_id IS NULL').get().c;
    }

    getPendingLinkCount() {
        return this.db.prepare('SELECT COUNT(*) as c FROM DocumentLinks').get().c;
    }

    updateDeckEntryInlineCard(deckId, cardHash, inlineCard) {
        this.db.prepare('UPDATE DeckEntries SET inline_card = ? WHERE deck_id = ? AND card_hash = ?')
            .run(inlineCard, deckId, cardHash);
    }

    // Rebuild only: a card's SM-2 ease factor lives in its latest ReviewLogs row
    // (see getLatestEaseFactors), so recovery re-seeds one synthetic log entry per
    // card. outcome is NULL to mark it as synthetic rather than a real review.
    insertSyntheticReviewLog(flashcardId, easeFactor, level) {
        this.db.prepare(`
            INSERT INTO ReviewLogs (flashcard_id, timestamp, outcome, ease_factor, level)
            VALUES (?, datetime('now'), NULL, ?, ?)
        `).run(flashcardId, easeFactor, level ?? 0);
    }

    // Deletes all rows derived from the canonical layer, keeping reference data
    // (NodeTypes, ConnectionTypes, PedagogicalCategories, SchemaVersion) and
    // Subscriptions. Order respects FKs; entity-delete triggers clean up
    // FlashcardContent/FlashcardReference, and the final Nodes sweep is safe
    // because every table referencing node_id has just been emptied.
    wipeDerivedContent() {
        this.db.transaction(() => {
            this.db.prepare('DELETE FROM DeckEntries').run();
            this.db.prepare('DELETE FROM InheritedTags').run();
            this.db.prepare('DELETE FROM ReviewLogs').run();
            this.db.prepare('DELETE FROM DocumentLinks').run();
            this.db.prepare('DELETE FROM Highlights').run();
            this.db.prepare('DELETE FROM Flashcards').run();
            this.db.prepare('DELETE FROM Documents').run();
            this.db.prepare('DELETE FROM Folders').run();
            this.db.prepare('DELETE FROM Decks').run();
            this.db.prepare('DELETE FROM Tags').run();
            this.db.prepare('DELETE FROM Media').run();
            this.db.prepare('DELETE FROM Connections').run();
            this.db.prepare('DELETE FROM Nodes').run();
        })();
    }

    // --- Highlights ---

    getHighlightsByDocumentId(documentId) {
        return this.db.prepare(
            'SELECT * FROM Highlights WHERE document_id = ? ORDER BY start ASC'
        ).all(documentId);
    }

    getHighlightByHash(hash) {
        return this.db.prepare('SELECT * FROM Highlights WHERE global_hash = ?').get(hash);
    }

    insertHighlight(data) {
        return this.db.prepare(`
            INSERT INTO Highlights (document_id, global_hash, type, start, end, page, bbox, color, note, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            data.documentId, data.globalHash, data.type ?? 'text_offset',
            data.start ?? null, data.end ?? null, data.page ?? null,
            data.bbox ?? null, data.color ?? 'amber', data.note ?? '',
            data.createdAt ?? new Date().toISOString()
        );
    }

    updateHighlight(hash, data) {
        return this.db.prepare(
            'UPDATE Highlights SET color = ?, note = ? WHERE global_hash = ?'
        ).run(data.color, data.note ?? '', hash);
    }

    deleteHighlight(hash) {
        return this.db.prepare('DELETE FROM Highlights WHERE global_hash = ?').run(hash);
    }

    syncDocumentHighlights(documentId, highlightsData) {
        const existing = this.getHighlightsByDocumentId(documentId);
        const existingMap = new Map(existing.map(h => [h.global_hash, h]));
        const incoming = new Set();

        for (const h of highlightsData) {
            incoming.add(h.id);
            if (!existingMap.has(h.id)) {
                this.insertHighlight({
                    documentId,
                    globalHash: h.id,
                    type: h.type,
                    start: h.start,
                    end: h.end,
                    page: h.page,
                    bbox: h.bbox ? JSON.stringify(h.bbox) : null,
                    color: h.color,
                    note: h.note,
                    createdAt: h.createdAt,
                });
            }
        }

        for (const [hash] of existingMap) {
            if (!incoming.has(hash)) this.deleteHighlight(hash);
        }
    }

    // --- Pedagogical Categories ---

    getCategories() {
        return this.db.prepare(
            'SELECT id, name, priority, description FROM PedagogicalCategories ORDER BY priority ASC, name ASC'
        ).all();
    }

    getCategoryByName(name) {
        return this.db.prepare('SELECT id, name, priority, description FROM PedagogicalCategories WHERE name = ?').get(name);
    }

    getCategoryUsageCount(id) {
        return this.db.prepare(
            'SELECT COUNT(*) as c FROM Flashcards WHERE category_id = ?'
        ).get(id).c;
    }

    insertCategory({ name, priority = 0, description = '' }) {
        return this.db.prepare(
            'INSERT INTO PedagogicalCategories (name, priority, description) VALUES (?, ?, ?)'
        ).run(name, priority, description).lastInsertRowid;
    }

    updateCategory(id, data) {
        const fields = [];
        const params = [];
        if (data.name !== undefined)        { fields.push('name = ?');        params.push(data.name); }
        if (data.priority !== undefined)    { fields.push('priority = ?');    params.push(data.priority); }
        if (data.description !== undefined) { fields.push('description = ?'); params.push(data.description); }
        if (!fields.length) return;
        params.push(id);
        this.db.prepare(`UPDATE PedagogicalCategories SET ${fields.join(', ')} WHERE id = ?`).run(...params);
    }

    deleteCategory(id) {
        this.db.prepare('DELETE FROM PedagogicalCategories WHERE id = ?').run(id);
    }
}

export default new DocumentQuery();
