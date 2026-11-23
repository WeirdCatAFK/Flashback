import db from '../primitives/database.js';
import { OWNER_SCOPE } from '../../requestContext.js';

const READ_FIELDS = ['unit', 'total', 'pos', 'pos_pct', 'far', 'far_pct', 'body_etag'];

function scoped(scope) {
    if (typeof scope !== 'string' || scope.length === 0) {
        throw new Error(
            'query: this call needs an account scope (an account id, or OWNER_SCOPE). '
            + 'Resolve it once at the orchestrator boundary with requestContext.currentScope().'
        );
    }
    return scope;
}

const highlightAnchor = (card) => {
    const loc = card?.vanillaData?.location;
    return loc?.type === 'highlight' && typeof loc.id === 'string' ? loc.id : null;
};

const LIVE_ANCHOR_SQL = 'SELECT 1 FROM Highlights hl WHERE hl.global_hash = f.highlight_hash';

export const PROGRESS_KEYS = [
    'level', 'sm2Reps', 'lastRecall', 'fsrsStability', 'fsrsDifficulty',
    'fsrsDue', 'fsrsState', 'fsrsReps', 'fsrsLapses',
];

const PROGRESS_JOIN = (cardAlias = 'f', progressAlias = 'p') =>
    `LEFT JOIN progress.CardProgress ${progressAlias} ON ${progressAlias}.card_hash = ${cardAlias}.global_hash AND ${progressAlias}.account_id = ?`;

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

class VaultQuery {
    constructor() {
        this.db = db;
        this._typeCache = null;
    }

    onVaultOpened() {
        this._typeCache = null;
    }

    async _typeIds() {
        if (!this._typeCache) {
            const tagNodeType  = await this.db.prepare("SELECT id FROM NodeTypes WHERE name = 'Tag'").get();
            const deckNodeType = await this.db.prepare("SELECT id FROM NodeTypes WHERE name = 'Deck'").get();
            const inheritType  = await this.db.prepare("SELECT id FROM ConnectionTypes WHERE name = 'inheritance'").get();
            const tagConnType  = await this.db.prepare("SELECT id FROM ConnectionTypes WHERE name = 'tag'").get();
            const deckConnType = await this.db.prepare("SELECT id FROM ConnectionTypes WHERE name = 'deck'").get();
            const linkConnType = await this.db.prepare("SELECT id FROM ConnectionTypes WHERE name = 'link'").get();
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

    async createNode(typeName) {
        const type = await this.db.prepare('SELECT id FROM NodeTypes WHERE name = ?').get(typeName);
        if (!type) throw new Error(`${typeName} node type missing.`);
        const info = await this.db.prepare('INSERT INTO Nodes (type_id) VALUES (?)').run(type.id);
        return info.lastInsertRowid;
    }

    async getFolderByHash(hash) {
        return await this.db.prepare('SELECT * FROM Folders WHERE global_hash = ?').get(hash);
    }

    async getFolderByPath(relPath) {
        return await this.db.prepare('SELECT * FROM Folders WHERE relative_path = ?').get(relPath);
    }

    async insertFolder(data) {
        const stmt = this.db.prepare(`
            INSERT INTO Folders (node_id, global_hash, parent_id, relative_path, absolute_path, name, presence)
            VALUES (?, ?, ?, ?, ?, ?, 0)
        `);
        return await stmt.run(data.nodeId, data.globalHash, data.parentId ?? null, data.relativePath, data.absolutePath, data.name);
    }

    async getFolderByAbsolutePath(absPath) {
        return await this.db.prepare('SELECT * FROM Folders WHERE absolute_path = ?').get(absPath);
    }

    async getFolderByNodeId(nodeId) {
        return await this.db.prepare('SELECT * FROM Folders WHERE node_id = ?').get(nodeId);
    }

    async getFolderParentId(folderId) {
        return await this.db.prepare('SELECT parent_id FROM Folders WHERE id = ?').get(folderId);
    }

    async getChildDocuments(folderId) {
        return await this.db.prepare('SELECT id, node_id, relative_path FROM Documents WHERE folder_id = ?').all(folderId);
    }

    async getChildFolders(parentId) {
        return await this.db.prepare('SELECT id, node_id, relative_path, absolute_path FROM Folders WHERE parent_id = ?').all(parentId);
    }

    async updateFolderMetadata(id, data) {
        if (data.globalHash) {
            await this.db.prepare('UPDATE Folders SET global_hash = ? WHERE id = ?').run(data.globalHash, id);
        }
    }

    async getDocumentByPath(relPath) {
        return await this.db.prepare('SELECT * FROM Documents WHERE relative_path = ?').get(relPath);
    }

    async insertDocument(data) {
        const stmt = this.db.prepare(`
            INSERT INTO Documents (folder_id, node_id, global_hash, relative_path, absolute_path, name, encoding, presence)
            VALUES (?, ?, ?, ?, ?, ?, ?, 0)
        `);
        const info = await stmt.run(data.folderId, data.nodeId, data.globalHash, data.relativePath, data.absolutePath, data.name, data.encoding ?? null);
        return info;
    }

    async updateDocumentMetadata(id, data) {
        if (data.globalHash) {
            await this.db.prepare('UPDATE Documents SET global_hash = ? WHERE id = ?').run(data.globalHash, id);
        }
    }

    async deleteDocument(id) {
        await this.db.prepare('DELETE FROM Documents WHERE id = ?').run(id);
    }

    async getFlashcardsByDocument(documentId, scope) {
        return await this.db.prepare(`
            SELECT f.id, f.node_id, f.global_hash, f.content_id, f.card_type,
                   p.card_hash IS NOT NULL AS hasProgress,
                   p.level, p.sm2_reps, p.last_recall,
                   p.fsrs_stability, p.fsrs_difficulty, p.fsrs_due,
                   p.fsrs_state, p.fsrs_reps, p.fsrs_lapses
            FROM Flashcards f
            ${PROGRESS_JOIN()}
            WHERE f.document_id = ?
        `).all(scoped(scope), documentId);
    }

    async getFlashcardCountsByFolder(folderId) {
        return await this.db.prepare(`
            SELECT d.name, COUNT(fc.id) AS count
            FROM Documents d
            LEFT JOIN Flashcards fc ON fc.document_id = d.id
            WHERE d.folder_id = ?
            GROUP BY d.id
        `).all(folderId);
    }

    async getFlashcardCountInFolderTree(folderId) {
        return (await this.db.prepare(`
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
        `).get(folderId)).count;
    }

    async getFoldersByPaths(relPaths) {
        if (relPaths.length === 0) return [];
        const placeholders = relPaths.map(() => '?').join(', ');
        return await this.db.prepare(`SELECT * FROM Folders WHERE relative_path IN (${placeholders})`).all(...relPaths);
    }

    async getFlashcardCountsInFolderTrees(folderIds) {
        if (folderIds.length === 0) return new Map();
        const placeholders = folderIds.map(() => '?').join(', ');
        const rows = await this.db.prepare(`
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

    async insertFlashcard(data, scope) {
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

        const contentStmt = this.db.prepare(`
            INSERT INTO FlashcardContent (custom_html, frontText, backText, answerText, front_img, back_img, front_sound, back_sound)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const contentInfo = await contentStmt.run(customHtml, frontText, backText, answerText, fImg, bImg, fSnd, bSnd);

        let referenceId = null;
        if (data.vanillaData?.location) {
            const loc = data.vanillaData.location;
            const d = loc.data || {};
            const bboxJson = d.bbox ? JSON.stringify(d.bbox) : null;
            const refStmt = this.db.prepare(`
                INSERT INTO FlashcardReference (type, start, end, page, bbox) VALUES (?, ?, ?, ?, ?)
            `);
            const refInfo = await refStmt.run(loc.type, d.start || null, d.end || null, d.page || null, bboxJson);
            referenceId = refInfo.lastInsertRowid;
        }

        let categoryId = null;
        if (data.category) {
            const cat = await this.db.prepare("SELECT id FROM PedagogicalCategories WHERE name = ?").get(data.category);
            if (cat) categoryId = cat.id;
        }

        const stmt = this.db.prepare(`
            INSERT INTO Flashcards (global_hash, node_id, document_id, category_id, content_id, reference_id,
                name, fileIndex, presence, card_type, origin, highlight_hash)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
        `);
        const info = await stmt.run(
            data.globalHash, data.nodeId, data.documentId, categoryId,
            contentInfo.lastInsertRowid, referenceId,
            data.name || null, data.fileIndex || 0, data.cardType || 'basic', data.origin || null,
            highlightAnchor(data),
        );

        await this._writeProgress(info.lastInsertRowid, scope, data);
        return info;
    }

    async updateFlashcard(id, data, scope) {
        let categoryId = null;
        if (data.category) {
            const cat = await this.db.prepare("SELECT id FROM PedagogicalCategories WHERE name = ?").get(data.category);
            if (cat) categoryId = cat.id;
        }

        await this.db.prepare(`
            UPDATE Flashcards
            SET category_id = ?, name = ?, fileIndex = ?, card_type = ?, origin = ?
            WHERE id = ?
        `).run(
            categoryId, data.name || null, data.fileIndex, data.cardType || 'basic', data.origin || null, id,
        );
        if (data.vanillaData !== undefined) {
            await this.db.prepare('UPDATE Flashcards SET highlight_hash = ? WHERE id = ?').run(highlightAnchor(data), id);
        }

        await this._writeProgress(id, scope, data);

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
            await this.db.prepare(`UPDATE FlashcardContent SET ${contentUpdates.join(', ')} WHERE id = ?`).run(...params);
        }
    }

    async deleteFlashcard(id) {
        await this.db.prepare('DELETE FROM Flashcards WHERE id = ?').run(id);
    }

    async getFlashcardByHash(hash) {
        return await this.db.prepare('SELECT id, document_id FROM Flashcards WHERE global_hash = ?').get(hash);
    }

    async getFlashcardContentByHash(hash, scope) {
        return await this.db.prepare(`
            SELECT f.id, f.node_id, f.document_id, f.name, f.card_type, COALESCE(p.level, 0) AS level, f.origin,
                   c.frontText, c.backText, c.answerText, c.custom_html,
                   c.front_img, c.back_img, c.front_sound, c.back_sound,
                   pc.name AS category,
                   d.relative_path AS document_path
            FROM Flashcards f
            JOIN FlashcardContent c ON f.content_id = c.id
            ${PROGRESS_JOIN()}
            LEFT JOIN PedagogicalCategories pc ON pc.id = f.category_id
            LEFT JOIN Documents d ON d.id = f.document_id
            WHERE f.global_hash = ?
        `).get(scoped(scope), hash);
    }

    async _upsertProgress(flashcardId, scope, state) {
        await this.db.prepare(`
            INSERT INTO progress.CardProgress
                (card_hash, account_id, level, sm2_reps, last_recall,
                 fsrs_stability, fsrs_difficulty, fsrs_due, fsrs_state, fsrs_reps, fsrs_lapses)
            VALUES ((SELECT global_hash FROM Flashcards WHERE id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(account_id, card_hash) DO UPDATE SET
                level = excluded.level, sm2_reps = excluded.sm2_reps,
                last_recall = excluded.last_recall,
                fsrs_stability = excluded.fsrs_stability, fsrs_difficulty = excluded.fsrs_difficulty,
                fsrs_due = excluded.fsrs_due, fsrs_state = excluded.fsrs_state,
                fsrs_reps = excluded.fsrs_reps, fsrs_lapses = excluded.fsrs_lapses
        `).run(
            flashcardId, scoped(scope),
            state.level ?? null, state.sm2_reps ?? 0, state.last_recall ?? null,
            state.fsrs_stability ?? null, state.fsrs_difficulty ?? null, state.fsrs_due ?? null,
            state.fsrs_state ?? 0, state.fsrs_reps ?? 0, state.fsrs_lapses ?? 0,
        );
    }

    async getCardProgress(flashcardId, scope) {
        return await this.db.prepare(
            `SELECT * FROM progress.CardProgress WHERE card_hash = (SELECT global_hash FROM Flashcards WHERE id = ?) AND account_id = ?`
        ).get(flashcardId, scoped(scope)) ?? null;
    }

    async deleteCardProgress(flashcardId, scope) {
        await this.db.prepare(
            `DELETE FROM progress.CardProgress WHERE card_hash = (SELECT global_hash FROM Flashcards WHERE id = ?) AND account_id = ?`
        ).run(flashcardId, scoped(scope));
    }

    async _writeProgress(flashcardId, scope, data) {
        if (!PROGRESS_KEYS.some(k => data[k] !== undefined)) return;

        const state = {
            level: data.level ?? null,
            sm2_reps: data.sm2Reps ?? 0,
            last_recall: data.lastRecall ?? null,
            fsrs_stability: data.fsrsStability ?? null,
            fsrs_difficulty: data.fsrsDifficulty ?? null,
            fsrs_due: data.fsrsDue ?? null,
            fsrs_state: data.fsrsState ?? 0,
            fsrs_reps: data.fsrsReps ?? 0,
            fsrs_lapses: data.fsrsLapses ?? 0,
        };
        const carriesState = (state.level ?? 0) !== 0 || state.sm2_reps !== 0 || state.last_recall != null
            || state.fsrs_stability != null || state.fsrs_due != null
            || state.fsrs_state !== 0 || state.fsrs_reps !== 0 || state.fsrs_lapses !== 0;

        if (!carriesState && !await this.getCardProgress(flashcardId, scope)) return;
        await this._upsertProgress(flashcardId, scope, state);
    }

    async setFlashcardSrsState(id, level, sm2Reps, scope) {
        const current = await this.getCardProgress(id, scope);
        await this._upsertProgress(id, scope, { ...current, level, sm2_reps: sm2Reps });
    }

    async getAllFlashcardSrsState(scope) {
        return await this.db.prepare(`
            SELECT f.global_hash, p.level, p.sm2_reps, p.last_recall,
                   p.fsrs_stability, p.fsrs_due, p.fsrs_state
            FROM Flashcards f
            ${PROGRESS_JOIN()}
        `).all(scoped(scope));
    }

    async batchSetFsrsState(cards, scope) {
        const account = scoped(scope);
        const stmt = this._batchProgressStmt(
            `level = excluded.level, last_recall = excluded.last_recall,
             fsrs_stability = excluded.fsrs_stability, fsrs_difficulty = excluded.fsrs_difficulty,
             fsrs_due = excluded.fsrs_due, fsrs_state = excluded.fsrs_state,
             fsrs_reps = excluded.fsrs_reps, fsrs_lapses = excluded.fsrs_lapses`,
            '?, COALESCE(p.sm2_reps, 0), ?, ?, ?, ?, ?, ?, ?');
        await this.db.transaction(async (rows) => {
            for (const c of rows) {
                await stmt.run(
                    account, c.level ?? 0, c.lastRecall ?? null,
                    c.fsrsStability ?? null, c.fsrsDifficulty ?? null, c.fsrsDue ?? null,
                    c.fsrsState ?? 0, c.fsrsReps ?? 0, c.fsrsLapses ?? 0,
                    account, c.global_hash,
                );
            }
        })(cards);
    }

    async getLatestEaseFactors(scope) {
        const account = scoped(scope);
        const rows = await this.db.prepare(`
            SELECT f.global_hash, lr.ease_factor
            FROM Flashcards f
            JOIN progress.ReviewLogs lr ON lr.card_hash = f.global_hash
            WHERE lr.account_id = ?
              AND lr.id IN (SELECT MAX(id) FROM progress.ReviewLogs WHERE account_id = ? GROUP BY card_hash)
        `).all(account, account);
        return new Map(rows.map(r => [r.global_hash, r.ease_factor]));
    }

    _batchProgressStmt(assignments, selectColumns) {
        return this.db.prepare(`
            INSERT INTO progress.CardProgress
                (card_hash, account_id, level, sm2_reps, last_recall,
                 fsrs_stability, fsrs_difficulty, fsrs_due, fsrs_state, fsrs_reps, fsrs_lapses)
            SELECT f.global_hash, ?, ${selectColumns}
            FROM Flashcards f
            LEFT JOIN progress.CardProgress p ON p.card_hash = f.global_hash AND p.account_id = ?
            WHERE f.global_hash = ?
            ON CONFLICT(account_id, card_hash) DO UPDATE SET ${assignments}
        `);
    }

    async batchSetSm2Reps(cards, scope) {
        const account = scoped(scope);
        const stmt = this._batchProgressStmt('sm2_reps = excluded.sm2_reps',
            `p.level, ?, p.last_recall, p.fsrs_stability, p.fsrs_difficulty, p.fsrs_due,
             COALESCE(p.fsrs_state, 0), COALESCE(p.fsrs_reps, 0), COALESCE(p.fsrs_lapses, 0)`);
        await this.db.transaction(async (rows) => {
            for (const c of rows) await stmt.run(account, c.sm2_reps, account, c.global_hash);
        })(cards);
    }

    async batchSetLeitnerLevel(cards, scope) {
        const account = scoped(scope);
        const stmt = this._batchProgressStmt('level = excluded.level',
            `?, COALESCE(p.sm2_reps, 0), p.last_recall, p.fsrs_stability, p.fsrs_difficulty, p.fsrs_due,
             COALESCE(p.fsrs_state, 0), COALESCE(p.fsrs_reps, 0), COALESCE(p.fsrs_lapses, 0)`);
        await this.db.transaction(async (rows) => {
            for (const c of rows) await stmt.run(account, c.level, account, c.global_hash);
        })(cards);
    }

    async updateFlashcardReview(id, timestamp, newValue, algorithm = 'leitner', scope) {
        const current = await this.getCardProgress(id, scope) ?? {};
        const next = { ...current, last_recall: timestamp };
        if (algorithm === 'sm2') next.sm2_reps = newValue;
        else next.level = newValue;
        await this._upsertProgress(id, scope, next);
    }

    async insertReviewLog(data) {
        await this.db.prepare(`
            INSERT INTO progress.ReviewLogs
                (card_hash, account_id, timestamp, outcome, ease_factor, level, algorithm,
                 rating, fsrs_stability, fsrs_difficulty, fsrs_due, fsrs_state,
                 session_id, session_position, prev_distance, nearest_sibling_lag)
            VALUES ((SELECT global_hash FROM Flashcards WHERE id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            data.flashcardId, scoped(data.accountId), data.timestamp, data.outcome, data.easeFactor, data.level,
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

    async getSessionFacets(hashes) {
        const facets = new Map();
        if (!hashes?.length) return facets;

        const { tagConnTypeId, linkConnTypeId, inheritanceTypeId, deckConnTypeId } = await this._typeIds();
        const marks = (arr) => arr.map(() => '?').join(', ');

        const base = await this.db.prepare(`
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

        const nodeIds = base.map(r => r.nodeId).filter(id => id != null);
        const byNode = new Map(base.map(r => [r.nodeId, r.globalHash]));
        if (nodeIds.length > 0) {
            const nodeMarks = marks(nodeIds);
            const direct = await this.db.prepare(`
                SELECT c.origin_id AS nodeId, t.name AS name
                FROM Connections c
                JOIN Tags t ON t.node_id = c.destiny_id
                WHERE c.origin_id IN (${nodeMarks}) AND c.type_id = ?
            `).all(...nodeIds, tagConnTypeId);
            const inherited = await this.db.prepare(`
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

        const deckRows = await this.db.prepare(`
            SELECT de.card_hash AS globalHash, de.deck_id AS deckId
            FROM DeckEntries de
            WHERE de.card_hash IN (${marks(hashes)})
        `).all(...hashes);
        for (const row of deckRows) facets.get(row.globalHash)?.deckIds.add(row.deckId);

        const docNodeIds = [...new Set(base.map(r => r.docNodeId).filter(id => id != null))];
        if (docNodeIds.length > 0 && linkConnTypeId) {
            const docNodeMarks = marks(docNodeIds);
            const links = await this.db.prepare(`
                SELECT c.origin_id AS fromNode, c.destiny_id AS toNode
                FROM Connections c
                WHERE c.type_id = ?
                  AND (c.origin_id IN (${docNodeMarks}) OR c.destiny_id IN (${docNodeMarks}))
            `).all(linkConnTypeId, ...docNodeIds, ...docNodeIds);
            const docIdOfNode = new Map(base.filter(r => r.docNodeId != null).map(r => [r.docNodeId, r.docId]));
            const unknown = [...new Set(
                links.flatMap(l => [l.fromNode, l.toNode]).filter(n => !docIdOfNode.has(n))
            )];
            if (unknown.length > 0) {
                for (const row of await this.db.prepare(
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

        const parentOf = new Map(
            (await this.db.prepare('SELECT id, parent_id AS parentId FROM Folders').all())
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

    async getSessionReviewOrder(sessionId, scope) {
        return await this.db.prepare(`
            SELECT rl.session_position AS position, rl.card_hash AS globalHash
            FROM progress.ReviewLogs rl
            WHERE rl.session_id = ? AND rl.account_id = ?
            ORDER BY rl.session_position ASC, rl.id ASC
        `).all(sessionId, scoped(scope));
    }

    async getLatestReviewAlgorithm(scope) {
        return await this.db.prepare(`
            SELECT algorithm, rating
            FROM progress.ReviewLogs
            WHERE outcome IS NOT NULL AND account_id = ?
            ORDER BY timestamp DESC, id DESC
            LIMIT 1
        `).get(scoped(scope)) ?? null;
    }

    async getFsrsStatesByHash(hashes, scope) {
        const out = new Map();
        for (let i = 0; i < hashes.length; i += 500) {
            const chunk = hashes.slice(i, i + 500);
            const rows = await this.db.prepare(`
                SELECT card_hash, fsrs_stability AS stability, fsrs_difficulty AS difficulty,
                       fsrs_due AS due, fsrs_state AS state,
                       fsrs_reps AS reps, fsrs_lapses AS lapses, last_recall AS last_review
                FROM progress.CardProgress
                WHERE account_id = ? AND card_hash IN (${chunk.map(() => '?').join(', ')})
            `).all(scoped(scope), ...chunk);
            for (const r of rows) out.set(r.card_hash, r);
        }
        return out;
    }

    async getFlashcardFsrsState(id, scope) {
        return await this.db.prepare(`
            SELECT fsrs_stability AS stability, fsrs_difficulty AS difficulty,
                   fsrs_due AS due, fsrs_state AS state,
                   fsrs_reps AS reps, fsrs_lapses AS lapses, last_recall AS last_review
            FROM progress.CardProgress WHERE card_hash = (SELECT global_hash FROM Flashcards WHERE id = ?) AND account_id = ?
        `).get(id, scoped(scope)) ?? null;
    }

    async updateFlashcardFsrs(id, s, scope) {
        const current = await this.getCardProgress(id, scope) ?? {};
        await this._upsertProgress(id, scope, {
            ...current,
            last_recall: s.last_review,
            level: s.level ?? 0,
            fsrs_stability: s.stability,
            fsrs_difficulty: s.difficulty,
            fsrs_due: s.due,
            fsrs_state: s.state,
            fsrs_reps: s.reps,
            fsrs_lapses: s.lapses,
        });
    }

    async getFsrsWeights(scope) {
        const row = await this.db.prepare(
            'SELECT weights_json, review_count, optimized_at FROM progress.FsrsParameters WHERE account_id = ?'
        ).get(scoped(scope));
        if (!row) return null;
        return {
            weights: JSON.parse(row.weights_json),
            reviewCount: row.review_count,
            optimizedAt: row.optimized_at,
        };
    }

    async setFsrsWeights(weightsJson, reviewCount, scope) {
        await this.db.prepare(`
            INSERT INTO progress.FsrsParameters (account_id, weights_json, optimized_at, review_count)
            VALUES (?, ?, datetime('now'), ?)
            ON CONFLICT(account_id) DO UPDATE SET
                weights_json = excluded.weights_json,
                optimized_at = excluded.optimized_at,
                review_count = excluded.review_count
        `).run(scoped(scope), weightsJson, reviewCount);
    }

    async getAllReviewHistories(scope) {
        return await this.db.prepare(`
            SELECT f.id AS flashcard_id, rl.timestamp, rl.rating
            FROM progress.ReviewLogs rl
            JOIN Flashcards f ON f.global_hash = rl.card_hash
            WHERE rl.rating IS NOT NULL AND rl.account_id = ?
            ORDER BY f.id ASC, rl.id ASC
        `).all(scoped(scope));
    }

    async deleteLatestReviewLog(flashcardId, scope) {
        const row = await this.db.prepare(
            'SELECT id FROM progress.ReviewLogs WHERE card_hash = (SELECT global_hash FROM Flashcards WHERE id = ?) AND account_id = ? ORDER BY id DESC LIMIT 1'
        ).get(flashcardId, scoped(scope));
        if (!row) return false;
        await this.db.prepare('DELETE FROM progress.ReviewLogs WHERE id = ?').run(row.id);
        return true;
    }

    async getFlashcardReviewHistory(flashcardId, scope) {
        return await this.db.prepare(`
            SELECT id, timestamp, outcome, ease_factor, level, algorithm, rating,
                   fsrs_stability, fsrs_difficulty, fsrs_due, fsrs_state
            FROM progress.ReviewLogs
            WHERE card_hash = (SELECT global_hash FROM Flashcards WHERE id = ?) AND account_id = ?
            ORDER BY id ASC
        `).all(flashcardId, scoped(scope));
    }

    async getFlashcardSrsStateByHash(hash, scope) {
        const account = scoped(scope);
        return await this.db.prepare(`
            SELECT f.id, f.global_hash,
                   COALESCE(p.level, 0) AS level, COALESCE(p.sm2_reps, 0) AS sm2_reps,
                   p.last_recall, p.fsrs_stability, p.fsrs_difficulty,
                   COALESCE(p.fsrs_state, 0) AS fsrs_state, p.fsrs_due,
                   COALESCE(p.fsrs_reps, 0) AS fsrs_reps, COALESCE(p.fsrs_lapses, 0) AS fsrs_lapses,
                   (SELECT rl.ease_factor FROM progress.ReviewLogs rl
                     WHERE rl.card_hash = f.global_hash AND rl.account_id = ?
                     ORDER BY rl.id DESC LIMIT 1) AS ease_factor
            FROM Flashcards f
            ${PROGRESS_JOIN()}
            WHERE f.global_hash = ?
        `).get(account, account, hash);
    }

    async getLatestReviewLog(flashcardId, scope) {
        return await this.db.prepare(`
            SELECT timestamp, outcome, ease_factor, level,
                   rating, fsrs_stability, fsrs_difficulty, fsrs_due, fsrs_state
            FROM progress.ReviewLogs WHERE card_hash = (SELECT global_hash FROM Flashcards WHERE id = ?) AND account_id = ? ORDER BY id DESC LIMIT 1
        `).get(flashcardId, scoped(scope)) ?? null;
    }

    async undoFlashcardReview(id, value, lastRecall, algorithm = 'leitner', scope) {
        const current = await this.getCardProgress(id, scope) ?? {};
        const next = { ...current, last_recall: lastRecall };
        if (algorithm === 'sm2') next.sm2_reps = value;
        else next.level = value;
        await this._upsertProgress(id, scope, next);
    }

    async getLeitnerBoxes(scope) {
        return await this.db.prepare(`
            SELECT COALESCE(p.level, 0) AS level, COUNT(*) AS count
            FROM Flashcards f
            ${PROGRESS_JOIN()}
            GROUP BY COALESCE(p.level, 0)
            ORDER BY level ASC
        `).all(scoped(scope));
    }

    async getFlashcardCount() {
        return (await this.db.prepare('SELECT COUNT(*) as c FROM Flashcards').get()).c;
    }

    async getVaultLearned(scope) {
        const row = await this.db.prepare(`
            SELECT COUNT(*) AS cards,
                   COALESCE(SUM(${CARD_LEARNED_SQL('p')}), 0) AS learnedSum
            FROM Flashcards f
            ${PROGRESS_JOIN()}
        `).get(scoped(scope));
        return { cards: row?.cards ?? 0, learnedSum: row?.learnedSum ?? 0 };
    }

    async getMasteredFlashcardCount(threshold, scope) {
        return (await this.db.prepare(
            'SELECT COUNT(*) as c FROM progress.CardProgress WHERE account_id = ? AND level >= ?'
        ).get(scoped(scope), threshold)).c;
    }

    async getReviewActivity(sinceIso = null, scope) {
        const clause = sinceIso
            ? "WHERE outcome IS NOT NULL AND account_id = ? AND date(timestamp, 'localtime') >= ?"
            : 'WHERE outcome IS NOT NULL AND account_id = ?';
        const stmt = this.db.prepare(`
            SELECT date(timestamp, 'localtime') AS day,
                   COUNT(*) AS total,
                   SUM(CASE WHEN outcome = 1 THEN 1 ELSE 0 END) AS correct
            FROM progress.ReviewLogs
            ${clause}
            GROUP BY day
            ORDER BY day ASC
        `);
        const account = scoped(scope);
        return sinceIso ? await stmt.all(account, sinceIso) : await stmt.all(account);
    }

    async getReviewTotals(sinceIso = null, scope) {
        const clause = sinceIso
            ? "WHERE outcome IS NOT NULL AND account_id = ? AND date(timestamp, 'localtime') >= ?"
            : 'WHERE outcome IS NOT NULL AND account_id = ?';
        const stmt = this.db.prepare(`
            SELECT COUNT(*) AS total,
                   SUM(CASE WHEN outcome = 1 THEN 1 ELSE 0 END) AS correct
            FROM progress.ReviewLogs
            ${clause}
        `);
        const account = scoped(scope);
        return sinceIso ? await stmt.get(account, sinceIso) : await stmt.get(account);
    }

    _orderedReviewsCte() {
        return `
            WITH ordered AS (
                SELECT card_hash, outcome, timestamp,
                       ROW_NUMBER() OVER (
                           PARTITION BY card_hash ORDER BY timestamp ASC, id ASC
                       ) AS rep
                FROM progress.ReviewLogs
                WHERE outcome IS NOT NULL AND account_id = ?
            )
        `;
    }

    async getReviewTotalsByPhase(learningReviews, sinceIso = null, scope) {
        const stmt = this.db.prepare(`
            ${this._orderedReviewsCte()}
            SELECT CASE WHEN rep <= ? THEN 'learning' ELSE 'review' END AS phase,
                   COUNT(*) AS total,
                   SUM(CASE WHEN outcome = 1 THEN 1 ELSE 0 END) AS correct
            FROM ordered
            ${sinceIso ? "WHERE date(timestamp, 'localtime') >= ?" : ''}
            GROUP BY phase
        `);
        const account = scoped(scope);
        const rows = sinceIso
            ? await stmt.all(account, learningReviews, sinceIso)
            : await stmt.all(account, learningReviews);
        const out = { learning: { total: 0, correct: 0 }, review: { total: 0, correct: 0 } };
        for (const r of rows) out[r.phase] = { total: r.total ?? 0, correct: r.correct ?? 0 };
        return out;
    }

    async getFirstExposureTotals(sinceIso = null, scope) {
        const stmt = this.db.prepare(`
            ${this._orderedReviewsCte()}
            SELECT COUNT(*) AS total,
                   SUM(CASE WHEN outcome = 1 THEN 1 ELSE 0 END) AS correct
            FROM ordered
            WHERE rep = 1 ${sinceIso ? "AND date(timestamp, 'localtime') >= ?" : ''}
        `);
        const account = scoped(scope);
        const row = sinceIso ? await stmt.get(account, sinceIso) : await stmt.get(account);
        return { total: row?.total ?? 0, correct: row?.correct ?? 0 };
    }

    async getReviewsToFirstRecall(scope) {
        return await this.db.prepare(`
            ${this._orderedReviewsCte()}
            SELECT f.id AS flashcard_id, MIN(o.rep) AS attempts
            FROM ordered o
            JOIN Flashcards f ON f.global_hash = o.card_hash
            WHERE o.outcome = 1
            GROUP BY f.id
        `).all(scoped(scope));
    }

    async getDayReviewTotals(dayIso, scope) {
        return await this.db.prepare(`
            SELECT COUNT(*) AS reviews,
                   COUNT(DISTINCT card_hash) AS uniqueCards,
                   SUM(CASE WHEN outcome = 0 THEN 1 ELSE 0 END) AS failed
            FROM progress.ReviewLogs
            WHERE outcome IS NOT NULL AND account_id = ? AND date(timestamp, 'localtime') = ?
        `).get(scoped(scope), dayIso);
    }

    async getDayReviewTotalsByPhase(learningReviews, dayIso, scope) {
        const rows = await this.db.prepare(`
            ${this._orderedReviewsCte()}
            SELECT CASE WHEN rep <= ? THEN 'learning' ELSE 'review' END AS phase,
                   COUNT(*) AS total,
                   SUM(CASE WHEN outcome = 1 THEN 1 ELSE 0 END) AS correct
            FROM ordered
            WHERE date(timestamp, 'localtime') = ?
            GROUP BY phase
        `).all(scoped(scope), learningReviews, dayIso);
        const out = { learning: { total: 0, correct: 0 }, review: { total: 0, correct: 0 } };
        for (const r of rows) out[r.phase] = { total: r.total ?? 0, correct: r.correct ?? 0 };
        return out;
    }

    async getDayNewCards(dayIso, scope) {
        return (await this.db.prepare(`
            SELECT COUNT(*) AS newCards FROM (
                SELECT card_hash, MIN(date(timestamp, 'localtime')) AS firstDay
                FROM progress.ReviewLogs
                WHERE outcome IS NOT NULL AND account_id = ?
                GROUP BY card_hash
                HAVING firstDay = ?
            )
        `).get(scoped(scope), dayIso)).newCards;
    }

    async getDayByDeck(dayIso, scope) {
        return await this.db.prepare(`
            SELECT d.name AS deck,
                   COUNT(*) AS reviews,
                   SUM(CASE WHEN rl.outcome = 0 THEN 1 ELSE 0 END) AS failed
            FROM progress.ReviewLogs rl
            JOIN Flashcards f ON f.global_hash = rl.card_hash
            JOIN DeckEntries de ON de.card_hash = f.global_hash
            JOIN Decks d ON d.id = de.deck_id
            WHERE rl.outcome IS NOT NULL
              AND rl.account_id = ?
              AND date(rl.timestamp, 'localtime') = ?
              AND COALESCE(d.is_system, 0) = 0
            GROUP BY d.id
            ORDER BY reviews DESC, d.name ASC
        `).all(scoped(scope), dayIso);
    }

    async getDayByDocument(dayIso, scope) {
        return await this.db.prepare(`
            SELECT doc.relative_path AS path,
                   COUNT(*) AS reviews,
                   SUM(CASE WHEN rl.outcome = 0 THEN 1 ELSE 0 END) AS failed
            FROM progress.ReviewLogs rl
            JOIN Flashcards f ON f.global_hash = rl.card_hash
            JOIN Documents doc ON doc.id = f.document_id
            WHERE rl.outcome IS NOT NULL AND rl.account_id = ? AND date(rl.timestamp, 'localtime') = ?
            GROUP BY doc.id
            ORDER BY reviews DESC, doc.relative_path ASC
        `).all(scoped(scope), dayIso);
    }

    async getDayStruggledCards(dayIso, limit = 10, scope) {
        return await this.db.prepare(`
            SELECT f.global_hash AS globalHash,
                   fc.frontText AS front,
                   SUM(CASE WHEN rl.outcome = 0 THEN 1 ELSE 0 END) AS failCount
            FROM progress.ReviewLogs rl
            JOIN Flashcards f ON f.global_hash = rl.card_hash
            LEFT JOIN FlashcardContent fc ON fc.id = f.content_id
            WHERE rl.outcome IS NOT NULL AND rl.account_id = ? AND date(rl.timestamp, 'localtime') = ?
            GROUP BY f.id
            HAVING failCount > 0
            ORDER BY failCount DESC, f.id ASC
            LIMIT ?
        `).all(scoped(scope), dayIso, limit);
    }

    async getReviewActivityDays(scope) {
        return (await this.db.prepare(`
            SELECT date(timestamp, 'localtime') AS day
            FROM progress.ReviewLogs
            WHERE outcome IS NOT NULL AND account_id = ?
            GROUP BY day
            ORDER BY day ASC
        `).all(scoped(scope))).map(r => r.day);
    }

    async getDueFlashcards({
        algorithm = 'leitner', folder = null, document = null, deck = null, tags = null,
        maxNew = 20, minPriority = 0,
        readDocuments = null, readExcludeCards = null,
        excludeFolders = null, excludeDocuments = null, excludeDecks = null, excludeTags = null,
    } = {}, scope) {
        const account = scoped(scope);
        const cteParts = [];
        const whereConditions = [];

        const folderParams = [];
        const excludeFolderParams = [];
        const efParams = [];
        const cardsParams = [];

        if (folder !== null) {
            cteParts.push(`folder_tree AS (
                SELECT id FROM Folders WHERE relative_path = ?
                UNION ALL
                SELECT fo.id FROM Folders fo
                JOIN folder_tree ft ON fo.parent_id = ft.id
            )`);
            folderParams.push(folder);
            whereConditions.push('d.folder_id IN (SELECT id FROM folder_tree)');
        }

        if (excludeFolders && excludeFolders.length > 0) {
            const placeholders = excludeFolders.map(() => '?').join(', ');
            cteParts.push(`excluded_tree AS (
                SELECT id FROM Folders WHERE relative_path IN (${placeholders})
                UNION ALL
                SELECT fo.id FROM Folders fo
                JOIN excluded_tree et ON fo.parent_id = et.id
            )`);
            excludeFolderParams.push(...excludeFolders);
            whereConditions.push('(d.folder_id IS NULL OR d.folder_id NOT IN (SELECT id FROM excluded_tree))');
        }

        if (deck !== null) {
            whereConditions.push(`f.global_hash IN (
                SELECT de.card_hash FROM DeckEntries de
                JOIN Decks dk ON dk.id = de.deck_id
                WHERE dk.global_hash = ?
            )`);
            cardsParams.push(deck);
        }

        if (algorithm === 'sm2') {
            cteParts.push(`latest_ef AS (
                SELECT card_hash, ease_factor FROM progress.ReviewLogs
                WHERE account_id = ?
                  AND id IN (SELECT MAX(id) FROM progress.ReviewLogs WHERE account_id = ? GROUP BY card_hash)
            )`);
            efParams.push(account, account);
        }

        if (tags && tags.length > 0) {
            const placeholders = tags.map(() => '?').join(', ');
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
            cardsParams.push(...tags, ...tags);
        }

        if (minPriority > 0) {
            whereConditions.push('COALESCE(pc.priority, 0) >= ?');
            cardsParams.push(minPriority);
        }

        if (document !== null) {
            whereConditions.push('d.relative_path = ?');
            cardsParams.push(document);
        }

        if (readDocuments) {
            whereConditions.push('(f.document_id IS NULL OR d.relative_path IN (SELECT value FROM json_each(?)))');
            cardsParams.push(JSON.stringify(readDocuments));
        }

        if (readExcludeCards && readExcludeCards.length > 0) {
            whereConditions.push('f.global_hash NOT IN (SELECT value FROM json_each(?))');
            cardsParams.push(JSON.stringify(readExcludeCards));
        }

        if (excludeDocuments && excludeDocuments.length > 0) {
            const placeholders = excludeDocuments.map(() => '?').join(', ');
            whereConditions.push(`(d.relative_path IS NULL OR d.relative_path NOT IN (${placeholders}))`);
            cardsParams.push(...excludeDocuments);
        }

        if (excludeDecks && excludeDecks.length > 0) {
            const placeholders = excludeDecks.map(() => '?').join(', ');
            whereConditions.push(`f.global_hash NOT IN (
                SELECT de.card_hash FROM DeckEntries de
                JOIN Decks dk ON dk.id = de.deck_id
                WHERE dk.global_hash IN (${placeholders})
            )`);
            cardsParams.push(...excludeDecks);
        }

        if (excludeTags && excludeTags.length > 0) {
            const placeholders = excludeTags.map(() => '?').join(', ');
            whereConditions.push(`NOT (
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
            cardsParams.push(...excludeTags, ...excludeTags);
        }

        const extraWhere = whereConditions.length > 0
            ? 'AND ' + whereConditions.join('\n          AND ')
            : '';

        const sm2Join = algorithm === 'sm2'
            ? 'LEFT JOIN latest_ef lr ON lr.card_hash = f.global_hash'
            : '';

        const easeFactorExpr = algorithm === 'sm2'
            ? `CASE WHEN lr.ease_factor IS NULL OR lr.ease_factor < 1.3 THEN 2.5 ELSE lr.ease_factor END`
            : `2.5`;

        const intervalExpr = algorithm === 'sm2'
            ? `CASE
                WHEN COALESCE(p.sm2_reps, 0) <= 1 THEN 1
                WHEN p.sm2_reps = 2 THEN 6
                ELSE min(365, CAST(ROUND(6.0 * pow(${easeFactorExpr}, CAST(p.sm2_reps - 2 AS REAL))) AS INTEGER))
               END`
            : `CASE
                WHEN COALESCE(p.level, 0) <= 0 THEN 0
                ELSE min(365, CAST(pow(2.0, CAST(COALESCE(p.level, 0) - 1 AS REAL)) AS INTEGER))
               END`;

        const isFsrs = algorithm === 'fsrs';

        const levelExpr = isFsrs
            ? 'CAST(ROUND(COALESCE(p.fsrs_stability, 0)) AS INTEGER)'
            : algorithm === 'sm2'
                ? 'COALESCE(p.sm2_reps, 0)'
                : 'COALESCE(p.level, 0)';

        cteParts.push(`cards AS (
            SELECT
                f.global_hash,
                ${levelExpr} AS level,
                p.last_recall,
                p.fsrs_due,
                COALESCE(p.fsrs_state, 0) AS fsrs_state,
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
            ${PROGRESS_JOIN()}
            LEFT JOIN Documents d ON d.id = f.document_id
            JOIN FlashcardContent fc ON fc.id = f.content_id
            LEFT JOIN PedagogicalCategories pc ON pc.id = f.category_id
            ${sm2Join}
            WHERE 1=1
            ${extraWhere}
        )`);
        cardsParams.unshift(account);

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

        const allRows = await this.db.prepare(`
            WITH RECURSIVE ${cteParts.join(',\n')}
            SELECT *,
              ${dueDateExpr} AS due_date,
              ${statusExpr} AS _status
            FROM cards
        `).all(...folderParams, ...excludeFolderParams, ...efParams, ...cardsParams);

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

    async getAllTags() {
        return (await this.db.prepare('SELECT DISTINCT name FROM Tags ORDER BY name ASC').all()).map(r => r.name);
    }

    async getTagsWithCounts() {
        const { tagConnTypeId } = await this._typeIds();
        return await this.db.prepare(`
            SELECT t.name AS name, COUNT(c.id) AS count
            FROM Tags t
            LEFT JOIN Connections c
              ON c.destiny_id = t.node_id AND c.type_id = ?
            GROUP BY t.node_id, t.name
            ORDER BY count DESC, t.name ASC
        `).all(tagConnTypeId);
    }

    _carriesTagSql(op = '=') {
        return `(EXISTS (
                SELECT 1 FROM Connections ctag
                JOIN Tags tg ON tg.node_id = ctag.destiny_id
                WHERE ctag.origin_id = f.node_id
                  AND ctag.type_id = (SELECT id FROM ConnectionTypes WHERE name = 'tag')
                  AND tg.name ${op} ?
            ) OR EXISTS (
                SELECT 1 FROM InheritedTags it
                JOIN Connections cinh ON cinh.id = it.connection_id
                JOIN Tags tgi ON tgi.id = it.tag_id
                WHERE cinh.destiny_id = f.node_id
                  AND cinh.type_id IN (SELECT id FROM ConnectionTypes WHERE name IN ('inheritance', 'deck'))
                  AND tgi.name ${op} ?
            ))`;
    }

    _cardMatchSql(text) {
        const term = `%${text}%`;
        return {
            sql: `(c.frontText LIKE ? OR c.backText LIKE ? OR c.answerText LIKE ? OR f.name LIKE ?
                OR f.global_hash IN (SELECT de.card_hash FROM DeckEntries de JOIN Decks dk ON dk.id = de.deck_id WHERE dk.name LIKE ?)
                OR f.document_id IN (SELECT id FROM Documents WHERE name LIKE ?)
                OR ${this._carriesTagSql('LIKE')})`,
            params: [term, term, term, term, term, term, term, term],
        };
    }

    async getTagOverview() {
        const { tagConnTypeId } = await this._typeIds();
        const reach = await this.db.prepare(`
            SELECT t.id AS id, t.name AS name,
                   SUM(CASE WHEN nt.name = 'Folder' THEN 1 ELSE 0 END) AS folders,
                   SUM(CASE WHEN nt.name = 'Document' THEN 1 ELSE 0 END) AS documents,
                   SUM(CASE WHEN nt.name = 'Deck' THEN 1 ELSE 0 END) AS decks,
                   SUM(CASE WHEN nt.name = 'Flashcard' THEN 1 ELSE 0 END) AS cardsDirect
            FROM Tags t
            LEFT JOIN Connections c ON c.destiny_id = t.node_id AND c.type_id = ?
            LEFT JOIN Nodes n ON n.id = c.origin_id
            LEFT JOIN NodeTypes nt ON nt.id = n.type_id
            GROUP BY t.id, t.name
        `).all(tagConnTypeId);
        const carried = await this.db.prepare(`
            SELECT tag_id, COUNT(DISTINCT card_id) AS cards FROM (
                SELECT tg.id AS tag_id, f.id AS card_id
                FROM Flashcards f
                JOIN Connections c ON c.origin_id = f.node_id AND c.type_id = ?
                JOIN Tags tg ON tg.node_id = c.destiny_id
                UNION
                SELECT it.tag_id AS tag_id, f.id AS card_id
                FROM Flashcards f
                JOIN Connections cinh ON cinh.destiny_id = f.node_id
                  AND cinh.type_id IN (SELECT id FROM ConnectionTypes WHERE name IN ('inheritance', 'deck'))
                JOIN InheritedTags it ON it.connection_id = cinh.id
            ) GROUP BY tag_id
        `).all(tagConnTypeId);
        const cardsBy = new Map(carried.map((r) => [r.tag_id, r.cards]));
        return reach.map((r) => ({
            name: r.name,
            folders: r.folders ?? 0,
            documents: r.documents ?? 0,
            decks: r.decks ?? 0,
            cardsDirect: r.cardsDirect ?? 0,
            cards: cardsBy.get(r.id) ?? 0,
        }));
    }

    async getTagByName(name) {
        return await this.db.prepare('SELECT * FROM Tags WHERE name = ?').get(name);
    }

    async insertTag(name, nodeId) {
        return await this.db.prepare('INSERT INTO Tags (name, node_id, presence) VALUES (?, ?, 0)').run(name, nodeId);
    }

    async syncNodeTags(nodeId, tagNodeIds) {
        const { tagNodeTypeId, tagConnTypeId } = await this._typeIds();

        const currentConns = await this.db.prepare(`
            SELECT c.id, c.destiny_id FROM Connections c
            JOIN Nodes n ON c.destiny_id = n.id
            WHERE c.origin_id = ? AND n.type_id = ? AND c.type_id = ?
        `).all(nodeId, tagNodeTypeId, tagConnTypeId);

        const currentTagIdSet = new Set(currentConns.map(c => c.destiny_id));
        const tagNodeIdSet = new Set(tagNodeIds);

        for (const tid of tagNodeIds) {
            if (!currentTagIdSet.has(tid)) {
                await this.db.prepare("INSERT INTO Connections (origin_id, destiny_id, type_id) VALUES (?, ?, ?)").run(nodeId, tid, tagConnTypeId);
            }
        }
        for (const conn of currentConns) {
            if (!tagNodeIdSet.has(conn.destiny_id)) {
                await this.db.prepare("DELETE FROM Connections WHERE id = ?").run(conn.id);
                await this.deleteTagIfOrphaned(conn.destiny_id);
            }
        }
    }

    async deleteTagIfOrphaned(tagNodeId) {
        const { tagConnTypeId } = await this._typeIds();
        const remaining = await this.db.prepare(
            "SELECT 1 FROM Connections WHERE destiny_id = ? AND type_id = ? LIMIT 1"
        ).get(tagNodeId, tagConnTypeId);
        if (!remaining) {
            await this.db.prepare("DELETE FROM Tags WHERE node_id = ?").run(tagNodeId);
        }
    }

    async insertMedia(data) {
        const stmt = this.db.prepare(`
            INSERT INTO Media (hash, name, relative_path, absolute_path)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(hash) DO UPDATE SET
                relative_path=excluded.relative_path,
                absolute_path=excluded.absolute_path
        `);
        return await stmt.run(data.hash, data.name, data.relativePath, data.absolutePath);
    }

    async getMediaByHash(hash) {
        return await this.db.prepare('SELECT * FROM Media WHERE hash = ?').get(hash);
    }

    async deleteMediaByAbsPath(absolutePath) {
        return await this.db.prepare('DELETE FROM Media WHERE absolute_path = ?').run(absolutePath);
    }

    async getMediaByAbsPathPrefix(prefix) {
        return await this.db.prepare('SELECT * FROM Media WHERE absolute_path LIKE ?').all(prefix + '%');
    }

    async updateMediaPath(oldAbsPath, newRelPath, newAbsPath) {
        return this.db.prepare('UPDATE Media SET relative_path = ?, absolute_path = ? WHERE absolute_path = ?')
            .run(newRelPath, newAbsPath, oldAbsPath);
    }

    async cascadeMediaPaths(oldRelPath, newRelPath, oldAbsPath, newAbsPath) {
        this.db.prepare(`UPDATE Media SET relative_path = ? || substr(relative_path, length(?) + 1), absolute_path = ? || substr(absolute_path, length(?) + 1) WHERE absolute_path LIKE ? || '%' ESCAPE '\\'`)
            .run(newRelPath, oldRelPath, newAbsPath, oldAbsPath, this._escapeLike(oldAbsPath));
    }

    async getSubscription(magazineId) {
        return await this.db.prepare('SELECT * FROM Subscriptions WHERE magazine_id = ?').get(magazineId);
    }

    async listSubscriptions() {
        return await this.db.prepare('SELECT * FROM Subscriptions').all();
    }

    async upsertSubscription(data) {
        const stmt = this.db.prepare(`
            INSERT INTO Subscriptions (magazine_id, issue_id, version, target_path, last_sync)
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(magazine_id) DO UPDATE SET
                issue_id = excluded.issue_id,
                version = excluded.version,
                target_path = excluded.target_path,
                last_sync = CURRENT_TIMESTAMP
        `);
        return await stmt.run(data.magazineId, data.issueId, data.version, data.targetPath);
    }

    async renameFolderRecord(newName, newRelPath, newAbsPath, oldAbsPath) {
        this.db.prepare('UPDATE Folders SET name = ?, relative_path = ?, absolute_path = ? WHERE absolute_path = ?')
            .run(newName, newRelPath, newAbsPath, oldAbsPath);
    }

    async renameDocumentRecord(newName, newRelPath, newAbsPath, oldAbsPath) {
        this.db.prepare('UPDATE Documents SET name = ?, relative_path = ?, absolute_path = ? WHERE absolute_path = ?')
            .run(newName, newRelPath, newAbsPath, oldAbsPath);
    }

    _escapeLike(str) {
        return str.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    }

    async cascadeRenameDocumentPaths(oldRelPath, newRelPath, oldAbsPath, newAbsPath) {
        this.db.prepare(`UPDATE Documents SET relative_path = ? || substr(relative_path, length(?) + 1), absolute_path = ? || substr(absolute_path, length(?) + 1) WHERE absolute_path LIKE ? || '%' ESCAPE '\\'`)
            .run(newRelPath, oldRelPath, newAbsPath, oldAbsPath, this._escapeLike(oldAbsPath));
    }

    async cascadeRenameFolderPaths(oldRelPath, newRelPath, oldAbsPath, newAbsPath) {
        this.db.prepare(`UPDATE Folders SET relative_path = ? || substr(relative_path, length(?) + 1), absolute_path = ? || substr(absolute_path, length(?) + 1) WHERE absolute_path LIKE ? || '%' ESCAPE '\\'`)
            .run(newRelPath, oldRelPath, newAbsPath, oldAbsPath, this._escapeLike(oldAbsPath));
    }

    async moveDocumentRecord(newFolderId, newRelPath, newAbsPath, oldAbsPath) {
        this.db.prepare('UPDATE Documents SET folder_id = ?, relative_path = ?, absolute_path = ? WHERE absolute_path = ?')
            .run(newFolderId, newRelPath, newAbsPath, oldAbsPath);
    }

    async moveFolderRecord(newRelPath, newAbsPath, oldAbsPath, newParentId) {
        this.db.prepare('UPDATE Folders SET relative_path = ?, absolute_path = ?, parent_id = ? WHERE absolute_path = ?')
            .run(newRelPath, newAbsPath, newParentId ?? null, oldAbsPath);
    }

    async deleteFolderTree(absPath, sep) {
        this.db.prepare(`DELETE FROM Folders WHERE absolute_path = ? OR absolute_path LIKE ? ESCAPE '\\'`)
            .run(absPath, this._escapeLike(absPath) + sep + '%');
    }

    async deleteDocumentByAbsPath(absPath) {
        await this.db.prepare('DELETE FROM Documents WHERE absolute_path = ?').run(absPath);
    }

    async getDocumentsByAbsPathPrefix(absPrefix) {
        return this.db.prepare(`SELECT absolute_path, relative_path FROM Documents WHERE absolute_path LIKE ? || '%' ESCAPE '\\'`)
            .all(this._escapeLike(absPrefix));
    }

    async getDocumentsInTree(absPrefix) {
        return this.db.prepare(`SELECT id, global_hash, relative_path, absolute_path, name
            FROM Documents WHERE absolute_path LIKE ? || '%' ESCAPE '\\'`)
            .all(this._escapeLike(absPrefix));
    }

    async getFoldersByAbsPathPrefix(absPrefix, excludeAbsPath) {
        return this.db.prepare(`SELECT absolute_path, relative_path FROM Folders WHERE absolute_path LIKE ? || '%' ESCAPE '\\' AND absolute_path != ?`)
            .all(this._escapeLike(absPrefix), excludeAbsPath);
    }

    async insertInheritance(parentNodeId, childNodeId) {
        const typeId = (await this._typeIds()).inheritanceTypeId;
        if (!typeId) throw new Error('inheritance connection type missing');
        return await this.db.prepare(
            'INSERT INTO Connections (origin_id, destiny_id, type_id) VALUES (?, ?, ?)'
        ).run(parentNodeId, childNodeId, typeId);
    }

    async deleteInheritance(parentNodeId, childNodeId) {
        const typeId = (await this._typeIds()).inheritanceTypeId;
        if (!typeId) return;
        await this.db.prepare(
            'DELETE FROM Connections WHERE origin_id = ? AND destiny_id = ? AND type_id = ?'
        ).run(parentNodeId, childNodeId, typeId);
    }

    async getNodeIdByFolderAbsPath(absPath) {
        const row = await this.db.prepare('SELECT node_id FROM Folders WHERE absolute_path = ?').get(absPath);
        return row ? row.node_id : null;
    }

    async getDocumentByAbsolutePath(absPath) {
        return await this.db.prepare('SELECT * FROM Documents WHERE absolute_path = ?').get(absPath);
    }

    async getNodeIdByDocumentAbsPath(absPath) {
        const row = await this.db.prepare('SELECT node_id FROM Documents WHERE absolute_path = ?').get(absPath);
        return row ? row.node_id : null;
    }

    async search(query) {
        const term = `%${query}%`;
        const docs = await this.db.prepare(`SELECT 'document' as type, name, relative_path, global_hash FROM Documents WHERE name LIKE ?`).all(term);
        const cards = await this.db.prepare(`
            SELECT 'flashcard' as type, f.global_hash, c.frontText, c.backText, c.answerText
            FROM Flashcards f JOIN FlashcardContent c ON f.content_id = c.id
            WHERE c.frontText LIKE ? OR c.backText LIKE ? OR c.answerText LIKE ? OR f.global_hash = ? OR f.name LIKE ?
        `).all(term, term, term, query, term);
        const tags = await this.db.prepare(`SELECT 'tag' as type, t.name, null as frontText, null as backText, null as answerText FROM Tags t WHERE t.name LIKE ?`).all(term);
        return [...docs, ...cards, ...tags];
    }

    async superSearch({ q = null, tag = null, deck = null, document: docQ = null, folder = null, limit = 20 } = {}, scope) {
        const hasFilter = tag || deck || docQ || folder;
        const probe = limit + 1;
        const cut = (rows) => rows.slice(0, limit);
        if (hasFilter) {
            const flashcards = await this._searchFlashcards({ q, tag, deck, docQ, folder, limit: probe }, scope);
            return { flashcards: cut(flashcards), truncated: { flashcards: flashcards.length > limit } };
        }

        if (!q || !q.trim()) return { folders: [], documents: [], flashcards: [], tags: [], decks: [], truncated: {} };
        const term = `%${q.trim()}%`;

        const folders = await this.db.prepare(
            `SELECT name, relative_path as path, global_hash FROM Folders WHERE name LIKE ? LIMIT ?`
        ).all(term, probe);

        const documents = await this.db.prepare(
            `SELECT name, relative_path as path, global_hash FROM Documents WHERE name LIKE ? LIMIT ?`
        ).all(term, probe);

        const flashcards = await this._searchFlashcards({ q: q.trim(), limit: probe }, scope);

        const tags = await this.db.prepare(
            `SELECT name FROM Tags WHERE name LIKE ? LIMIT ?`
        ).all(term, probe);

        const decks = await this.db.prepare(
            `SELECT name, global_hash FROM Decks WHERE name LIKE ? LIMIT ?`
        ).all(term, probe);

        const groups = { folders, documents, flashcards, tags, decks };
        const truncated = Object.fromEntries(Object.entries(groups).map(([k, rows]) => [k, rows.length > limit]));
        return { ...Object.fromEntries(Object.entries(groups).map(([k, rows]) => [k, cut(rows)])), truncated };
    }

    async _searchFlashcards({ q = null, tag = null, deck = null, docQ = null, folder = null, limit = 50 } = {}, scope) {
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
            const match = this._cardMatchSql(q);
            conditions.push(match.sql);
            condParams.push(...match.params);
        }

        const whereSQL = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        const allParams = [...cteParams, scoped(scope), ...condParams, limit];

        return await this.db.prepare(`
            ${cteSQL}
            SELECT f.global_hash, f.name, f.card_type, COALESCE(p.level, 0) AS level, f.origin,
                   c.frontText, c.backText, c.answerText,
                   d.relative_path as document_path, d.name as document_name
            FROM Flashcards f
            ${PROGRESS_JOIN()}
            JOIN FlashcardContent c ON f.content_id = c.id
            LEFT JOIN Documents d ON d.id = f.document_id
            ${whereSQL}
            LIMIT ?
        `).all(...allParams);
    }

    async getFlashcardAvgLevel(documentId, scope) {
        return await this.db.prepare(`
            SELECT AVG(COALESCE(p.level, 0)) as score
            FROM Flashcards f
            ${PROGRESS_JOIN()}
            WHERE f.document_id = ?
        `).get(scoped(scope), documentId);
    }

    async getDocumentFolderIdById(documentId) {
        return await this.db.prepare('SELECT folder_id FROM Documents WHERE id = ?').get(documentId);
    }

    async getFolderById(folderId) {
        return await this.db.prepare('SELECT * FROM Folders WHERE id = ?').get(folderId);
    }

    async getDocumentPresenceStats(folderId) {
        return await this.db.prepare('SELECT count(*) as cnt, sum(presence) as total FROM Documents WHERE folder_id = ?').get(folderId);
    }

    async getChildFolderPresences(parentId) {
        return await this.db.prepare('SELECT presence FROM Folders WHERE parent_id = ?').all(parentId);
    }

    async updateDocumentPresence(documentId, score) {
        return await this.db.prepare('UPDATE Documents SET presence = ? WHERE id = ?').run(score, documentId);
    }

    async updateFolderPresence(folderId, presence) {
        return await this.db.prepare('UPDATE Folders SET presence = ? WHERE id = ?').run(presence, folderId);
    }

    async getHierarchyTypeId() {
        return { id: (await this._typeIds()).inheritanceTypeId };
    }

    async getInheritedTagNames(nodeId) {
        return (await this.db.prepare(`
            SELECT DISTINCT t.name FROM InheritedTags it
            JOIN Connections c ON it.connection_id = c.id
            JOIN Tags t ON t.id = it.tag_id
            WHERE c.destiny_id = ?
              AND c.type_id IN (SELECT id FROM ConnectionTypes WHERE name IN ('inheritance', 'deck'))
        `).all(nodeId)).map(t => t.name);
    }

    async getDirectTagNames(nodeId) {
        const { tagConnTypeId } = await this._typeIds();
        return (await this.db.prepare(`
            SELECT t.name FROM Connections c
            JOIN Tags t ON t.node_id = c.destiny_id
            WHERE c.origin_id = ? AND c.type_id = ?
        `).all(nodeId, tagConnTypeId)).map(r => r.name);
    }

    async getOrCreateConnection(originId, destId, typeId) {
        let conn = await this.db.prepare('SELECT id FROM Connections WHERE origin_id = ? AND destiny_id = ? AND type_id = ?').get(originId, destId, typeId);
        if (!conn) {
            const info = await this.db.prepare('INSERT INTO Connections (origin_id, destiny_id, type_id) VALUES (?, ?, ?)').run(originId, destId, typeId);
            conn = { id: info.lastInsertRowid };
        }
        return conn;
    }

    async clearInheritedTags(connectionId) {
        return await this.db.prepare('DELETE FROM InheritedTags WHERE connection_id = ?').run(connectionId);
    }

    async insertInheritedTag(connectionId, tagId) {
        return await this.db.prepare('INSERT INTO InheritedTags (connection_id, tag_id) VALUES (?, ?)').run(connectionId, tagId);
    }

    async getFlashcardNodeIds(documentId) {
        return await this.db.prepare('SELECT node_id FROM Flashcards WHERE document_id = ?').all(documentId);
    }

    async getGraphData(scope) {
        const account = scoped(scope);
        const nodes = await this.db.prepare(`
            WITH RECURSIVE folder_tree AS (
                SELECT id, id AS root_id FROM Folders
                UNION ALL
                SELECT fo.id, ft.root_id FROM Folders fo
                JOIN folder_tree ft ON fo.parent_id = ft.id
            ),
            -- Recursive card rollup per folder: every card in the folder's whole
            -- subtree, counted and summed. Folders.presence can't stand in for this
            -- — it's an unweighted average of document presences, so it says how
            -- well the folder is known but nothing about how much it holds.
            -- Seeded from every folder, so this is O(folders x depth); at vault
            -- scale that's cheaper than a query per folder.
            folder_rollup AS (
                SELECT ft.root_id,
                       COUNT(ffc.id)                                 AS cardCount,
                       COALESCE(SUM(${CARD_LEARNED_SQL('ffp')}), 0)  AS learnedSum
                FROM folder_tree ft
                JOIN Documents fd ON fd.folder_id = ft.id
                LEFT JOIN Flashcards ffc ON ffc.document_id = fd.id
                ${PROGRESS_JOIN('ffc', 'ffp')}
                GROUP BY ft.root_id
            )
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
                   fr.cardCount      as folderCardCount,
                   fr.learnedSum     as folderLearnedSum,
                   ${CARD_LEARNED_SQL('fcp')} as flashcardLearned
            FROM Nodes n
            JOIN NodeTypes nt ON n.type_id = nt.id
            LEFT JOIN Documents d   ON d.node_id   = n.id
            LEFT JOIN Folders f     ON f.node_id   = n.id
            LEFT JOIN Tags t        ON t.node_id   = n.id
            LEFT JOIN Flashcards fc ON fc.node_id  = n.id
            ${PROGRESS_JOIN('fc', 'fcp')}
            LEFT JOIN FlashcardContent fcc ON fcc.id = fc.content_id
            LEFT JOIN Documents fcd        ON fcd.id = fc.document_id
            LEFT JOIN Decks dk ON dk.node_id = n.id
            LEFT JOIN (
                SELECT dfc.document_id,
                       COUNT(*)                        as cardCount,
                       SUM(${CARD_LEARNED_SQL('dfp')}) as learnedSum
                FROM Flashcards dfc
                ${PROGRESS_JOIN('dfc', 'dfp')}
                WHERE dfc.document_id IS NOT NULL
                GROUP BY dfc.document_id
            ) dl ON dl.document_id = d.id
            LEFT JOIN folder_rollup fr ON fr.root_id = f.id
            WHERE NOT (
                nt.name = 'Deck' AND NOT EXISTS (
                    SELECT 1 FROM Connections c2
                    JOIN ConnectionTypes ct2 ON c2.type_id = ct2.id
                    WHERE c2.origin_id = n.id AND ct2.name = 'deck'
                )
            )
        `).all(account, account, account);

        const edges = await this.db.prepare(`
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

    async getDocumentByHash(hash) {
        return await this.db.prepare('SELECT id, node_id, relative_path, name FROM Documents WHERE global_hash = ?').get(hash);
    }

    async upsertDocumentLinkQueue(sourceHash, targetHash, anchorText) {
        return await this.db.prepare(
            'INSERT OR IGNORE INTO DocumentLinks (source_hash, target_hash, anchor_text) VALUES (?, ?, ?)'
        ).run(sourceHash, targetHash, anchorText ?? '');
    }

    async getPendingLinksForTarget(targetHash) {
        return await this.db.prepare('SELECT * FROM DocumentLinks WHERE target_hash = ?').all(targetHash);
    }

    async getPendingLinksFromSource(sourceHash) {
        return await this.db.prepare('SELECT * FROM DocumentLinks WHERE source_hash = ?').all(sourceHash);
    }

    async deleteDocumentLinkQueueBySource(sourceHash) {
        return await this.db.prepare('DELETE FROM DocumentLinks WHERE source_hash = ?').run(sourceHash);
    }

    async deleteDocumentLinkConnections(nodeId) {
        const { linkConnTypeId } = await this._typeIds();
        if (!linkConnTypeId) return;
        return await this.db.prepare(
            'DELETE FROM Connections WHERE origin_id = ? AND type_id = ?'
        ).run(nodeId, linkConnTypeId);
    }

    async insertDocumentLinkConnection(sourceNodeId, targetNodeId) {
        const { linkConnTypeId } = await this._typeIds();
        if (!linkConnTypeId) throw new Error('link ConnectionType missing — run migrations');
        return await this.db.prepare(
            'INSERT INTO Connections (origin_id, destiny_id, type_id) VALUES (?, ?, ?)'
        ).run(sourceNodeId, targetNodeId, linkConnTypeId);
    }

    async getDocumentLinkEdges(nodeId) {
        const { linkConnTypeId } = await this._typeIds();
        if (!linkConnTypeId) return { outgoing: [], backlinks: [] };
        const outgoing = await this.db.prepare(`
            SELECT d.name, d.relative_path AS path, d.global_hash
            FROM Connections c JOIN Documents d ON d.node_id = c.destiny_id
            WHERE c.origin_id = ? AND c.type_id = ?
        `).all(nodeId, linkConnTypeId);
        const backlinks = await this.db.prepare(`
            SELECT d.name, d.relative_path AS path, d.global_hash
            FROM Connections c JOIN Documents d ON d.node_id = c.origin_id
            WHERE c.destiny_id = ? AND c.type_id = ?
        `).all(nodeId, linkConnTypeId);
        return { outgoing, backlinks };
    }

    async insertDeck(data) {
        const { deckNodeTypeId } = await this._typeIds();
        if (!deckNodeTypeId) throw new Error('Deck node type missing — run migrations');
        const nodeInfo = await this.db.prepare('INSERT INTO Nodes (type_id) VALUES (?)').run(deckNodeTypeId);
        const nodeId = nodeInfo.lastInsertRowid;
        const info = await this.db.prepare(`
            INSERT INTO Decks (node_id, global_hash, name, description, is_system)
            VALUES (?, ?, ?, ?, ?)
        `).run(nodeId, data.globalHash, data.name, data.description ?? null, data.isSystem ?? 0);
        return info.lastInsertRowid;
    }

    async getDeckByHash(hash) {
        return await this.db.prepare('SELECT id, node_id, global_hash, name, description, is_system, created_at, updated_at FROM Decks WHERE global_hash = ?').get(hash);
    }

    async getSystemDeck() {
        return await this.db.prepare('SELECT id, node_id, global_hash, name, description, is_system, created_at, updated_at FROM Decks WHERE is_system = 1 LIMIT 1').get();
    }

    async getFlashcardNodeIdByHash(cardHash) {
        const row = await this.db.prepare('SELECT node_id FROM Flashcards WHERE global_hash = ?').get(cardHash);
        return row?.node_id ?? null;
    }

    async insertDeckConnection(deckNodeId, cardNodeId) {
        const { deckConnTypeId } = await this._typeIds();
        if (!deckConnTypeId) return;
        await this.db.prepare(
            'INSERT INTO Connections (origin_id, destiny_id, type_id) VALUES (?, ?, ?)'
        ).run(deckNodeId, cardNodeId, deckConnTypeId);
    }

    async deleteDeckConnection(deckNodeId, cardNodeId) {
        const { deckConnTypeId } = await this._typeIds();
        if (!deckConnTypeId) return;
        await this.db.prepare(
            'DELETE FROM Connections WHERE origin_id = ? AND destiny_id = ? AND type_id = ?'
        ).run(deckNodeId, cardNodeId, deckConnTypeId);
    }

    async setDeckConnectionInheritedTags(deckNodeId, cardNodeId, tagIds) {
        const { deckConnTypeId } = await this._typeIds();
        if (!deckConnTypeId) return;
        const conn = await this.getOrCreateConnection(deckNodeId, cardNodeId, deckConnTypeId);
        await this.clearInheritedTags(conn.id);
        for (const tagId of tagIds) await this.insertInheritedTag(conn.id, tagId);
    }

    async getAllDecks() {
        return await this.db.prepare(`
            SELECT d.*, COUNT(e.id) as entry_count
            FROM Decks d
            LEFT JOIN DeckEntries e ON e.deck_id = d.id
            GROUP BY d.id
            ORDER BY d.updated_at DESC
        `).all();
    }

    async getAllDeckEntryHashes() {
        return await this.db.prepare('SELECT deck_id, card_hash FROM DeckEntries').all();
    }

    async updateDeck(id, data) {
        await this.db.prepare(`
            UPDATE Decks SET name = ?, description = ?, updated_at = datetime('now')
            WHERE id = ?
        `).run(data.name, data.description ?? null, id);
    }

    async deleteDeck(id) {
        await this.db.prepare('DELETE FROM Decks WHERE id = ?').run(id);
    }

    async insertDeckEntry(data) {
        return await this.db.prepare(`
            INSERT INTO DeckEntries (deck_id, card_hash, document_path, position, inline_card)
            VALUES (?, ?, ?, ?, ?)
        `).run(data.deckId, data.cardHash, data.documentPath ?? null, data.position ?? 0, data.inlineCard ?? null);
    }

    async getDeckEntries(deckId, scope) {
        return await this.db.prepare(`
            SELECT e.*, p.level, p.last_recall, f.card_type, f.name as card_name,
                   c.frontText, c.backText, c.answerText, c.custom_html
            FROM DeckEntries e
            LEFT JOIN Flashcards f ON f.global_hash = e.card_hash
            ${PROGRESS_JOIN()}
            LEFT JOIN FlashcardContent c ON c.id = f.content_id
            WHERE e.deck_id = ?
            ORDER BY e.position ASC, e.id ASC
        `).all(scoped(scope), deckId);
    }

    async getDeckEntryByCardHash(deckId, cardHash) {
        return await this.db.prepare('SELECT id FROM DeckEntries WHERE deck_id = ? AND card_hash = ?').get(deckId, cardHash);
    }

    async deleteDeckEntry(deckId, cardHash) {
        await this.db.prepare('DELETE FROM DeckEntries WHERE deck_id = ? AND card_hash = ?').run(deckId, cardHash);
    }

    async getDeckEntryCount(deckId) {
        return (await this.db.prepare('SELECT COUNT(*) as c FROM DeckEntries WHERE deck_id = ?').get(deckId)).c;
    }

    _flashcardOriginCondition(origin, conditions) {
        if (origin === 'ai' || origin === 'import') conditions.push(`f.origin = '${origin}'`);
        else if (origin === 'human') conditions.push('f.origin IS NULL');
    }

    _flashcardFilters({ search, level, cardType, origin, flagged, flagKind, source = null, tag = null, categoryId = null, anchor = null }, scope) {
        const account = scoped(scope);
        const params = [];
        const conditions = [];

        if (source?.kind === 'standalone') {
            conditions.push('f.document_id IS NULL');
        } else if (source?.kind === 'document' && source.path) {
            conditions.push("f.document_id IN (SELECT id FROM Documents WHERE REPLACE(relative_path, '\\', '/') = ?)");
            params.push(source.path);
        } else if (source?.kind === 'folder' && source.path) {
            conditions.push("f.document_id IN (SELECT id FROM Documents WHERE REPLACE(relative_path, '\\', '/') LIKE ? ESCAPE '!')");
            params.push(`${source.path.replace(/[!%_]/g, (ch) => `!${ch}`)}/%`);
        }

        if (search) {
            const match = this._cardMatchSql(search);
            conditions.push(match.sql);
            params.push(...match.params);
        }
        if (level !== null && level !== undefined) {
            conditions.push('COALESCE(p.level, 0) = ?');
            params.push(level);
        }
        if (cardType) {
            conditions.push('f.card_type = ?');
            params.push(cardType);
        }
        this._flashcardOriginCondition(origin, conditions);
        if (anchor === 'none') conditions.push('f.highlight_hash IS NULL');
        else if (anchor === 'highlight' || anchor === 'missing') {
            conditions.push(`f.highlight_hash IS NOT NULL AND ${anchor === 'missing' ? 'NOT ' : ''}EXISTS (${LIVE_ANCHOR_SQL})`);
        }

        if (tag) {
            conditions.push(this._carriesTagSql());
            params.push(tag, tag);
        }
        if (categoryId != null) {
            conditions.push('f.category_id = ?');
            params.push(categoryId);
        }

        if (flagged || flagKind) {
            const kindClause = flagKind ? ' AND cf.kind = ?' : '';
            conditions.push(`EXISTS (SELECT 1 FROM progress.CardFlags cf
                WHERE cf.card_hash = f.global_hash AND cf.account_id = ? AND cf.dismissed_at IS NULL${kindClause})`);
            params.push(account);
            if (flagKind) params.push(flagKind);
        }

        return { where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', params };
    }

    _catalogueSelect() {
        return `
            SELECT f.global_hash, f.name, COALESCE(p.level, 0) AS level, p.last_recall, f.card_type,
                   p.fsrs_lapses as lapses, p.fsrs_difficulty as difficulty, f.origin,
                   c.frontText, c.backText, c.answerText, c.custom_html,
                   d.relative_path as document_path, d.name as document_name,
                   pc.name as category, f.highlight_hash,
                   CASE WHEN f.highlight_hash IS NULL THEN NULL
                        WHEN EXISTS (${LIVE_ANCHOR_SQL}) THEN 'live' ELSE 'missing' END AS anchor_status,
                   (SELECT GROUP_CONCAT(cf.kind) FROM progress.CardFlags cf
                     WHERE cf.card_hash = f.global_hash AND cf.account_id = ? AND cf.dismissed_at IS NULL) AS flags
            FROM Flashcards f
            ${PROGRESS_JOIN()}
            JOIN FlashcardContent c ON f.content_id = c.id
            LEFT JOIN Documents d ON f.document_id = d.id
            LEFT JOIN PedagogicalCategories pc ON f.category_id = pc.id`;
    }

    _catalogueOrder(sortBy, sortDir) {
        const sortCols = {
            level: 'p.level', name: 'f.name', last_recall: 'p.last_recall',
            lapses: 'p.fsrs_lapses', difficulty: 'p.fsrs_difficulty',
            front: "LOWER(COALESCE(c.frontText, f.name, ''))", source: "LOWER(COALESCE(d.relative_path, ''))",
            created: 'f.id',
        };
        if (sortBy === 'gap' || sortBy === 'due') return 'f.id ASC';
        const sortCol = sortCols[sortBy] ?? 'p.level';
        const dir = sortDir === 'asc' ? 'ASC' : 'DESC';
        const nullsLast = sortCol === 'p.fsrs_difficulty' ? `${sortCol} IS NULL, ` : '';
        return `${nullsLast}${sortCol} ${dir}, f.name ASC`;
    }

    async getFlashcardHashesFiltered(filters = {}, scope, { sortBy = 'created', sortDir = 'asc' } = {}) {
        const account = scoped(scope);
        const { where, params } = this._flashcardFilters(filters, account);
        return await this.db.prepare(`
            SELECT f.global_hash, f.name, p.last_recall, REPLACE(d.relative_path, '\\', '/') AS document_path
            FROM Flashcards f ${PROGRESS_JOIN()}
            JOIN FlashcardContent c ON f.content_id = c.id
            LEFT JOIN Documents d ON f.document_id = d.id
            ${where}
            ORDER BY ${this._catalogueOrder(sortBy, sortDir)}
        `).all(account, ...params);
    }

    async getFlashcardsByHashes(hashes, scope) {
        if (!hashes.length) return [];
        const account = scoped(scope);
        const rows = await this.db.prepare(`
            ${this._catalogueSelect()}
            WHERE f.global_hash IN (SELECT value FROM json_each(?))
        `).all(account, account, JSON.stringify(hashes));
        const byHash = new Map(rows.map((r) => [r.global_hash, r]));
        return hashes.map((h) => byHash.get(h)).filter(Boolean);
    }

    async getFlashcardDocumentPaths() {
        return await this.db.prepare(`
            SELECT f.global_hash, REPLACE(d.relative_path, '\\', '/') AS document_path
            FROM Flashcards f LEFT JOIN Documents d ON f.document_id = d.id
        `).all();
    }

    async getAllFlashcards({ search = null, level = null, cardType = null, origin = null, flagged = false, flagKind = null, source = null, tag = null, categoryId = null, anchor = null, sortBy = 'level', sortDir = 'desc', limit = 50, offset = 0 } = {}, scope) {
        const account = scoped(scope);
        const { where, params } = this._flashcardFilters({ search, level, cardType, origin, flagged, flagKind, source, tag, categoryId, anchor }, account);
        return await this.db.prepare(`
            ${this._catalogueSelect()}
            ${where}
            ORDER BY ${this._catalogueOrder(sortBy, sortDir)}
            LIMIT ? OFFSET ?
        `).all(account, account, ...params, limit, offset);
    }

    async getFlashcardCountFiltered({ search = null, level = null, cardType = null, origin = null, flagged = false, flagKind = null, source = null, tag = null, categoryId = null, anchor = null } = {}, scope) {
        const account = scoped(scope);
        const { where, params } = this._flashcardFilters({ search, level, cardType, origin, flagged, flagKind, source, tag, categoryId, anchor }, account);
        const contentJoin = search ? 'JOIN FlashcardContent c ON f.content_id = c.id' : '';

        return (await this.db.prepare(`
            SELECT COUNT(*) as c FROM Flashcards f ${PROGRESS_JOIN()} ${contentJoin} ${where}
        `).get(account, ...params)).c;
    }

    async updateFlashcardContentByHash(hash, { frontText, backText, answerText, name, cardType, category, customHtml }) {
        const card = await this.db.prepare('SELECT id, content_id FROM Flashcards WHERE global_hash = ?').get(hash);
        if (!card) return false;
        let categoryId = null;
        if (category) {
            const cat = await this.db.prepare("SELECT id FROM PedagogicalCategories WHERE name = ?").get(category);
            if (cat) categoryId = cat.id;
        }
        this.db.prepare('UPDATE Flashcards SET name = ?, card_type = ?, category_id = ? WHERE id = ?')
            .run(name || null, cardType || 'basic', categoryId, card.id);
        this.db.prepare('UPDATE FlashcardContent SET frontText = ?, backText = ?, answerText = ?, custom_html = ? WHERE id = ?')
            .run(frontText || null, backText || null, answerText || null, customHtml || null, card.content_id);
        return true;
    }

    async deleteFlashcardDeckEntries(cardHash) {
        return await this.db.prepare('DELETE FROM DeckEntries WHERE card_hash = ?').run(cardHash);
    }

    async getDecksContainingCard(cardHash) {
        return await this.db.prepare(`
            SELECT d.id, d.global_hash, d.name, d.is_system
            FROM DeckEntries e
            JOIN Decks d ON d.id = e.deck_id
            WHERE e.card_hash = ?
        `).all(cardHash);
    }

    async getFlashcardAnswerSamples(limit = 2000) {
        return await this.db.prepare(`
            SELECT f.card_type, c.backText, c.answerText, c.custom_html
            FROM Flashcards f
            JOIN FlashcardContent c ON f.content_id = c.id
            WHERE c.backText IS NOT NULL OR c.answerText IS NOT NULL OR c.custom_html IS NOT NULL
            LIMIT ?
        `).all(limit);
    }

    async getRecentReviewSessionRows(since, scope) {
        return await this.db.prepare(`
            SELECT rl.id, f.id AS flashcard_id, rl.timestamp, rl.outcome
            FROM progress.ReviewLogs rl
            JOIN Flashcards f ON f.global_hash = rl.card_hash
            WHERE rl.outcome IS NOT NULL AND rl.account_id = ? AND rl.timestamp >= ?
            ORDER BY rl.timestamp ASC, rl.id ASC
        `).all(scoped(scope), since);
    }

    async getCardHealth(flashcardId, scope) {
        return await this.db.prepare(
            `SELECT * FROM progress.CardHealth WHERE card_hash = (SELECT global_hash FROM Flashcards WHERE id = ?) AND account_id = ?`
        ).get(flashcardId, scoped(scope)) ?? null;
    }

    async upsertCardHealth(flashcardId, { epochAt = null, epochReason = null, contentFingerprint = null }, scope) {
        return await this.db.prepare(`
            INSERT INTO progress.CardHealth (card_hash, account_id, epoch_at, epoch_reason, content_fingerprint, updated_at)
            VALUES ((SELECT global_hash FROM Flashcards WHERE id = ?), ?, ?, ?, ?, ?)
            ON CONFLICT(account_id, card_hash) DO UPDATE SET
                epoch_at            = excluded.epoch_at,
                epoch_reason        = excluded.epoch_reason,
                content_fingerprint = excluded.content_fingerprint,
                updated_at          = excluded.updated_at
        `).run(flashcardId, scoped(scope), epochAt, epochReason, contentFingerprint, new Date().toISOString());
    }

    async setCardHealthFingerprint(flashcardId, contentFingerprint, scope) {
        return await this.db.prepare(
            `UPDATE progress.CardHealth SET content_fingerprint = ?, updated_at = ? WHERE card_hash = (SELECT global_hash FROM Flashcards WHERE id = ?) AND account_id = ?`
        ).run(contentFingerprint, new Date().toISOString(), flashcardId, scoped(scope));
    }

    async getCardFlags(flashcardId, { includeDismissed = false } = {}, scope) {
        const filter = includeDismissed ? '' : ' AND dismissed_at IS NULL';
        return await this.db.prepare(
            `SELECT * FROM progress.CardFlags WHERE card_hash = (SELECT global_hash FROM Flashcards WHERE id = ?) AND account_id = ?${filter} ORDER BY detected_at DESC`
        ).all(flashcardId, scoped(scope));
    }

    async upsertCardFlag({ flashcardId, kind, confidence, score, evidence, levelAtDetection, reviewLogId }, scope) {
        return await this.db.prepare(`
            INSERT INTO progress.CardFlags
                (card_hash, account_id, kind, confidence, score, evidence_json,
                 level_at_detection, detected_at, review_log_id, dismissed_at)
            VALUES ((SELECT global_hash FROM Flashcards WHERE id = ?), ?, ?, ?, ?, ?, ?, ?, ?, NULL)
            ON CONFLICT(account_id, card_hash, kind) DO UPDATE SET
                confidence         = excluded.confidence,
                score              = excluded.score,
                evidence_json      = excluded.evidence_json,
                level_at_detection = excluded.level_at_detection,
                detected_at        = excluded.detected_at,
                review_log_id      = excluded.review_log_id
        `).run(
            flashcardId, scoped(scope), kind, confidence, score ?? null,
            evidence ? JSON.stringify(evidence) : null,
            levelAtDetection ?? null, new Date().toISOString(), reviewLogId ?? null,
        );
    }

    async deleteCardFlags(flashcardId, { kinds = null, includeDismissed = false } = {}, scope) {
        const params = [flashcardId, scoped(scope)];
        let sql = `DELETE FROM progress.CardFlags WHERE card_hash = (SELECT global_hash FROM Flashcards WHERE id = ?) AND account_id = ?`;
        if (!includeDismissed) sql += ' AND dismissed_at IS NULL';
        if (kinds?.length) {
            sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
            params.push(...kinds);
        }
        return (await this.db.prepare(sql).run(...params)).changes;
    }

    async deleteAllCardFlags(flashcardId) {
        return (await this.db.prepare(`DELETE FROM progress.CardFlags WHERE card_hash = (SELECT global_hash FROM Flashcards WHERE id = ?)`).run(flashcardId)).changes;
    }

    async resetAllCardHealth(flashcardId, { epochAt, epochReason, contentFingerprint }) {
        const changed = (await this.db.prepare(`
            UPDATE progress.CardHealth SET epoch_at = ?, epoch_reason = ?, content_fingerprint = ?, updated_at = ?
            WHERE card_hash = (SELECT global_hash FROM Flashcards WHERE id = ?)
        `).run(epochAt, epochReason, contentFingerprint, new Date().toISOString(), flashcardId)).changes;
        if (changed === 0) {
            await this.upsertCardHealth(flashcardId, { epochAt, epochReason, contentFingerprint }, OWNER_SCOPE);
        }
        return changed;
    }

    async dismissCardFlag(flashcardId, kind, scope) {
        return (await this.db.prepare(
            `UPDATE progress.CardFlags SET dismissed_at = ? WHERE card_hash = (SELECT global_hash FROM Flashcards WHERE id = ?) AND account_id = ? AND kind = ?`
        ).run(new Date().toISOString(), flashcardId, scoped(scope), kind)).changes;
    }

    async integrityCheck() {
        return (await this.db.prepare('PRAGMA integrity_check').get()).integrity_check;
    }

    async getAllDocuments() {
        return await this.db.prepare('SELECT id, folder_id, node_id, global_hash, relative_path, absolute_path, name, encoding FROM Documents').all();
    }

    async getAllFolders() {
        return await this.db.prepare('SELECT id, parent_id, node_id, global_hash, relative_path, absolute_path, name FROM Folders').all();
    }

    async getAllMedia() {
        return await this.db.prepare('SELECT id, hash, name, relative_path, absolute_path FROM Media').all();
    }

    async getStandaloneCardCount() {
        return (await this.db.prepare('SELECT COUNT(*) as c FROM Flashcards WHERE document_id IS NULL').get()).c;
    }

    async getPendingLinkCount() {
        return (await this.db.prepare('SELECT COUNT(*) as c FROM DocumentLinks').get()).c;
    }

    async updateDeckEntryInlineCard(deckId, cardHash, inlineCard) {
        this.db.prepare('UPDATE DeckEntries SET inline_card = ? WHERE deck_id = ? AND card_hash = ?')
            .run(inlineCard, deckId, cardHash);
    }

    async hasProgressForHash(cardHash, scope) {
        const row = await this.db.prepare(
            'SELECT 1 AS present FROM progress.CardProgress WHERE card_hash = ? AND account_id = ?',
        ).get(cardHash, scoped(scope));
        return !!row;
    }

    async seedEaseFromSidecar(cardHash, easeFactor, level) {
        await this.db.prepare(`
            INSERT INTO progress.ReviewLogs (card_hash, account_id, timestamp, outcome, ease_factor, level)
            SELECT ?, 'owner', datetime('now'), NULL, ?, ?
            WHERE NOT EXISTS (
                SELECT 1 FROM progress.ReviewLogs WHERE card_hash = ? AND account_id = 'owner'
            )
        `).run(cardHash, easeFactor, level ?? 0, cardHash);
    }

    async purgeCardBehaviour(cardHash) {
        for (const table of ['CardProgress', 'CardHealth', 'CardFlags', 'ReviewLogs']) {
            await this.db.prepare(`DELETE FROM progress.${table} WHERE card_hash = ?`).run(cardHash);
        }
    }

    async saveReadProgress(scope, docHash, state = {}) {
        await this.db.prepare(`
            INSERT INTO progress.ReadProgress
                (account_id, doc_hash, ${READ_FIELDS.join(', ')}, updated_at)
            VALUES (?, ?, ${READ_FIELDS.map(() => '?').join(', ')}, ?)
            ON CONFLICT(account_id, doc_hash) DO UPDATE SET
                ${READ_FIELDS.map(f => `${f} = excluded.${f}`).join(', ')},
                updated_at = excluded.updated_at
        `).run(
            scoped(scope), docHash,
            ...READ_FIELDS.map(f => state[f] ?? null),
            new Date().toISOString(),
        );
    }

    async getReadProgress(scope, docHash) {
        return await this.db.prepare(
            'SELECT * FROM progress.ReadProgress WHERE account_id = ? AND doc_hash = ?',
        ).get(scoped(scope), docHash) ?? null;
    }

    async listReadProgress(scope) {
        return await this.db.prepare(`
            SELECT * FROM progress.ReadProgress
            WHERE account_id = ?
            ORDER BY updated_at DESC
        `).all(scoped(scope));
    }

    async deleteReadProgress(scope, docHash) {
        await this.db.prepare(
            'DELETE FROM progress.ReadProgress WHERE account_id = ? AND doc_hash = ?',
        ).run(scoped(scope), docHash);
    }

    async wipeDerivedContent() {
        await this.db.transaction(async () => {
            await this.db.prepare('DELETE FROM DeckEntries').run();
            await this.db.prepare('DELETE FROM InheritedTags').run();
            await this.db.prepare('DELETE FROM DocumentLinks').run();
            await this.db.prepare('DELETE FROM Highlights').run();
            await this.db.prepare('DELETE FROM Flashcards').run();
            await this.db.prepare('DELETE FROM Documents').run();
            await this.db.prepare('DELETE FROM Folders').run();
            await this.db.prepare('DELETE FROM Decks').run();
            await this.db.prepare('DELETE FROM Tags').run();
            await this.db.prepare('DELETE FROM Media').run();
            await this.db.prepare('DELETE FROM Connections').run();
            await this.db.prepare('DELETE FROM Nodes').run();
        })();
    }

    async backfillTypeAnswerAnswerText() {
        return (await this.db.prepare(`
            UPDATE FlashcardContent
               SET answerText = backText,
                   backText   = NULL
             WHERE answerText IS NULL
               AND id IN (SELECT content_id FROM Flashcards WHERE card_type = 'type_answer')
        `).run()).changes;
    }

    async getCanonicalVersions() {
        return new Set((await this.db.prepare('SELECT version FROM CanonicalVersion').all()).map(r => r.version));
    }

    async getSchemaVersion() {
        const row = await this.db.prepare('SELECT MAX(version) AS version FROM SchemaVersion').get();
        return row?.version ?? 0;
    }

    async recordCanonicalVersion(version, description = null) {
        await this.db.prepare(
            'INSERT OR REPLACE INTO CanonicalVersion (version, description) VALUES (?, ?)'
        ).run(version, description);
    }

    async getHighlightsByDocumentId(documentId) {
        return await this.db.prepare(
            'SELECT * FROM Highlights WHERE document_id = ? ORDER BY start ASC'
        ).all(documentId);
    }

    async getHighlightByHash(hash) {
        return await this.db.prepare('SELECT * FROM Highlights WHERE global_hash = ?').get(hash);
    }

    async insertHighlight(data) {
        return await this.db.prepare(`
            INSERT INTO Highlights (document_id, global_hash, type, start, end, page, bbox, color, note, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            data.documentId, data.globalHash, data.type ?? 'text_offset',
            data.start ?? null, data.end ?? null, data.page ?? null,
            data.bbox ?? null, data.color ?? 'amber', data.note ?? '',
            data.createdAt ?? new Date().toISOString()
        );
    }

    async updateHighlight(hash, data) {
        return await this.db.prepare(
            'UPDATE Highlights SET color = ?, note = ? WHERE global_hash = ?'
        ).run(data.color, data.note ?? '', hash);
    }

    async deleteHighlight(hash) {
        return await this.db.prepare('DELETE FROM Highlights WHERE global_hash = ?').run(hash);
    }

    async getCardsMissingHighlightHash() {
        return await this.db.prepare(`
            SELECT f.id, f.global_hash, d.relative_path
            FROM Flashcards f
            JOIN FlashcardReference r ON r.id = f.reference_id
            JOIN Documents d ON d.id = f.document_id
            WHERE r.type = 'highlight' AND f.highlight_hash IS NULL
        `).all();
    }

    async setFlashcardHighlightHash(id, highlightHash) {
        return await this.db.prepare('UPDATE Flashcards SET highlight_hash = ? WHERE id = ?').run(highlightHash, id);
    }

    async getHighlightedDocumentPaths() {
        return (await this.db.prepare(`
            SELECT DISTINCT d.relative_path
            FROM Highlights h
            JOIN Documents d ON h.document_id = d.id
            ORDER BY d.relative_path ASC
        `).all()).map(r => r.relative_path);
    }

    async syncDocumentHighlights(documentId, highlightsData) {
        const existing = await this.getHighlightsByDocumentId(documentId);
        const existingMap = new Map(existing.map(h => [h.global_hash, h]));
        const incoming = new Set();

        for (const h of highlightsData) {
            incoming.add(h.id);
            if (!existingMap.has(h.id)) {
                await this.insertHighlight({
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
            if (!incoming.has(hash)) await this.deleteHighlight(hash);
        }
    }

    async getCategories() {
        return await this.db.prepare(`
            SELECT pc.id, pc.name, pc.priority, pc.description,
                   (SELECT COUNT(*) FROM Flashcards f WHERE f.category_id = pc.id) AS cards
            FROM PedagogicalCategories pc ORDER BY pc.priority ASC, pc.name ASC
        `).all();
    }

    async getCategoryByName(name) {
        return await this.db.prepare('SELECT id, name, priority, description FROM PedagogicalCategories WHERE name = ?').get(name);
    }

    async getCategoryUsageCount(id) {
        return (await this.db.prepare(
            'SELECT COUNT(*) as c FROM Flashcards WHERE category_id = ?'
        ).get(id)).c;
    }

    async insertCategory({ name, priority = 0, description = '' }) {
        return (await this.db.prepare(
            'INSERT INTO PedagogicalCategories (name, priority, description) VALUES (?, ?, ?)'
        ).run(name, priority, description)).lastInsertRowid;
    }

    async updateCategory(id, data) {
        const fields = [];
        const params = [];
        if (data.name !== undefined)        { fields.push('name = ?');        params.push(data.name); }
        if (data.priority !== undefined)    { fields.push('priority = ?');    params.push(data.priority); }
        if (data.description !== undefined) { fields.push('description = ?'); params.push(data.description); }
        if (!fields.length) return;
        params.push(id);
        await this.db.prepare(`UPDATE PedagogicalCategories SET ${fields.join(', ')} WHERE id = ?`).run(...params);
    }

    async deleteCategory(id) {
        await this.db.prepare('DELETE FROM PedagogicalCategories WHERE id = ?').run(id);
    }
}

export default new VaultQuery();
