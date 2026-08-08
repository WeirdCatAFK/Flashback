/**
 * Query.js
 * Data Access Layer for Flashback.
 * Handles all direct SQLite interactions.
 */

import db from '../primitives/database.js';

/**
 * Per-card "how well learned is this" score in 0..1, as a SQL expression over a
 * Flashcards row aliased as `t`.
 *
 * FSRS stability is the truest memory-strength number the app has, so it wins
 * when present; cards scheduled under Leitner/SM-2 have none and fall back to
 * the app-wide `level` scalar. Level 6 maps to 1.0 — just past the vault-wide
 * mastery threshold of 5 (orchestration/srs.js).
 *
 * The stability arm is a ladder of log-spaced bins rather than an actual log():
 * SQLite's math functions are a compile-time option we can't rely on.
 */
const CARD_LEARNED_SQL = (t) => `
    CASE
      WHEN ${t}.fsrs_stability IS NOT NULL THEN
        CASE WHEN ${t}.fsrs_stability >= 180 THEN 1.00
             WHEN ${t}.fsrs_stability >=  90 THEN 0.90
             WHEN ${t}.fsrs_stability >=  30 THEN 0.75
             WHEN ${t}.fsrs_stability >=  14 THEN 0.60
             WHEN ${t}.fsrs_stability >=   7 THEN 0.45
             WHEN ${t}.fsrs_stability >=   3 THEN 0.30
             WHEN ${t}.fsrs_stability >=   1 THEN 0.15
             ELSE 0.05 END
      ELSE MIN(1.0, COALESCE(${t}.level, 0) / 6.0)
    END`;

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
        return this.db.prepare(`SELECT id, node_id, global_hash, level, sm2_reps, last_recall,
            fsrs_stability, fsrs_difficulty, fsrs_due, fsrs_state, fsrs_reps, fsrs_lapses,
            content_id, card_type FROM Flashcards WHERE document_id = ?`).all(documentId);
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
        let frontText = null, backText = null, answerText = null;
        let fImg = null, bImg = null, fSnd = null, bSnd = null;

        if (data.vanillaData) {
            frontText = data.vanillaData.frontText || null;
            backText = data.vanillaData.backText || null;
            answerText = data.vanillaData.answerText || null;
            if (data.vanillaData.media) {
                fImg = data.vanillaData.media.front_img || null;
                bImg = data.vanillaData.media.back_img || null;
                fSnd = data.vanillaData.media.front_sound || null;
                bSnd = data.vanillaData.media.back_sound || null;
            }
        }

        // 1. Content
        const contentStmt = this.db.prepare(`
            INSERT INTO FlashcardContent (custom_html, frontText, backText, answerText, front_img, back_img, front_sound, back_sound)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const contentInfo = contentStmt.run(customHtml, frontText, backText, answerText, fImg, bImg, fSnd, bSnd);

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
            INSERT INTO Flashcards (global_hash, node_id, document_id, category_id, content_id, reference_id, last_recall, level, sm2_reps,
                fsrs_stability, fsrs_difficulty, fsrs_due, fsrs_state, fsrs_reps, fsrs_lapses,
                name, fileIndex, presence, card_type, origin)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
        `);
        return stmt.run(
            data.globalHash, data.nodeId, data.documentId, categoryId,
            contentInfo.lastInsertRowid, referenceId, data.lastRecall || null, data.level || 0, data.sm2Reps || 0,
            data.fsrsStability ?? null, data.fsrsDifficulty ?? null, data.fsrsDue ?? null,
            data.fsrsState ?? 0, data.fsrsReps ?? 0, data.fsrsLapses ?? 0,
            data.name || null, data.fileIndex || 0, data.cardType || 'basic', data.origin || null
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
            SET last_recall = ?, level = ?, sm2_reps = ?,
                fsrs_stability = ?, fsrs_difficulty = ?, fsrs_due = ?, fsrs_state = ?, fsrs_reps = ?, fsrs_lapses = ?,
                category_id = ?, name = ?, fileIndex = ?, card_type = ?, origin = ?
            WHERE id = ?
        `).run(
            data.lastRecall, data.level ?? 0, data.sm2Reps ?? 0,
            data.fsrsStability ?? null, data.fsrsDifficulty ?? null, data.fsrsDue ?? null,
            data.fsrsState ?? 0, data.fsrsReps ?? 0, data.fsrsLapses ?? 0,
            categoryId, data.name || null, data.fileIndex, data.cardType || 'basic', data.origin || null, id,
        );

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
            if (data.vanillaData.answerText !== undefined) {
                contentUpdates.push("answerText = ?");
                params.push(data.vanillaData.answerText);
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

    getFlashcardContentByHash(hash) {
        return this.db.prepare(`
            SELECT f.id, f.document_id, f.name, f.card_type, f.level, f.origin,
                   c.frontText, c.backText, c.answerText, c.custom_html,
                   c.front_img, c.back_img, c.front_sound, c.back_sound,
                   pc.name AS category,
                   d.relative_path AS document_path
            FROM Flashcards f
            JOIN FlashcardContent c ON f.content_id = c.id
            LEFT JOIN PedagogicalCategories pc ON pc.id = f.category_id
            LEFT JOIN Documents d ON d.id = f.document_id
            WHERE f.global_hash = ?
        `).get(hash);
    }

    setFlashcardSrsState(id, level, sm2Reps) {
        this.db.prepare('UPDATE Flashcards SET level = ?, sm2_reps = ? WHERE id = ?').run(level, sm2Reps, id);
    }

    getAllFlashcardSrsState() {
        return this.db.prepare(
            'SELECT global_hash, level, sm2_reps, last_recall, fsrs_stability, fsrs_due, fsrs_state FROM Flashcards'
        ).all();
    }

    // Batch-seed FSRS state during an algorithm migration (keyed by global_hash).
    // Also sets `level` (display-strength scalar) from the seeded interval so
    // level-based UI is correct immediately after switching into FSRS.
    batchSetFsrsState(cards) {
        const stmt = this.db.prepare(`
            UPDATE Flashcards SET
                fsrs_stability = ?, fsrs_difficulty = ?, fsrs_due = ?,
                fsrs_state = ?, fsrs_reps = ?, fsrs_lapses = ?, last_recall = ?, level = ?
            WHERE global_hash = ?
        `);
        this.db.transaction((rows) => {
            for (const c of rows) {
                stmt.run(
                    c.fsrsStability ?? null, c.fsrsDifficulty ?? null, c.fsrsDue ?? null,
                    c.fsrsState ?? 0, c.fsrsReps ?? 0, c.fsrsLapses ?? 0, c.lastRecall ?? null,
                    c.level ?? 0, c.global_hash,
                );
            }
        })(cards);
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
        // FSRS fields (rating + post-review snapshot) default to null so the
        // existing Leitner/SM-2 callers keep working unchanged.
        // Session-ordering columns record how the card was PRESENTED (see
        // migrations/009_session_ordering.js). They default to null so every caller
        // without a trainer session — the MCP server, scripts, tests — keeps working,
        // and so "not recorded" stays distinguishable from "distance 0".
        this.db.prepare(`
            INSERT INTO ReviewLogs
                (flashcard_id, timestamp, outcome, ease_factor, level, algorithm,
                 rating, fsrs_stability, fsrs_difficulty, fsrs_due, fsrs_state,
                 session_id, session_position, prev_distance, nearest_sibling_lag)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            data.flashcardId, data.timestamp, data.outcome, data.easeFactor, data.level,
            data.algorithm ?? null,
            data.rating ?? null,
            data.fsrsStability ?? null,
            data.fsrsDifficulty ?? null,
            data.fsrsDue ?? null,
            data.fsrsState ?? null,
            data.sessionId ?? null,
            data.sessionPosition ?? null,
            data.prevDistance ?? null,
            data.nearestSiblingLag ?? null,
        );
    }

    // Everything the sequencer needs to judge how related two cards are, for a whole
    // session in a fixed number of statements. Per-card getInheritedTagNames/
    // getDirectTagNames would be two statements per card — ~400 for a 200-card session —
    // and this runs on every /due.
    //
    // Returns Map<globalHash, { docId, folderId, ancestorIds, tags:Set, deckIds:Set,
    // linkedDocIds:Set }>. A standalone card (no document) has docId/folderId null and
    // still carries its tags and decks, so it is never confusable by location alone.
    getSessionFacets(hashes) {
        const facets = new Map();
        if (!hashes?.length) return facets;

        const { tagConnTypeId, linkConnTypeId, inheritanceTypeId, deckConnTypeId } = this._typeIds();
        const marks = (arr) => arr.map(() => '?').join(', ');

        const base = this.db.prepare(`
            SELECT f.global_hash AS globalHash, f.node_id AS nodeId,
                   f.document_id AS docId, d.node_id AS docNodeId, d.folder_id AS folderId
            FROM Flashcards f
            LEFT JOIN Documents d ON d.id = f.document_id
            WHERE f.global_hash IN (${marks(hashes)})
        `).all(...hashes);
        if (base.length === 0) return facets;

        for (const row of base) {
            facets.set(row.globalHash, {
                docId: row.docId ?? null,
                folderId: row.folderId ?? null,
                ancestorIds: [],
                tags: new Set(),
                deckIds: new Set(),
                linkedDocIds: new Set(),
            });
        }

        // --- Tags: direct on the card, plus inherited from its document/folder/decks.
        // Both feed one set: the sequencer only cares that two cards share a label, not
        // how each of them acquired it.
        const nodeIds = base.map(r => r.nodeId).filter(id => id != null);
        const byNode = new Map(base.map(r => [r.nodeId, r.globalHash]));
        if (nodeIds.length > 0) {
            const nodeMarks = marks(nodeIds);
            const direct = this.db.prepare(`
                SELECT c.origin_id AS nodeId, t.name AS name
                FROM Connections c
                JOIN Tags t ON t.node_id = c.destiny_id
                WHERE c.origin_id IN (${nodeMarks}) AND c.type_id = ?
            `).all(...nodeIds, tagConnTypeId);
            const inherited = this.db.prepare(`
                SELECT c.destiny_id AS nodeId, t.name AS name
                FROM InheritedTags it
                JOIN Connections c ON it.connection_id = c.id
                JOIN Tags t ON t.id = it.tag_id
                WHERE c.destiny_id IN (${nodeMarks}) AND c.type_id IN (?, ?)
            `).all(...nodeIds, inheritanceTypeId, deckConnTypeId);
            for (const row of [...direct, ...inherited]) {
                facets.get(byNode.get(row.nodeId))?.tags.add(row.name);
            }
        }

        // --- Decks
        const deckRows = this.db.prepare(`
            SELECT de.card_hash AS globalHash, de.deck_id AS deckId
            FROM DeckEntries de
            WHERE de.card_hash IN (${marks(hashes)})
        `).all(...hashes);
        for (const row of deckRows) facets.get(row.globalHash)?.deckIds.add(row.deckId);

        // --- Document links, in both directions: a link is evidence the two documents
        // are about related things regardless of which one points at the other.
        const docNodeIds = [...new Set(base.map(r => r.docNodeId).filter(id => id != null))];
        if (docNodeIds.length > 0 && linkConnTypeId) {
            const docNodeMarks = marks(docNodeIds);
            const links = this.db.prepare(`
                SELECT c.origin_id AS fromNode, c.destiny_id AS toNode
                FROM Connections c
                WHERE c.type_id = ?
                  AND (c.origin_id IN (${docNodeMarks}) OR c.destiny_id IN (${docNodeMarks}))
            `).all(linkConnTypeId, ...docNodeIds, ...docNodeIds);
            // Document node ids reach document ids through the same rows we already read,
            // plus any link target outside the session (which we resolve on demand).
            const docIdOfNode = new Map(base.filter(r => r.docNodeId != null).map(r => [r.docNodeId, r.docId]));
            const unknown = [...new Set(
                links.flatMap(l => [l.fromNode, l.toNode]).filter(n => !docIdOfNode.has(n))
            )];
            if (unknown.length > 0) {
                for (const row of this.db.prepare(
                    `SELECT id, node_id AS nodeId FROM Documents WHERE node_id IN (${marks(unknown)})`
                ).all(...unknown)) docIdOfNode.set(row.nodeId, row.id);
            }
            const nodeToHashes = new Map();
            for (const r of base) {
                if (r.docNodeId == null) continue;
                if (!nodeToHashes.has(r.docNodeId)) nodeToHashes.set(r.docNodeId, []);
                nodeToHashes.get(r.docNodeId).push(r.globalHash);
            }
            for (const link of links) {
                for (const [near, far] of [[link.fromNode, link.toNode], [link.toNode, link.fromNode]]) {
                    const farDocId = docIdOfNode.get(far);
                    if (farDocId == null) continue;
                    for (const hash of nodeToHashes.get(near) ?? []) {
                        facets.get(hash)?.linkedDocIds.add(farDocId);
                    }
                }
            }
        }

        // --- Folder ancestry, two levels up. The whole Folders table is a few hundred
        // rows at most, so one read beats a recursive CTE per distinct folder.
        const parentOf = new Map(
            this.db.prepare('SELECT id, parent_id AS parentId FROM Folders').all()
                .map(r => [r.id, r.parentId])
        );
        for (const facet of facets.values()) {
            const chain = [];
            let current = parentOf.get(facet.folderId);
            for (let i = 0; i < 2 && current != null; i++) {
                chain.push(current);
                current = parentOf.get(current);
            }
            facet.ancestorIds = chain;
        }

        return facets;
    }

    // The cards already reviewed in one trainer session, in presentation order. Feeds
    // the nearest-confusable-sibling lag on the next review: the server recomputes it
    // from what was actually shown rather than trusting a client-side count, so a card
    // re-queued after a failed grade is counted at both of its positions.
    getSessionReviewOrder(sessionId) {
        return this.db.prepare(`
            SELECT rl.session_position AS position, f.global_hash AS globalHash
            FROM ReviewLogs rl
            JOIN Flashcards f ON f.id = rl.flashcard_id
            WHERE rl.session_id = ?
            ORDER BY rl.session_position ASC, rl.id ASC
        `).all(sessionId);
    }

    // The most recent real review's algorithm marker plus the fields that betray a
    // scheduler on rows written before ReviewLogs.algorithm existed. Feeds
    // srs.detectAlgorithm(), which is how the server answers "which scheduler does
    // this vault use?" without a browser to ask.
    getLatestReviewAlgorithm() {
        return this.db.prepare(`
            SELECT algorithm, rating
            FROM ReviewLogs
            WHERE outcome IS NOT NULL
            ORDER BY timestamp DESC, id DESC
            LIMIT 1
        `).get() ?? null;
    }

    // --- FSRS per-card state ---

    // Load a card's FSRS record shaped for access/orchestration/fsrs.js (last_recall aliased to
    // last_review). Fields are null for a card never reviewed under FSRS.
    getFlashcardFsrsState(id) {
        return this.db.prepare(`
            SELECT fsrs_stability AS stability, fsrs_difficulty AS difficulty,
                   fsrs_due AS due, fsrs_state AS state,
                   fsrs_reps AS reps, fsrs_lapses AS lapses, last_recall AS last_review
            FROM Flashcards WHERE id = ?
        `).get(id);
    }

    // Persist a computed FSRS state (from fsrs.nextState) back onto the card.
    // Also writes `level` — the app-wide display-strength scalar every algorithm
    // maintains (LevelDot, box histogram, mastery counts) — derived by the caller
    // from the FSRS interval so level-based UI stays meaningful under FSRS.
    updateFlashcardFsrs(id, s) {
        this.db.prepare(`
            UPDATE Flashcards SET
                last_recall = ?, level = ?, fsrs_stability = ?, fsrs_difficulty = ?,
                fsrs_due = ?, fsrs_state = ?, fsrs_reps = ?, fsrs_lapses = ?
            WHERE id = ?
        `).run(s.last_review, s.level ?? 0, s.stability, s.difficulty, s.due, s.state, s.reps, s.lapses, id);
    }

    // --- FSRS weight vector (single-row FsrsParameters) ---

    getFsrsWeights() {
        const row = this.db.prepare(
            'SELECT weights_json, review_count, optimized_at FROM FsrsParameters ORDER BY id DESC LIMIT 1'
        ).get();
        if (!row) return null;
        return {
            weights: JSON.parse(row.weights_json),
            reviewCount: row.review_count,
            optimizedAt: row.optimized_at,
        };
    }

    setFsrsWeights(weightsJson, reviewCount) {
        this.db.transaction(() => {
            this.db.prepare('DELETE FROM FsrsParameters').run();
            this.db.prepare(
                "INSERT INTO FsrsParameters (weights_json, optimized_at, review_count) VALUES (?, datetime('now'), ?)"
            ).run(weightsJson, reviewCount);
        })();
    }

    // Every FSRS-rated review across the vault, grouped/ordered per card, for the
    // parameter optimizer. Excludes pre-FSRS logs (rating IS NULL).
    getAllReviewHistories() {
        return this.db.prepare(`
            SELECT flashcard_id, timestamp, rating
            FROM ReviewLogs
            WHERE rating IS NOT NULL
            ORDER BY flashcard_id ASC, id ASC
        `).all();
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

    // One card's complete review ledger, oldest first — the card detail view.
    //
    // Unlike every aggregate in this file, this one does NOT filter out the synthetic
    // rows a vault rebuild writes (insertSyntheticReviewLog leaves outcome NULL): a
    // per-card ledger should show what is actually stored, and srs.js flags those rows
    // so the UI can label them and keep them out of the retention numbers.
    // Ordered by id, not timestamp: reviews are written in the order they happen, and
    // the two writers don't agree on a format — reviews store an ISO string while
    // insertSyntheticReviewLog uses SQLite's datetime('now'), which sorts before every
    // ISO stamp of the same day (' ' < 'T'). id is the same ordering undo relies on.
    getFlashcardReviewHistory(flashcardId) {
        return this.db.prepare(`
            SELECT id, timestamp, outcome, ease_factor, level, algorithm, rating,
                   fsrs_stability, fsrs_difficulty, fsrs_due, fsrs_state
            FROM ReviewLogs
            WHERE flashcard_id = ?
            ORDER BY id ASC
        `).all(flashcardId);
    }

    // Everything the schedulers need to place one card on its curve. The ease-factor
    // subselect deliberately does NOT skip synthetic rows: after a Doctor rebuild that
    // row is the only carrier of the card's SM-2 ease (see getLatestEaseFactors and the
    // latest_ef CTE in getDueFlashcards, which both read it the same way).
    getFlashcardSrsStateByHash(hash) {
        return this.db.prepare(`
            SELECT f.id, f.global_hash, f.level, f.sm2_reps, f.last_recall,
                   f.fsrs_stability, f.fsrs_difficulty, f.fsrs_state, f.fsrs_due,
                   f.fsrs_reps, f.fsrs_lapses,
                   (SELECT rl.ease_factor FROM ReviewLogs rl
                     WHERE rl.flashcard_id = f.id ORDER BY rl.id DESC LIMIT 1) AS ease_factor
            FROM Flashcards f
            WHERE f.global_hash = ?
        `).get(hash);
    }

    // The card's now-latest review after an undo — the state to restore it to.
    // Null when no reviews remain (the card is new again).
    getLatestReviewLog(flashcardId) {
        return this.db.prepare(`
            SELECT timestamp, outcome, ease_factor, level,
                   rating, fsrs_stability, fsrs_difficulty, fsrs_due, fsrs_state
            FROM ReviewLogs WHERE flashcard_id = ? ORDER BY id DESC LIMIT 1
        `).get(flashcardId) ?? null;
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

    // Per-day review counts for the Stats activity heatmap and retention. Real
    // reviews only — synthetic rebuild logs carry a NULL outcome and are excluded.
    // `sinceIso` optionally bounds the window (null = all time), as an inclusive
    // 'YYYY-MM-DD' local day. Days are the user's local calendar days, not UTC ones —
    // see the note above the diary aggregates for why, and keep every day-keyed query
    // on the same boundary.
    getReviewActivity(sinceIso = null) {
        const clause = sinceIso
            ? "WHERE outcome IS NOT NULL AND date(timestamp, 'localtime') >= ?"
            : 'WHERE outcome IS NOT NULL';
        const stmt = this.db.prepare(`
            SELECT date(timestamp, 'localtime') AS day,
                   COUNT(*) AS total,
                   SUM(CASE WHEN outcome = 1 THEN 1 ELSE 0 END) AS correct
            FROM ReviewLogs
            ${clause}
            GROUP BY day
            ORDER BY day ASC
        `);
        return sinceIso ? stmt.all(sinceIso) : stmt.all();
    }

    // Total / correct review counts for the retention headline. `sinceIso` bounds
    // the window (null = all time). Excludes synthetic (NULL-outcome) logs.
    getReviewTotals(sinceIso = null) {
        const clause = sinceIso
            ? "WHERE outcome IS NOT NULL AND date(timestamp, 'localtime') >= ?"
            : 'WHERE outcome IS NOT NULL';
        const stmt = this.db.prepare(`
            SELECT COUNT(*) AS total,
                   SUM(CASE WHEN outcome = 1 THEN 1 ELSE 0 END) AS correct
            FROM ReviewLogs
            ${clause}
        `);
        return sinceIso ? stmt.get(sinceIso) : stmt.get();
    }

    // ---------- Phase-aware review totals ----------
    // A card's first `learningReviews` reviews are its *acquisition* phase: a new
    // card usually needs a few failed attempts before it sticks, and counting those
    // as forgetting makes the retention headline read as noise. Everything after is
    // the *review* phase — the only reviews true retention is measured on.
    //
    // The rep number is always computed over the card's FULL history and any date
    // window is applied afterwards, so a 30-day view never renumbers a card's reps.
    // Synthetic rebuild logs (NULL outcome) are excluded, as everywhere else.

    _orderedReviewsCte() {
        return `
            WITH ordered AS (
                SELECT flashcard_id, outcome, timestamp,
                       ROW_NUMBER() OVER (
                           PARTITION BY flashcard_id ORDER BY timestamp ASC, id ASC
                       ) AS rep
                FROM ReviewLogs
                WHERE outcome IS NOT NULL
            )
        `;
    }

    // → { learning: { total, correct }, review: { total, correct } } (zeroed when a
    // phase has no reviews, so callers never have to null-check the buckets).
    getReviewTotalsByPhase(learningReviews, sinceIso = null) {
        const stmt = this.db.prepare(`
            ${this._orderedReviewsCte()}
            SELECT CASE WHEN rep <= ? THEN 'learning' ELSE 'review' END AS phase,
                   COUNT(*) AS total,
                   SUM(CASE WHEN outcome = 1 THEN 1 ELSE 0 END) AS correct
            FROM ordered
            ${sinceIso ? "WHERE date(timestamp, 'localtime') >= ?" : ''}
            GROUP BY phase
        `);
        const rows = sinceIso ? stmt.all(learningReviews, sinceIso) : stmt.all(learningReviews);
        const out = { learning: { total: 0, correct: 0 }, review: { total: 0, correct: 0 } };
        for (const r of rows) out[r.phase] = { total: r.total ?? 0, correct: r.correct ?? 0 };
        return out;
    }

    // Outcomes of each card's very first review — how much material lands on first
    // contact. One row per card, so `total` here counts cards, not reviews.
    getFirstExposureTotals(sinceIso = null) {
        const stmt = this.db.prepare(`
            ${this._orderedReviewsCte()}
            SELECT COUNT(*) AS total,
                   SUM(CASE WHEN outcome = 1 THEN 1 ELSE 0 END) AS correct
            FROM ordered
            WHERE rep = 1 ${sinceIso ? "AND date(timestamp, 'localtime') >= ?" : ''}
        `);
        const row = sinceIso ? stmt.get(sinceIso) : stmt.get();
        return { total: row?.total ?? 0, correct: row?.correct ?? 0 };
    }

    // Acquisition cost: how many attempts each card took before it was first recalled
    // correctly (1 = right on first sight). Cards never yet recalled are absent — they
    // have no answer yet, and counting their attempts so far would bias the average.
    // Returns raw rows; the averaging/median lives in srs.js.
    getReviewsToFirstRecall() {
        return this.db.prepare(`
            ${this._orderedReviewsCte()}
            SELECT flashcard_id, MIN(rep) AS attempts
            FROM ordered
            WHERE outcome = 1
            GROUP BY flashcard_id
        `).all();
    }

    // ---------- Diary: per-day review aggregates ----------
    // All of these bucket by date(timestamp, 'localtime') and count real reviews only —
    // synthetic rebuild logs (NULL outcome) are excluded. `dayIso` is 'YYYY-MM-DD'.
    // Used by diary.js to derive an idempotent daily summary from ReviewLogs.
    //
    // Timestamps are stored as UTC ISO strings, but a "study day" is the user's own
    // calendar day: bucketing in UTC filed an evening session west of Greenwich under
    // tomorrow's date, which never matched the clock the user was looking at. The API
    // runs on the user's machine, so SQLite's 'localtime' modifier is that clock. Every
    // day-keyed reader here and in srs.js/diary.js must use the same boundary or the
    // Stats heatmap, the streak, and the diary date will disagree with each other.

    getDayReviewTotals(dayIso) {
        return this.db.prepare(`
            SELECT COUNT(*) AS reviews,
                   COUNT(DISTINCT flashcard_id) AS uniqueCards,
                   SUM(CASE WHEN outcome = 0 THEN 1 ELSE 0 END) AS failed
            FROM ReviewLogs
            WHERE outcome IS NOT NULL AND date(timestamp, 'localtime') = ?
        `).get(dayIso);
    }

    // The day's reviews split into acquisition (a card's first `learningReviews`
    // reviews, ever — not just today's) and review phase. Same shape and rationale as
    // getReviewTotalsByPhase; the day filter is applied after the numbering.
    getDayReviewTotalsByPhase(learningReviews, dayIso) {
        const rows = this.db.prepare(`
            ${this._orderedReviewsCte()}
            SELECT CASE WHEN rep <= ? THEN 'learning' ELSE 'review' END AS phase,
                   COUNT(*) AS total,
                   SUM(CASE WHEN outcome = 1 THEN 1 ELSE 0 END) AS correct
            FROM ordered
            WHERE date(timestamp, 'localtime') = ?
            GROUP BY phase
        `).all(learningReviews, dayIso);
        const out = { learning: { total: 0, correct: 0 }, review: { total: 0, correct: 0 } };
        for (const r of rows) out[r.phase] = { total: r.total ?? 0, correct: r.correct ?? 0 };
        return out;
    }

    // Cards whose earliest-ever real review falls on this day — i.e. cards first
    // seen (in review terms) on `dayIso`. Idempotent: depends only on log history.
    getDayNewCards(dayIso) {
        return this.db.prepare(`
            SELECT COUNT(*) AS newCards FROM (
                SELECT flashcard_id, MIN(date(timestamp, 'localtime')) AS firstDay
                FROM ReviewLogs
                WHERE outcome IS NOT NULL
                GROUP BY flashcard_id
                HAVING firstDay = ?
            )
        `).get(dayIso).newCards;
    }

    // Reviews grouped by deck for the day. A card in multiple decks (rare) counts
    // once per deck — this is a per-deck view, not a partition of the day's reviews.
    //
    // The system deck is excluded: it isn't a deck the user built, it's the automatic
    // home every card without a source document falls into, so as a bar in a "By deck"
    // breakdown it reads as a real grouping when it carries no intent. Its reviews are
    // still in the day's totals, exactly as standalone cards are absent from
    // getDayByDocument but counted there too.
    getDayByDeck(dayIso) {
        return this.db.prepare(`
            SELECT d.name AS deck,
                   COUNT(*) AS reviews,
                   SUM(CASE WHEN rl.outcome = 0 THEN 1 ELSE 0 END) AS failed
            FROM ReviewLogs rl
            JOIN Flashcards f ON f.id = rl.flashcard_id
            JOIN DeckEntries de ON de.card_hash = f.global_hash
            JOIN Decks d ON d.id = de.deck_id
            WHERE rl.outcome IS NOT NULL
              AND date(rl.timestamp, 'localtime') = ?
              AND COALESCE(d.is_system, 0) = 0
            GROUP BY d.id
            ORDER BY reviews DESC, d.name ASC
        `).all(dayIso);
    }

    // Reviews grouped by source document for the day (document-anchored cards only;
    // standalone cards have no document_id and are excluded here).
    getDayByDocument(dayIso) {
        return this.db.prepare(`
            SELECT doc.relative_path AS path,
                   COUNT(*) AS reviews,
                   SUM(CASE WHEN rl.outcome = 0 THEN 1 ELSE 0 END) AS failed
            FROM ReviewLogs rl
            JOIN Flashcards f ON f.id = rl.flashcard_id
            JOIN Documents doc ON doc.id = f.document_id
            WHERE rl.outcome IS NOT NULL AND date(rl.timestamp, 'localtime') = ?
            GROUP BY doc.id
            ORDER BY reviews DESC, doc.relative_path ASC
        `).all(dayIso);
    }

    // Cards that were failed at least once on the day, most-failed first. `front`
    // is the vanilla front text (NULL for custom-HTML cards — caller substitutes).
    getDayStruggledCards(dayIso, limit = 10) {
        return this.db.prepare(`
            SELECT f.global_hash AS globalHash,
                   fc.frontText AS front,
                   SUM(CASE WHEN rl.outcome = 0 THEN 1 ELSE 0 END) AS failCount
            FROM ReviewLogs rl
            JOIN Flashcards f ON f.id = rl.flashcard_id
            LEFT JOIN FlashcardContent fc ON fc.id = f.content_id
            WHERE rl.outcome IS NOT NULL AND date(rl.timestamp, 'localtime') = ?
            GROUP BY f.id
            HAVING failCount > 0
            ORDER BY failCount DESC, f.id ASC
            LIMIT ?
        `).all(dayIso, limit);
    }

    // Distinct local-calendar days that carry at least one real review, ascending.
    // Drives the diary "rebuild all summaries" command and streak computation.
    getReviewActivityDays() {
        return this.db.prepare(`
            SELECT date(timestamp, 'localtime') AS day
            FROM ReviewLogs
            WHERE outcome IS NOT NULL
            GROUP BY day
            ORDER BY day ASC
        `).all().map(r => r.day);
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
            // A card's effective tags are direct ∪ inherited — the same union getSessionFacets
            // builds and the Inspector displays. Matching only direct `tag` connections made
            // this filter select nothing for any tag that lives on a folder, document or deck,
            // which is nearly all of them: the picker offers a vault-wide tag list, so the user
            // chose a tag they could plainly see and got an empty session with no explanation.
            // InheritedTags is already the exclusion-resolved set (it is rebuilt on every
            // inheritance change — see getInheritedTagNames), so excluded tags are absent from
            // it and no exclusion handling belongs here.
            whereConditions.push(`(
                EXISTS (
                    SELECT 1 FROM Connections ctag
                    JOIN Tags tg ON tg.node_id = ctag.destiny_id
                    WHERE ctag.origin_id = f.node_id
                      AND ctag.type_id = (SELECT id FROM ConnectionTypes WHERE name = 'tag')
                      AND tg.name IN (${placeholders})
                )
                OR EXISTS (
                    SELECT 1 FROM InheritedTags it
                    JOIN Connections cinh ON cinh.id = it.connection_id
                    JOIN Tags tgi ON tgi.id = it.tag_id
                    WHERE cinh.destiny_id = f.node_id
                      AND cinh.type_id IN (
                          SELECT id FROM ConnectionTypes WHERE name IN ('inheritance', 'deck')
                      )
                      AND tgi.name IN (${placeholders})
                )
            )`);
            params.push(...tags, ...tags);
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

        const isFsrs = algorithm === 'fsrs';

        // Expose the algorithm-relevant count as "level" so the frontend shows a
        // meaningful number regardless of which algorithm is active. For FSRS the
        // stability (rounded, in days) is the natural "strength" number.
        const levelExpr = isFsrs
            ? 'CAST(ROUND(COALESCE(f.fsrs_stability, 0)) AS INTEGER)'
            : algorithm === 'sm2'
                ? 'COALESCE(f.sm2_reps, 0)'
                : 'COALESCE(f.level, 0)';

        cteParts.push(`cards AS (
            SELECT
                f.global_hash,
                ${levelExpr} AS level,
                f.last_recall,
                f.fsrs_due,
                f.fsrs_state,
                f.name,
                f.card_type,
                d.relative_path AS document_path,
                pc.name AS category,
                COALESCE(pc.priority, 0) AS category_priority,
                fc.custom_html,
                fc.render_html,
                fc.frontText,
                fc.backText,
                fc.answerText,
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

        // Due-date & status are derived from a formula over last_recall for
        // Leitner/SM-2, but FSRS stores an explicit next-due datetime (fsrs_due),
        // so it reads that column directly and keys "new" off fsrs_state.
        // fsrs_due is stored as a JS ISO string (has 'T'/'Z'/millis); normalize it
        // through SQLite datetime() so it matches the "YYYY-MM-DD HH:MM:SS" format
        // the rest of the pipeline (comparisons, sort, and the frontend's
        // formatNextDue) expects. Comparing the raw ISO string against
        // datetime('now') mis-sorts on same-day boundaries ('T' vs ' ').
        const dueDateExpr = isFsrs
            ? 'datetime(fsrs_due)'
            : `CASE
                WHEN last_recall IS NULL THEN NULL
                ELSE datetime(last_recall, '+' || CAST(interval_days AS TEXT) || ' days')
              END`;

        const statusExpr = isFsrs
            ? `CASE
                WHEN fsrs_state = 0 OR fsrs_due IS NULL THEN 'new'
                WHEN datetime(fsrs_due) <= datetime('now') THEN 'due'
                ELSE 'future'
              END`
            : `CASE
                WHEN last_recall IS NULL THEN 'new'
                WHEN datetime(last_recall, '+' || CAST(interval_days AS TEXT) || ' days') <= datetime('now') THEN 'due'
                ELSE 'future'
              END`;

        const allRows = this.db.prepare(`
            WITH RECURSIVE ${cteParts.join(',\n')}
            SELECT *,
              ${dueDateExpr} AS due_date,
              ${statusExpr} AS _status
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

    // Every tag with how many entities apply it directly (a 'tag' connection
    // pointing at the tag's node). Inherited occurrences are derived elsewhere and
    // deliberately not counted here — this is "where is this tag actually set".
    getTagsWithCounts() {
        const { tagConnTypeId } = this._typeIds();
        return this.db.prepare(`
            SELECT t.name AS name, COUNT(c.id) AS count
            FROM Tags t
            LEFT JOIN Connections c
              ON c.destiny_id = t.node_id AND c.type_id = ?
            GROUP BY t.node_id, t.name
            ORDER BY count DESC, t.name ASC
        `).all(tagConnTypeId);
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

    getDocumentByAbsolutePath(absPath) {
        return this.db.prepare('SELECT * FROM Documents WHERE absolute_path = ?').get(absPath);
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
            SELECT 'flashcard' as type, f.global_hash, c.frontText, c.backText, c.answerText
            FROM Flashcards f JOIN FlashcardContent c ON f.content_id = c.id
            WHERE c.frontText LIKE ? OR c.backText LIKE ? OR c.answerText LIKE ? OR f.global_hash = ? OR f.name LIKE ?
        `).all(term, term, term, query, term);
        const tags = this.db.prepare(`SELECT 'tag' as type, t.name, null as frontText, null as backText, null as answerText FROM Tags t WHERE t.name LIKE ?`).all(term);
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
            SELECT f.global_hash, f.name, f.card_type, f.level, f.origin,
                   c.frontText, c.backText, c.answerText,
                   d.relative_path as document_path, d.name as document_name
            FROM Flashcards f
            JOIN FlashcardContent c ON f.content_id = c.id
            LEFT JOIN Documents d ON d.id = f.document_id
            WHERE c.frontText LIKE ? OR c.backText LIKE ? OR c.answerText LIKE ? OR f.name LIKE ?
            LIMIT ?
        `).all(term, term, term, term, limit);

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
                      AND c.type_id IN (SELECT id FROM ConnectionTypes WHERE name IN ('inheritance', 'deck'))
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
            conditions.push('(c.frontText LIKE ? OR c.backText LIKE ? OR c.answerText LIKE ? OR f.name LIKE ?)');
            condParams.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
        }

        const whereSQL = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        const allParams = [...cteParams, ...condParams, limit];

        return this.db.prepare(`
            ${cteSQL}
            SELECT f.global_hash, f.name, f.card_type, f.level, f.origin,
                   c.frontText, c.backText, c.answerText,
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

    // Inherited tags reach a node through two connection types: 'inheritance'
    // (folder/document → child) and 'deck' (deck → member card). Only card nodes
    // are ever the destiny of a 'deck' connection, so broadening the filter never
    // adds tags to documents/folders — it just lets a deck's tags flow to its
    // cards. DISTINCT dedupes a tag a card inherits from both its document and a deck.
    getInheritedTagNames(nodeId) {
        return this.db.prepare(`
            SELECT DISTINCT t.name FROM InheritedTags it
            JOIN Connections c ON it.connection_id = c.id
            JOIN Tags t ON t.id = it.tag_id
            WHERE c.destiny_id = ?
              AND c.type_id IN (SELECT id FROM ConnectionTypes WHERE name IN ('inheritance', 'deck'))
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
                   dk.is_system      as deckIsSystem,
                   dl.cardCount      as cardCount,
                   dl.learnedSum     as learnedSum,
                   ${CARD_LEARNED_SQL('fc')} as flashcardLearned
            FROM Nodes n
            JOIN NodeTypes nt ON n.type_id = nt.id
            LEFT JOIN Documents d   ON d.node_id   = n.id
            LEFT JOIN Folders f     ON f.node_id   = n.id
            LEFT JOIN Tags t        ON t.node_id   = n.id
            LEFT JOIN Flashcards fc ON fc.node_id  = n.id
            LEFT JOIN FlashcardContent fcc ON fcc.id = fc.content_id
            LEFT JOIN Documents fcd        ON fcd.id = fc.document_id
            LEFT JOIN Decks dk ON dk.node_id = n.id
            LEFT JOIN (
                SELECT document_id,
                       COUNT(*)                            as cardCount,
                       SUM(${CARD_LEARNED_SQL('Flashcards')}) as learnedSum
                FROM Flashcards
                WHERE document_id IS NOT NULL
                GROUP BY document_id
            ) dl ON dl.document_id = d.id
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

    // Resolved flashback:// link edges for one document, both directions.
    getDocumentLinkEdges(nodeId) {
        const { linkConnTypeId } = this._typeIds();
        if (!linkConnTypeId) return { outgoing: [], backlinks: [] };
        const outgoing = this.db.prepare(`
            SELECT d.name, d.relative_path AS path, d.global_hash
            FROM Connections c JOIN Documents d ON d.node_id = c.destiny_id
            WHERE c.origin_id = ? AND c.type_id = ?
        `).all(nodeId, linkConnTypeId);
        const backlinks = this.db.prepare(`
            SELECT d.name, d.relative_path AS path, d.global_hash
            FROM Connections c JOIN Documents d ON d.node_id = c.origin_id
            WHERE c.destiny_id = ? AND c.type_id = ?
        `).all(nodeId, linkConnTypeId);
        return { outgoing, backlinks };
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

    // Stores a deck's tags as InheritedTags on the deck → card connection, so they
    // flow to the card via getInheritedTagNames without touching the card's own
    // document-inheritance connection. Removing the card from the deck (or deleting
    // the deck) drops the connection, and InheritedTags cascades on connection_id.
    setDeckConnectionInheritedTags(deckNodeId, cardNodeId, tagIds) {
        const { deckConnTypeId } = this._typeIds();
        if (!deckConnTypeId) return;
        const conn = this.getOrCreateConnection(deckNodeId, cardNodeId, deckConnTypeId);
        this.clearInheritedTags(conn.id);
        for (const tagId of tagIds) this.insertInheritedTag(conn.id, tagId);
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
                   c.frontText, c.backText, c.answerText, c.custom_html
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

    // `origin` filter: 'ai' → only AI-created cards (origin = 'ai');
    // 'human' → only cards NOT created by an AI assistant.
    _flashcardOriginCondition(origin, conditions) {
        if (origin === 'ai') conditions.push("f.origin = 'ai'");
        else if (origin === 'human') conditions.push("(f.origin IS NULL OR f.origin <> 'ai')");
    }

    // Shared WHERE builder for the card browser's list and count queries — the two
    // must filter identically or the pager's `total` disagrees with its rows.
    //
    // The card-health filter is an EXISTS subquery rather than a join, so a card
    // carrying two flags still counts once. Dismissed flags are excluded everywhere:
    // a flag the user has already ruled on is suppressed, not deleted.
    _flashcardFilters({ search, level, cardType, origin, flagged, flagKind }) {
        const params = [];
        const conditions = [];

        if (search) {
            const term = `%${search}%`;
            conditions.push('(c.frontText LIKE ? OR c.backText LIKE ? OR c.answerText LIKE ? OR f.name LIKE ?)');
            params.push(term, term, term, term);
        }
        if (level !== null && level !== undefined) {
            conditions.push('f.level = ?');
            params.push(level);
        }
        if (cardType) {
            conditions.push('f.card_type = ?');
            params.push(cardType);
        }
        this._flashcardOriginCondition(origin, conditions);

        if (flagged || flagKind) {
            const kindClause = flagKind ? ' AND cf.kind = ?' : '';
            conditions.push(`EXISTS (SELECT 1 FROM CardFlags cf
                WHERE cf.flashcard_id = f.id AND cf.dismissed_at IS NULL${kindClause})`);
            if (flagKind) params.push(flagKind);
        }

        return { where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', params };
    }

    getAllFlashcards({ search = null, level = null, cardType = null, origin = null, flagged = false, flagKind = null, sortBy = 'level', sortDir = 'desc', limit = 50, offset = 0 } = {}) {
        const { where, params } = this._flashcardFilters({ search, level, cardType, origin, flagged, flagKind });
        const sortCols = {
            level: 'f.level', name: 'f.name', last_recall: 'f.last_recall',
            lapses: 'f.fsrs_lapses', difficulty: 'f.fsrs_difficulty',
        };
        const sortCol = sortCols[sortBy] ?? 'f.level';
        const dir = sortDir === 'asc' ? 'ASC' : 'DESC';
        // fsrs_difficulty is only set once a card has been rated under FSRS, so
        // sorting by it must sink the unrated cards to the bottom in BOTH
        // directions — SQLite would otherwise float every NULL to the top of the
        // ascending ("easiest first") page and bury the real answer.
        const nullsLast = sortCol === 'f.fsrs_difficulty' ? `${sortCol} IS NULL, ` : '';

        params.push(limit, offset);

        return this.db.prepare(`
            SELECT f.global_hash, f.name, f.level, f.last_recall, f.card_type,
                   f.fsrs_lapses as lapses, f.fsrs_difficulty as difficulty, f.origin,
                   c.frontText, c.backText, c.answerText, c.custom_html,
                   d.relative_path as document_path, d.name as document_name,
                   pc.name as category,
                   -- Scalar subquery, not a join: the browser renders a flag chip per
                   -- row without an N+1, and a twice-flagged card stays one row.
                   (SELECT GROUP_CONCAT(cf.kind) FROM CardFlags cf
                     WHERE cf.flashcard_id = f.id AND cf.dismissed_at IS NULL) AS flags
            FROM Flashcards f
            JOIN FlashcardContent c ON f.content_id = c.id
            LEFT JOIN Documents d ON f.document_id = d.id
            LEFT JOIN PedagogicalCategories pc ON f.category_id = pc.id
            ${where}
            ORDER BY ${nullsLast}${sortCol} ${dir}, f.name ASC
            LIMIT ? OFFSET ?
        `).all(...params);
    }

    getFlashcardCountFiltered({ search = null, level = null, cardType = null, origin = null, flagged = false, flagKind = null } = {}) {
        const { where, params } = this._flashcardFilters({ search, level, cardType, origin, flagged, flagKind });
        const contentJoin = search ? 'JOIN FlashcardContent c ON f.content_id = c.id' : '';

        return this.db.prepare(`
            SELECT COUNT(*) as c FROM Flashcards f ${contentJoin} ${where}
        `).get(...params).c;
    }

    updateFlashcardContentByHash(hash, { frontText, backText, answerText, name, cardType, category, customHtml }) {
        const card = this.db.prepare('SELECT id, content_id FROM Flashcards WHERE global_hash = ?').get(hash);
        if (!card) return false;
        let categoryId = null;
        if (category) {
            const cat = this.db.prepare("SELECT id FROM PedagogicalCategories WHERE name = ?").get(category);
            if (cat) categoryId = cat.id;
        }
        this.db.prepare('UPDATE Flashcards SET name = ?, card_type = ?, category_id = ? WHERE id = ?')
            .run(name || null, cardType || 'basic', categoryId, card.id);
        this.db.prepare('UPDATE FlashcardContent SET frontText = ?, backText = ?, answerText = ?, custom_html = ? WHERE id = ?')
            .run(frontText || null, backText || null, answerText || null, customHtml || null, card.content_id);
        return true;
    }

    deleteFlashcardDeckEntries(cardHash) {
        return this.db.prepare('DELETE FROM DeckEntries WHERE card_hash = ?').run(cardHash);
    }

    // Every deck holding this card. DeckEntries key on card_hash rather than a
    // Flashcards foreign key, so deleting a card cascades nothing here — callers
    // that destroy a card must walk this list and unlink it deck by deck (each deck
    // also has a canonical JSON file to rewrite). See decks.removeCardEverywhere.
    // `is_system` matters to callers deciding whether a card is "shared": every
    // standalone card lives in the system deck by definition, so counting it as a
    // second owner would make every imported card look shared.
    getDecksContainingCard(cardHash) {
        return this.db.prepare(`
            SELECT d.id, d.global_hash, d.name, d.is_system
            FROM DeckEntries e
            JOIN Decks d ON d.id = e.deck_id
            WHERE e.card_hash = ?
        `).all(cardHash);
    }

    // --- Card Health (see access/orchestration/cardHealth.js, DATAMODEL.md § Card Health) ---

    // The classifier reads a card's content through the existing
    // getFlashcardContentByHash (above) — it already returns f.id, card_type and the
    // three content fields, so there is no second query here. A near-duplicate defined
    // in this section would silently SHADOW that one (same class, later definition wins)
    // and strip document_path and the media refs from every caller of decks.getCard.

    // Answer bodies to calibrate "long" against. The classifier tokenizes these with the
    // same function it applies to the card under test, so the comparison is like-for-like;
    // that matters more than scanning every row, hence the cap. An absolute character
    // threshold would be meaningless across a kana vault and a case-law vault.
    getFlashcardAnswerSamples(limit = 2000) {
        return this.db.prepare(`
            SELECT f.card_type, c.backText, c.answerText, c.custom_html
            FROM Flashcards f
            JOIN FlashcardContent c ON f.content_id = c.id
            WHERE c.backText IS NOT NULL OR c.answerText IS NOT NULL OR c.custom_html IS NOT NULL
            LIMIT ?
        `).all(limit);
    }

    // Vault-wide review stream for session segmentation (clustered on time gaps —
    // ReviewLogs has no session id). Synthetic rebuild rows are excluded: the Doctor
    // writes one per card at a single instant, which would otherwise read as one
    // enormous session and poison every session-position measure.
    getRecentReviewSessionRows(since) {
        return this.db.prepare(`
            SELECT id, flashcard_id, timestamp, outcome
            FROM ReviewLogs
            WHERE outcome IS NOT NULL AND timestamp >= ?
            ORDER BY timestamp ASC, id ASC
        `).all(since);
    }

    getCardHealth(flashcardId) {
        return this.db.prepare(
            'SELECT * FROM CardHealth WHERE flashcard_id = ?'
        ).get(flashcardId) ?? null;
    }

    upsertCardHealth(flashcardId, { epochAt = null, epochReason = null, contentFingerprint = null }) {
        return this.db.prepare(`
            INSERT INTO CardHealth (flashcard_id, epoch_at, epoch_reason, content_fingerprint, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(flashcard_id) DO UPDATE SET
                epoch_at            = excluded.epoch_at,
                epoch_reason        = excluded.epoch_reason,
                content_fingerprint = excluded.content_fingerprint,
                updated_at          = excluded.updated_at
        `).run(flashcardId, epochAt, epochReason, contentFingerprint, new Date().toISOString());
    }

    // Only the fingerprint changed (the card was re-evaluated without being addressed).
    setCardHealthFingerprint(flashcardId, contentFingerprint) {
        return this.db.prepare(
            'UPDATE CardHealth SET content_fingerprint = ?, updated_at = ? WHERE flashcard_id = ?'
        ).run(contentFingerprint, new Date().toISOString(), flashcardId);
    }

    getCardFlags(flashcardId, { includeDismissed = false } = {}) {
        const filter = includeDismissed ? '' : ' AND dismissed_at IS NULL';
        return this.db.prepare(
            `SELECT * FROM CardFlags WHERE flashcard_id = ?${filter} ORDER BY detected_at DESC`
        ).all(flashcardId);
    }

    // Re-raising refreshes a flag's evidence in place rather than stacking duplicates
    // (UNIQUE(flashcard_id, kind)). `dismissed_at` is deliberately NOT overwritten: a
    // flag the user has already ruled on stays suppressed while its numbers stay current.
    upsertCardFlag({ flashcardId, kind, confidence, score, evidence, levelAtDetection, reviewLogId }) {
        return this.db.prepare(`
            INSERT INTO CardFlags
                (flashcard_id, kind, confidence, score, evidence_json,
                 level_at_detection, detected_at, review_log_id, dismissed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
            ON CONFLICT(flashcard_id, kind) DO UPDATE SET
                confidence         = excluded.confidence,
                score              = excluded.score,
                evidence_json      = excluded.evidence_json,
                level_at_detection = excluded.level_at_detection,
                detected_at        = excluded.detected_at,
                review_log_id      = excluded.review_log_id
        `).run(
            flashcardId, kind, confidence, score ?? null,
            evidence ? JSON.stringify(evidence) : null,
            levelAtDetection ?? null, new Date().toISOString(), reviewLogId ?? null,
        );
    }

    // `kinds` limits the delete to specific signatures (used when a guard fires and the
    // now-unsupported mouthful/probe verdicts must be withdrawn). Omit it to clear all.
    deleteCardFlags(flashcardId, { kinds = null, includeDismissed = false } = {}) {
        const params = [flashcardId];
        let sql = 'DELETE FROM CardFlags WHERE flashcard_id = ?';
        if (!includeDismissed) sql += ' AND dismissed_at IS NULL';
        if (kinds?.length) {
            sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
            params.push(...kinds);
        }
        return this.db.prepare(sql).run(...params).changes;
    }

    dismissCardFlag(flashcardId, kind) {
        return this.db.prepare(
            'UPDATE CardFlags SET dismissed_at = ? WHERE flashcard_id = ? AND kind = ?'
        ).run(new Date().toISOString(), flashcardId, kind).changes;
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
            // Card health is derived from ReviewLogs, which this wipe destroys — so the
            // flags must go with it rather than outlive the evidence that earned them.
            // Cards re-earn them from new review behaviour. (The FK would cascade from
            // Flashcards anyway; explicit here so the ordering is intentional.)
            this.db.prepare('DELETE FROM CardFlags').run();
            this.db.prepare('DELETE FROM CardHealth').run();
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

    // --- Canonical updates ---
    //
    // Which canonical-layer updates this vault has finished (config/UpdateRunner.js) — the
    // counterpart of SchemaVersion for the files rather than for this database. Recorded
    // only after a pass completes with nothing skipped, and treated as a fast path rather
    // than as truth: the authority is the `formatVersion` stamped on each canonical file.

    // Moves every legacy type_answer card's answer from backText into answerText, matching
    // what canonical update 001 writes into the files. Migration 008 carries the same
    // statement for the upgrade path; this exists so the canonical pass can stand on its own
    // — after a Vault Doctor rebuild the derived rows are re-derived from whatever the files
    // said at the time, and the two layers have to end up agreeing either way.
    // Idempotent: a row that already has an answerText is left alone.
    backfillTypeAnswerAnswerText() {
        return this.db.prepare(`
            UPDATE FlashcardContent
               SET answerText = backText,
                   backText   = NULL
             WHERE answerText IS NULL
               AND id IN (SELECT content_id FROM Flashcards WHERE card_type = 'type_answer')
        `).run().changes;
    }

    getCanonicalVersions() {
        return new Set(this.db.prepare('SELECT version FROM CanonicalVersion').all().map(r => r.version));
    }

    recordCanonicalVersion(version, description = null) {
        this.db.prepare(
            'INSERT OR REPLACE INTO CanonicalVersion (version, description) VALUES (?, ?)'
        ).run(version, description);
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

    // Distinct workspace documents that currently have at least one highlight —
    // the vault-wide entry point for highlight listings (the per-document
    // detail always comes from the sidecar, the canonical layer).
    getHighlightedDocumentPaths() {
        return this.db.prepare(`
            SELECT DISTINCT d.relative_path
            FROM Highlights h
            JOIN Documents d ON h.document_id = d.id
            ORDER BY d.relative_path ASC
        `).all().map(r => r.relative_path);
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
