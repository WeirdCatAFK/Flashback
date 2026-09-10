/**
 * Query.js
 * Data Access Layer for Flashback.
 * Handles all direct SQLite interactions.
 */

import db from '../primitives/database.js';
import { OWNER_SCOPE } from '../../requestContext.js';

/** Returns `scope` unchanged, refusing a missing one rather than defaulting to the owner. */
function scoped(scope) {
    if (typeof scope !== 'string' || scope.length === 0) {
        throw new Error(
            'query: this call needs an account scope (an account id, or OWNER_SCOPE). '
            + 'Resolve it once at the orchestrator boundary with requestContext.currentScope().'
        );
    }
    return scope;
}

/** The camelCase names a caller (sidecar data, a scheduler result) uses for schedule state. */
const PROGRESS_KEYS = [
    'level', 'sm2Reps', 'lastRecall', 'fsrsStability', 'fsrsDifficulty',
    'fsrsDue', 'fsrsState', 'fsrsReps', 'fsrsLapses',
];

/**
 * Joins a Flashcards row to one person's CardProgress row.
 *
 * The `?` binds the scope at the position where the join appears in the statement, so
 * callers must push the scope onto their parameter list at that same point.
 */
const PROGRESS_JOIN = (cardAlias = 'f', progressAlias = 'p') =>
    `LEFT JOIN CardProgress ${progressAlias} ON ${progressAlias}.flashcard_id = ${cardAlias}.id AND ${progressAlias}.account_id = ?`;

/**
 * Per-card "how well learned is this" score in 0..1, over a CardProgress row aliased as `t`.
 *
 * `t` may be an outer-joined alias, in which case every arm reads NULL and the COALESCE
 * returns 0. FSRS stability wins when present; Leitner/SM-2 cards have none and fall back
 * to `level`, where 6 maps to 1.0 (MASTERY_LEVEL, orchestration/srs.js). The stability arm
 * is a ladder of log-spaced bins rather than a log(): SQLite's math functions are a
 * compile-time option we cannot rely on.
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

/** A comma-separated run of `?` placeholders, one per element. */
class DocumentQuery {
    constructor() {
        this.db = db;
        this._typeCache = null;
    }

    /** Drops the type-id cache on a vault switch. */
    onVaultOpened() {
        this._typeCache = null;
    }

    /** Caches the NodeTypes/ConnectionTypes ids this vault seeded. */
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

    /**
     * Creates a new graph node.
     *
     * @param {string} typeName - e.g., 'Folder', 'Document', 'Flashcard', 'Tag'
     * @returns {number} The node ID.
     */
    async createNode(typeName) {
        const type = await this.db.prepare('SELECT id FROM NodeTypes WHERE name = ?').get(typeName);
        if (!type) throw new Error(`${typeName} node type missing.`);
        const info = await this.db.prepare('INSERT INTO Nodes (type_id) VALUES (?)').run(type.id);
        return info.lastInsertRowid;
    }

    /** One folder by globalHash. */
    async getFolderByHash(hash) {
        return await this.db.prepare('SELECT * FROM Folders WHERE global_hash = ?').get(hash);
    }

    /** One folder by workspace-relative path. */
    async getFolderByPath(relPath) {
        return await this.db.prepare('SELECT * FROM Folders WHERE relative_path = ?').get(relPath);
    }

    /** Creates a Folders row and its graph node. */
    async insertFolder(data) {
        const stmt = this.db.prepare(`
            INSERT INTO Folders (node_id, global_hash, parent_id, relative_path, absolute_path, name, presence)
            VALUES (?, ?, ?, ?, ?, ?, 0)
        `);
        return await stmt.run(data.nodeId, data.globalHash, data.parentId ?? null, data.relativePath, data.absolutePath, data.name);
    }

    /** One folder by absolute path. */
    async getFolderByAbsolutePath(absPath) {
        return await this.db.prepare('SELECT * FROM Folders WHERE absolute_path = ?').get(absPath);
    }

    /** The folder owning a graph node. */
    async getFolderByNodeId(nodeId) {
        return await this.db.prepare('SELECT * FROM Folders WHERE node_id = ?').get(nodeId);
    }

    /** A folder's parent id, or null at the workspace root. */
    async getFolderParentId(folderId) {
        return await this.db.prepare('SELECT parent_id FROM Folders WHERE id = ?').get(folderId);
    }

    /** Documents directly inside a folder. */
    async getChildDocuments(folderId) {
        return await this.db.prepare('SELECT id, node_id, relative_path FROM Documents WHERE folder_id = ?').all(folderId);
    }

    /** Folders directly inside a folder. */
    async getChildFolders(parentId) {
        return await this.db.prepare('SELECT id, node_id, relative_path, absolute_path FROM Folders WHERE parent_id = ?').all(parentId);
    }

    /** Updates a folder's name, tags and stored metadata. */
    async updateFolderMetadata(id, data) {
        if (data.globalHash) {
            await this.db.prepare('UPDATE Folders SET global_hash = ? WHERE id = ?').run(data.globalHash, id);
        }
    }

    /** One document by workspace-relative path. */
    async getDocumentByPath(relPath) {
        return await this.db.prepare('SELECT * FROM Documents WHERE relative_path = ?').get(relPath);
    }

    /** Creates a Documents row and its graph node. */
    async insertDocument(data) {
        const stmt = this.db.prepare(`
            INSERT INTO Documents (folder_id, node_id, global_hash, relative_path, absolute_path, name, encoding, presence)
            VALUES (?, ?, ?, ?, ?, ?, ?, 0)
        `);
        const info = await stmt.run(data.folderId, data.nodeId, data.globalHash, data.relativePath, data.absolutePath, data.name, data.encoding ?? null);
        return info;
    }

    /** Updates a document's name and stored metadata. */
    async updateDocumentMetadata(id, data) {
        if (data.globalHash) {
            await this.db.prepare('UPDATE Documents SET global_hash = ? WHERE id = ?').run(data.globalHash, id);
        }
    }

    /** Deletes a document row, cascading its cards and highlights. */
    async deleteDocument(id) {
        await this.db.prepare('DELETE FROM Documents WHERE id = ?').run(id);
    }

    /** A document's cards with this person's schedule joined on. */
    async getFlashcardsByDocument(documentId, scope) {
        return await this.db.prepare(`
            SELECT f.id, f.node_id, f.global_hash, f.content_id, f.card_type,
                   p.level, p.sm2_reps, p.last_recall,
                   p.fsrs_stability, p.fsrs_difficulty, p.fsrs_due,
                   p.fsrs_state, p.fsrs_reps, p.fsrs_lapses
            FROM Flashcards f
            ${PROGRESS_JOIN()}
            WHERE f.document_id = ?
        `).all(scoped(scope), documentId);
    }

    /** How many cards the documents directly in a folder hold. */
    async getFlashcardCountsByFolder(folderId) {
        return await this.db.prepare(`
            SELECT d.name, COUNT(fc.id) AS count
            FROM Documents d
            LEFT JOIN Flashcards fc ON fc.document_id = d.id
            WHERE d.folder_id = ?
            GROUP BY d.id
        `).all(folderId);
    }

    /** How many cards a folder holds, recursively. */
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

    /** Folder rows for a batch of relative paths. */
    async getFoldersByPaths(relPaths) {
        if (relPaths.length === 0) return [];
        const placeholders = relPaths.map(() => '?').join(', ');
        return await this.db.prepare(`SELECT * FROM Folders WHERE relative_path IN (${placeholders})`).all(...relPaths);
    }

    /** Recursive card counts for a batch of folders, in one statement. */
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

    /** Creates a card, its content row and its graph node. */
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
                name, fileIndex, presence, card_type, origin)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
        `);
        const info = await stmt.run(
            data.globalHash, data.nodeId, data.documentId, categoryId,
            contentInfo.lastInsertRowid, referenceId,
            data.name || null, data.fileIndex || 0, data.cardType || 'basic', data.origin || null
        );

        await this._writeProgress(info.lastInsertRowid, scope, data);
        return info;
    }

    /** Updates a card's content and metadata. */
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

    /** Deletes a card and its content, references and node. */
    async deleteFlashcard(id) {
        await this.db.prepare('DELETE FROM Flashcards WHERE id = ?').run(id);
    }

    /** One card by globalHash, without content. */
    async getFlashcardByHash(hash) {
        return await this.db.prepare('SELECT id, document_id FROM Flashcards WHERE global_hash = ?').get(hash);
    }

    /** One card with its content and this person's schedule. */
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

    /** Creates or replaces one person's schedule for one card. */
    async _upsertProgress(flashcardId, scope, state) {
        await this.db.prepare(`
            INSERT INTO CardProgress
                (flashcard_id, account_id, level, sm2_reps, last_recall,
                 fsrs_stability, fsrs_difficulty, fsrs_due, fsrs_state, fsrs_reps, fsrs_lapses)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(flashcard_id, account_id) DO UPDATE SET
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

    /** One person's raw progress row for one card, or null. */
    async getCardProgress(flashcardId, scope) {
        return await this.db.prepare(
            'SELECT * FROM CardProgress WHERE flashcard_id = ? AND account_id = ?'
        ).get(flashcardId, scoped(scope)) ?? null;
    }

    /** Forgets one person's schedule for one card — an undo back past the first review. */
    async deleteCardProgress(flashcardId, scope) {
        await this.db.prepare(
            'DELETE FROM CardProgress WHERE flashcard_id = ? AND account_id = ?'
        ).run(flashcardId, scoped(scope));
    }

    /** Applies whatever schedule a caller's camelCase payload carries — sidecar data on import, a merge result on sync. */
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

    /** Writes this person's Leitner level and SM-2 rep count for a card. */
    async setFlashcardSrsState(id, level, sm2Reps, scope) {
        const current = await this.getCardProgress(id, scope);
        await this._upsertProgress(id, scope, { ...current, level, sm2_reps: sm2Reps });
    }

    /** Every card's schedule for this person, for an algorithm migration. */
    async getAllFlashcardSrsState(scope) {
        return await this.db.prepare(`
            SELECT f.global_hash, p.level, p.sm2_reps, p.last_recall,
                   p.fsrs_stability, p.fsrs_due, p.fsrs_state
            FROM Flashcards f
            ${PROGRESS_JOIN()}
        `).all(scoped(scope));
    }

    /** Writes FSRS state for many cards in one statement. */
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

    /** Each card's most recent SM-2 ease factor, which lives in its latest review log. */
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

    /** The shape shared by every batch writer that sets SOME columns of a progress row, by card hash, leaving the rest of that person's state alone. */
    _batchProgressStmt(assignments, selectColumns) {
        return this.db.prepare(`
            INSERT INTO CardProgress
                (flashcard_id, account_id, level, sm2_reps, last_recall,
                 fsrs_stability, fsrs_difficulty, fsrs_due, fsrs_state, fsrs_reps, fsrs_lapses)
            SELECT f.id, ?, ${selectColumns}
            FROM Flashcards f
            LEFT JOIN CardProgress p ON p.flashcard_id = f.id AND p.account_id = ?
            WHERE f.global_hash = ?
            ON CONFLICT(flashcard_id, account_id) DO UPDATE SET ${assignments}
        `);
    }

    /** Writes SM-2 rep counts for many cards in one statement. */
    async batchSetSm2Reps(cards, scope) {
        const account = scoped(scope);
        const stmt = this._batchProgressStmt('sm2_reps = excluded.sm2_reps',
            `p.level, ?, p.last_recall, p.fsrs_stability, p.fsrs_difficulty, p.fsrs_due,
             COALESCE(p.fsrs_state, 0), COALESCE(p.fsrs_reps, 0), COALESCE(p.fsrs_lapses, 0)`);
        await this.db.transaction(async (rows) => {
            for (const c of rows) await stmt.run(account, c.sm2_reps, account, c.global_hash);
        })(cards);
    }

    /** Writes Leitner levels for many cards in one statement. */
    async batchSetLeitnerLevel(cards, scope) {
        const account = scoped(scope);
        const stmt = this._batchProgressStmt('level = excluded.level',
            `?, COALESCE(p.sm2_reps, 0), p.last_recall, p.fsrs_stability, p.fsrs_difficulty, p.fsrs_due,
             COALESCE(p.fsrs_state, 0), COALESCE(p.fsrs_reps, 0), COALESCE(p.fsrs_lapses, 0)`);
        await this.db.transaction(async (rows) => {
            for (const c of rows) await stmt.run(account, c.level, account, c.global_hash);
        })(cards);
    }

    /** Restores a batch of schedules, used by Seal rollback. */
    async batchRestoreFlashcardSrsState(states, scope) {
        const account = scoped(scope);
        const stmt = this._batchProgressStmt(
            'level = excluded.level, sm2_reps = excluded.sm2_reps, last_recall = excluded.last_recall',
            `?, ?, ?, p.fsrs_stability, p.fsrs_difficulty, p.fsrs_due,
             COALESCE(p.fsrs_state, 0), COALESCE(p.fsrs_reps, 0), COALESCE(p.fsrs_lapses, 0)`);
        await this.db.transaction(async (rows) => {
            for (const s of rows) {
                await stmt.run(account, s.level ?? 0, s.sm2_reps ?? 0, s.last_recall, account, s.global_hash);
            }
        })(states);
    }

    /** Records a graded review against this person's schedule. */
    async updateFlashcardReview(id, timestamp, newValue, algorithm = 'leitner', scope) {
        const current = await this.getCardProgress(id, scope) ?? {};
        const next = { ...current, last_recall: timestamp };
        if (algorithm === 'sm2') next.sm2_reps = newValue;
        else next.level = newValue;
        await this._upsertProgress(id, scope, next);
    }

    /** Appends one row to the review ledger. */
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

    /**
     * Everything the sequencer needs to judge how related two cards are, for a whole
     * session in a fixed number of statements.
     *
     * @param {string[]} hashes
     * @returns {Promise<Map<string, {docId, folderId, ancestorIds, tags: Set, deckIds: Set, linkedDocIds: Set}>>}
     *   A standalone card has `docId`/`folderId` null and still carries its tags and decks.
     */
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

    /** The order cards were actually presented in one session. */
    async getSessionReviewOrder(sessionId, scope) {
        return await this.db.prepare(`
            SELECT rl.session_position AS position, rl.card_hash AS globalHash
            FROM progress.ReviewLogs rl
            WHERE rl.session_id = ? AND rl.account_id = ?
            ORDER BY rl.session_position ASC, rl.id ASC
        `).all(sessionId, scoped(scope));
    }

    /** Which scheduler this person last reviewed with. */
    async getLatestReviewAlgorithm(scope) {
        return await this.db.prepare(`
            SELECT algorithm, rating
            FROM progress.ReviewLogs
            WHERE outcome IS NOT NULL AND account_id = ?
            ORDER BY timestamp DESC, id DESC
            LIMIT 1
        `).get(scoped(scope)) ?? null;
    }

    /** This person's FSRS latent state for a card. */
    async getFlashcardFsrsState(id, scope) {
        return await this.db.prepare(`
            SELECT fsrs_stability AS stability, fsrs_difficulty AS difficulty,
                   fsrs_due AS due, fsrs_state AS state,
                   fsrs_reps AS reps, fsrs_lapses AS lapses, last_recall AS last_review
            FROM CardProgress WHERE flashcard_id = ? AND account_id = ?
        `).get(id, scoped(scope)) ?? null;
    }

    /** Writes this person's FSRS state for a card. */
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

    /** This person's fitted FSRS weight vector. */
    async getFsrsWeights(scope) {
        const row = await this.db.prepare(
            'SELECT weights_json, review_count, optimized_at FROM FsrsParameters WHERE account_id = ?'
        ).get(scoped(scope));
        if (!row) return null;
        return {
            weights: JSON.parse(row.weights_json),
            reviewCount: row.review_count,
            optimizedAt: row.optimized_at,
        };
    }

    /** Stores a newly fitted weight vector and what it was fitted from. */
    async setFsrsWeights(weightsJson, reviewCount, scope) {
        await this.db.prepare(`
            INSERT INTO FsrsParameters (account_id, weights_json, optimized_at, review_count)
            VALUES (?, ?, datetime('now'), ?)
            ON CONFLICT(account_id) DO UPDATE SET
                weights_json = excluded.weights_json,
                optimized_at = excluded.optimized_at,
                review_count = excluded.review_count
        `).run(scoped(scope), weightsJson, reviewCount);
    }

    /** Every card's review history for this person, as optimizer input. */
    async getAllReviewHistories(scope) {
        return await this.db.prepare(`
            SELECT f.id AS flashcard_id, rl.timestamp, rl.rating
            FROM progress.ReviewLogs rl
            JOIN Flashcards f ON f.global_hash = rl.card_hash
            WHERE rl.rating IS NOT NULL AND rl.account_id = ?
            ORDER BY f.id ASC, rl.id ASC
        `).all(scoped(scope));
    }

    /** Drops this person's most recent review of a card, for undo. */
    async deleteLatestReviewLog(flashcardId, scope) {
        const row = await this.db.prepare(
            'SELECT id FROM progress.ReviewLogs WHERE card_hash = (SELECT global_hash FROM Flashcards WHERE id = ?) AND account_id = ? ORDER BY id DESC LIMIT 1'
        ).get(flashcardId, scoped(scope));
        if (!row) return false;
        await this.db.prepare('DELETE FROM progress.ReviewLogs WHERE id = ?').run(row.id);
        return true;
    }

    /** This person's reviews of one card, oldest first. */
    async getFlashcardReviewHistory(flashcardId, scope) {
        return await this.db.prepare(`
            SELECT id, timestamp, outcome, ease_factor, level, algorithm, rating,
                   fsrs_stability, fsrs_difficulty, fsrs_due, fsrs_state
            FROM progress.ReviewLogs
            WHERE card_hash = (SELECT global_hash FROM Flashcards WHERE id = ?) AND account_id = ?
            ORDER BY id ASC
        `).all(flashcardId, scoped(scope));
    }

    /** This person's schedule for a card, by globalHash. */
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

    /** This person's most recent review of a card. */
    async getLatestReviewLog(flashcardId, scope) {
        return await this.db.prepare(`
            SELECT timestamp, outcome, ease_factor, level,
                   rating, fsrs_stability, fsrs_difficulty, fsrs_due, fsrs_state
            FROM progress.ReviewLogs WHERE card_hash = (SELECT global_hash FROM Flashcards WHERE id = ?) AND account_id = ? ORDER BY id DESC LIMIT 1
        `).get(flashcardId, scoped(scope)) ?? null;
    }

    /** Restores a card's schedule to its pre-review values. */
    async undoFlashcardReview(id, value, lastRecall, algorithm = 'leitner', scope) {
        const current = await this.getCardProgress(id, scope) ?? {};
        const next = { ...current, last_recall: lastRecall };
        if (algorithm === 'sm2') next.sm2_reps = value;
        else next.level = value;
        await this._upsertProgress(id, scope, next);
    }

    /** This person's card count per Leitner box. */
    async getLeitnerBoxes(scope) {
        return await this.db.prepare(`
            SELECT COALESCE(p.level, 0) AS level, COUNT(*) AS count
            FROM Flashcards f
            ${PROGRESS_JOIN()}
            GROUP BY COALESCE(p.level, 0)
            ORDER BY level ASC
        `).all(scoped(scope));
    }

    /** How many cards the vault holds. */
    async getFlashcardCount() {
        return (await this.db.prepare('SELECT COUNT(*) as c FROM Flashcards').get()).c;
    }

    /** How much of the whole vault this person has actually learned, as a card-weighted sum. */
    async getVaultLearned(scope) {
        const row = await this.db.prepare(`
            SELECT COUNT(*) AS cards,
                   COALESCE(SUM(${CARD_LEARNED_SQL('p')}), 0) AS learnedSum
            FROM Flashcards f
            ${PROGRESS_JOIN()}
        `).get(scoped(scope));
        return { cards: row?.cards ?? 0, learnedSum: row?.learnedSum ?? 0 };
    }

    /** How many cards this person has at or above the mastery threshold. */
    async getMasteredFlashcardCount(threshold, scope) {
        return (await this.db.prepare(
            'SELECT COUNT(*) as c FROM CardProgress WHERE account_id = ? AND level >= ?'
        ).get(scoped(scope), threshold)).c;
    }

    /** This person's reviews per day since a date. */
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

    /** This person's review count and pass rate since a date. */
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

    /** A CTE numbering one person's reviews per card, newest first. */
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

    /** Review totals split into learning and mature phases. */
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

    /** How many cards this person saw for the first time since a date. */
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

    /** How many attempts each card took before its first success. */
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

    /** This person's review count and pass rate for one day. */
    async getDayReviewTotals(dayIso, scope) {
        return await this.db.prepare(`
            SELECT COUNT(*) AS reviews,
                   COUNT(DISTINCT card_hash) AS uniqueCards,
                   SUM(CASE WHEN outcome = 0 THEN 1 ELSE 0 END) AS failed
            FROM progress.ReviewLogs
            WHERE outcome IS NOT NULL AND account_id = ? AND date(timestamp, 'localtime') = ?
        `).get(scoped(scope), dayIso);
    }

    /** One day's review totals split into learning and mature phases. */
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

    /** Cards this person met for the first time on one day. */
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

    /** One day's reviews grouped by deck. */
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

    /** One day's reviews grouped by document. */
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

    /** The cards this person failed most on one day. */
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

    /** Every day this person has reviewed on. */
    async getReviewActivityDays(scope) {
        return (await this.db.prepare(`
            SELECT date(timestamp, 'localtime') AS day
            FROM progress.ReviewLogs
            WHERE outcome IS NOT NULL AND account_id = ?
            GROUP BY day
            ORDER BY day ASC
        `).all(scoped(scope))).map(r => r.day);
    }

    /** Cards due now for this person, with every include and exclude filter applied in SQL. */
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

    /** Every tag in the vault. */
    async getAllTags() {
        return (await this.db.prepare('SELECT DISTINCT name FROM Tags ORDER BY name ASC').all()).map(r => r.name);
    }

    /** Every tag with how many documents and cards carry it. */
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

    /** One tag by name. */
    async getTagByName(name) {
        return await this.db.prepare('SELECT * FROM Tags WHERE name = ?').get(name);
    }

    /** Creates a tag and its graph node. */
    async insertTag(name, nodeId) {
        return await this.db.prepare('INSERT INTO Tags (name, node_id, presence) VALUES (?, ?, 0)').run(name, nodeId);
    }

    /** Replaces a node's direct tags with exactly this set. */
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

    /** Deletes a tag once nothing references it. */
    async deleteTagIfOrphaned(tagNodeId) {
        const { tagConnTypeId } = await this._typeIds();
        const remaining = await this.db.prepare(
            "SELECT 1 FROM Connections WHERE destiny_id = ? AND type_id = ? LIMIT 1"
        ).get(tagNodeId, tagConnTypeId);
        if (!remaining) {
            await this.db.prepare("DELETE FROM Tags WHERE node_id = ?").run(tagNodeId);
        }
    }

    /** Registers an asset by SHA-256 hash. */
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

    /** One Media row by content hash. */
    async getMediaByHash(hash) {
        return await this.db.prepare('SELECT * FROM Media WHERE hash = ?').get(hash);
    }

    /** Drops the Media row for an asset at this path. */
    async deleteMediaByAbsPath(absolutePath) {
        return await this.db.prepare('DELETE FROM Media WHERE absolute_path = ?').run(absolutePath);
    }

    /** Every asset stored under a path prefix. */
    async getMediaByAbsPathPrefix(prefix) {
        return await this.db.prepare('SELECT * FROM Media WHERE absolute_path LIKE ?').all(prefix + '%');
    }

    /** Re-points one asset's stored paths. */
    async updateMediaPath(oldAbsPath, newRelPath, newAbsPath) {
        return this.db.prepare('UPDATE Media SET relative_path = ?, absolute_path = ? WHERE absolute_path = ?')
            .run(newRelPath, newAbsPath, oldAbsPath);
    }

    /** Re-points every asset under a path that moved. */
    async cascadeMediaPaths(oldRelPath, newRelPath, oldAbsPath, newAbsPath) {
        this.db.prepare(`UPDATE Media SET relative_path = ? || substr(relative_path, length(?) + 1), absolute_path = ? || substr(absolute_path, length(?) + 1) WHERE absolute_path LIKE ? || '%' ESCAPE '\\'`)
            .run(newRelPath, oldRelPath, newAbsPath, oldAbsPath, this._escapeLike(oldAbsPath));
    }

    /** One magazine or course subscription. */
    async getSubscription(magazineId) {
        return await this.db.prepare('SELECT * FROM Subscriptions WHERE magazine_id = ?').get(magazineId);
    }

    /** Every tracked subscription, so a folder can be recognised as one issue's target. */
    async listSubscriptions() {
        return await this.db.prepare('SELECT * FROM Subscriptions').all();
    }

    /** Creates or updates a subscription. */
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

    /** Renames a folder row in place. */
    async renameFolderRecord(newName, newRelPath, newAbsPath, oldAbsPath) {
        this.db.prepare('UPDATE Folders SET name = ?, relative_path = ?, absolute_path = ? WHERE absolute_path = ?')
            .run(newName, newRelPath, newAbsPath, oldAbsPath);
    }

    /** Renames a document row in place. */
    async renameDocumentRecord(newName, newRelPath, newAbsPath, oldAbsPath) {
        this.db.prepare('UPDATE Documents SET name = ?, relative_path = ?, absolute_path = ? WHERE absolute_path = ?')
            .run(newName, newRelPath, newAbsPath, oldAbsPath);
    }

    /** Escapes LIKE wildcards in user-supplied search text. */
    _escapeLike(str) {
        return str.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    }

    /** Re-points every document row under a renamed path. */
    async cascadeRenameDocumentPaths(oldRelPath, newRelPath, oldAbsPath, newAbsPath) {
        this.db.prepare(`UPDATE Documents SET relative_path = ? || substr(relative_path, length(?) + 1), absolute_path = ? || substr(absolute_path, length(?) + 1) WHERE absolute_path LIKE ? || '%' ESCAPE '\\'`)
            .run(newRelPath, oldRelPath, newAbsPath, oldAbsPath, this._escapeLike(oldAbsPath));
    }

    /** Re-points every folder row under a renamed path. */
    async cascadeRenameFolderPaths(oldRelPath, newRelPath, oldAbsPath, newAbsPath) {
        this.db.prepare(`UPDATE Folders SET relative_path = ? || substr(relative_path, length(?) + 1), absolute_path = ? || substr(absolute_path, length(?) + 1) WHERE absolute_path LIKE ? || '%' ESCAPE '\\'`)
            .run(newRelPath, oldRelPath, newAbsPath, oldAbsPath, this._escapeLike(oldAbsPath));
    }

    /** Re-parents a document row and re-points its paths. */
    async moveDocumentRecord(newFolderId, newRelPath, newAbsPath, oldAbsPath) {
        this.db.prepare('UPDATE Documents SET folder_id = ?, relative_path = ?, absolute_path = ? WHERE absolute_path = ?')
            .run(newFolderId, newRelPath, newAbsPath, oldAbsPath);
    }

    /** Re-parents a folder row and re-points its paths. */
    async moveFolderRecord(newRelPath, newAbsPath, oldAbsPath, newParentId) {
        this.db.prepare('UPDATE Folders SET relative_path = ?, absolute_path = ?, parent_id = ? WHERE absolute_path = ?')
            .run(newRelPath, newAbsPath, newParentId ?? null, oldAbsPath);
    }

    /** Deletes a folder row and everything beneath it. */
    async deleteFolderTree(absPath, sep) {
        this.db.prepare(`DELETE FROM Folders WHERE absolute_path = ? OR absolute_path LIKE ? ESCAPE '\\'`)
            .run(absPath, this._escapeLike(absPath) + sep + '%');
    }

    /** Deletes the document row at an absolute path. */
    async deleteDocumentByAbsPath(absPath) {
        await this.db.prepare('DELETE FROM Documents WHERE absolute_path = ?').run(absPath);
    }

    /** Every document stored under a path prefix. */
    async getDocumentsByAbsPathPrefix(absPrefix) {
        return this.db.prepare(`SELECT absolute_path, relative_path FROM Documents WHERE absolute_path LIKE ? || '%' ESCAPE '\\'`)
            .all(this._escapeLike(absPrefix));
    }

    /** Every document under a subtree, with the identity a read position is keyed by. */
    async getDocumentsInTree(absPrefix) {
        return this.db.prepare(`SELECT id, global_hash, relative_path, absolute_path, name
            FROM Documents WHERE absolute_path LIKE ? || '%' ESCAPE '\\'`)
            .all(this._escapeLike(absPrefix));
    }

    /** Folders whose absolute path sits under `absPrefix`, optionally skipping one path. */
    async getFoldersByAbsPathPrefix(absPrefix, excludeAbsPath) {
        return this.db.prepare(`SELECT absolute_path, relative_path FROM Folders WHERE absolute_path LIKE ? || '%' ESCAPE '\\' AND absolute_path != ?`)
            .all(this._escapeLike(absPrefix), excludeAbsPath);
    }

    /** Creates a folder/document to child inheritance connection. */
    async insertInheritance(parentNodeId, childNodeId) {
        const typeId = (await this._typeIds()).inheritanceTypeId;
        if (!typeId) throw new Error('inheritance connection type missing');
        return await this.db.prepare(
            'INSERT INTO Connections (origin_id, destiny_id, type_id) VALUES (?, ?, ?)'
        ).run(parentNodeId, childNodeId, typeId);
    }

    /** Drops an inheritance connection between two nodes. */
    async deleteInheritance(parentNodeId, childNodeId) {
        const typeId = (await this._typeIds()).inheritanceTypeId;
        if (!typeId) return;
        await this.db.prepare(
            'DELETE FROM Connections WHERE origin_id = ? AND destiny_id = ? AND type_id = ?'
        ).run(parentNodeId, childNodeId, typeId);
    }

    /** The graph node id for a folder, by absolute path. */
    async getNodeIdByFolderAbsPath(absPath) {
        const row = await this.db.prepare('SELECT node_id FROM Folders WHERE absolute_path = ?').get(absPath);
        return row ? row.node_id : null;
    }

    /** The Documents row at an absolute path. */
    async getDocumentByAbsolutePath(absPath) {
        return await this.db.prepare('SELECT * FROM Documents WHERE absolute_path = ?').get(absPath);
    }

    /** The graph node id for a document, by absolute path. */
    async getNodeIdByDocumentAbsPath(absPath) {
        const row = await this.db.prepare('SELECT node_id FROM Documents WHERE absolute_path = ?').get(absPath);
        return row ? row.node_id : null;
    }

    /** Free-text search over folders, documents and flashcards. */
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

    /** Unified search: `{ folders, documents, flashcards, tags, decks }` for a bare `q`, `{ flashcards }` once any filter is supplied. */
    async superSearch({ q = null, tag = null, deck = null, document: docQ = null, folder = null, limit = 20 } = {}, scope) {
        const hasFilter = tag || deck || docQ || folder;
        if (hasFilter) {
            return { flashcards: await this._searchFlashcards({ q, tag, deck, docQ, folder, limit }, scope) };
        }

        if (!q || !q.trim()) return { folders: [], documents: [], flashcards: [], tags: [], decks: [] };
        const term = `%${q.trim()}%`;

        const folders = await this.db.prepare(
            `SELECT name, relative_path as path, global_hash FROM Folders WHERE name LIKE ? LIMIT ?`
        ).all(term, limit);

        const documents = await this.db.prepare(
            `SELECT name, relative_path as path, global_hash FROM Documents WHERE name LIKE ? LIMIT ?`
        ).all(term, limit);

        const flashcards = await this.db.prepare(`
            SELECT f.global_hash, f.name, f.card_type, COALESCE(p.level, 0) AS level, f.origin,
                   c.frontText, c.backText, c.answerText,
                   d.relative_path as document_path, d.name as document_name
            FROM Flashcards f
            ${PROGRESS_JOIN()}
            JOIN FlashcardContent c ON f.content_id = c.id
            LEFT JOIN Documents d ON d.id = f.document_id
            WHERE c.frontText LIKE ? OR c.backText LIKE ? OR c.answerText LIKE ? OR f.name LIKE ?
            LIMIT ?
        `).all(scoped(scope), term, term, term, term, limit);

        const tags = await this.db.prepare(
            `SELECT name FROM Tags WHERE name LIKE ? LIMIT ?`
        ).all(term, limit);

        const decks = await this.db.prepare(
            `SELECT name, global_hash FROM Decks WHERE name LIKE ? LIMIT ?`
        ).all(term, limit);

        return { folders, documents, flashcards, tags, decks };
    }

    /** Flashcard half of `superSearch`, matching every supplied filter at once. */
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
            conditions.push('(c.frontText LIKE ? OR c.backText LIKE ? OR c.answerText LIKE ? OR f.name LIKE ?)');
            condParams.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
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

    /** Mean card level for a document, feeding the stored `presence` field. Callers pass OWNER_SCOPE. */
    async getFlashcardAvgLevel(documentId, scope) {
        return await this.db.prepare(`
            SELECT AVG(COALESCE(p.level, 0)) as score
            FROM Flashcards f
            ${PROGRESS_JOIN()}
            WHERE f.document_id = ?
        `).get(scoped(scope), documentId);
    }

    /** The folder a document belongs to. */
    async getDocumentFolderIdById(documentId) {
        return await this.db.prepare('SELECT folder_id FROM Documents WHERE id = ?').get(documentId);
    }

    /** One Folders row. */
    async getFolderById(folderId) {
        return await this.db.prepare('SELECT * FROM Folders WHERE id = ?').get(folderId);
    }

    /** Count and mean presence of the documents directly in a folder. */
    async getDocumentPresenceStats(folderId) {
        return await this.db.prepare('SELECT count(*) as cnt, sum(presence) as total FROM Documents WHERE folder_id = ?').get(folderId);
    }

    /** Presence of each immediate subfolder. */
    async getChildFolderPresences(parentId) {
        return await this.db.prepare('SELECT presence FROM Folders WHERE parent_id = ?').all(parentId);
    }

    /** Writes a document's stored presence score. */
    async updateDocumentPresence(documentId, score) {
        return await this.db.prepare('UPDATE Documents SET presence = ? WHERE id = ?').run(score, documentId);
    }

    /** Writes a folder's stored presence score. */
    async updateFolderPresence(folderId, presence) {
        return await this.db.prepare('UPDATE Folders SET presence = ? WHERE id = ?').run(presence, folderId);
    }

    /** The ConnectionTypes id for `inheritance`. */
    async getHierarchyTypeId() {
        return { id: (await this._typeIds()).inheritanceTypeId };
    }

    /** Tag names reaching a node through inheritance or deck membership, deduped. */
    async getInheritedTagNames(nodeId) {
        return (await this.db.prepare(`
            SELECT DISTINCT t.name FROM InheritedTags it
            JOIN Connections c ON it.connection_id = c.id
            JOIN Tags t ON t.id = it.tag_id
            WHERE c.destiny_id = ?
              AND c.type_id IN (SELECT id FROM ConnectionTypes WHERE name IN ('inheritance', 'deck'))
        `).all(nodeId)).map(t => t.name);
    }

    /** Tag names attached to a node itself. */
    async getDirectTagNames(nodeId) {
        const { tagConnTypeId } = await this._typeIds();
        return (await this.db.prepare(`
            SELECT t.name FROM Connections c
            JOIN Tags t ON t.node_id = c.destiny_id
            WHERE c.origin_id = ? AND c.type_id = ?
        `).all(nodeId, tagConnTypeId)).map(r => r.name);
    }

    /** The connection between two nodes of this type, created if absent. */
    async getOrCreateConnection(originId, destId, typeId) {
        let conn = await this.db.prepare('SELECT id FROM Connections WHERE origin_id = ? AND destiny_id = ? AND type_id = ?').get(originId, destId, typeId);
        if (!conn) {
            const info = await this.db.prepare('INSERT INTO Connections (origin_id, destiny_id, type_id) VALUES (?, ?, ?)').run(originId, destId, typeId);
            conn = { id: info.lastInsertRowid };
        }
        return conn;
    }

    /** Drops every InheritedTags row on a connection. */
    async clearInheritedTags(connectionId) {
        return await this.db.prepare('DELETE FROM InheritedTags WHERE connection_id = ?').run(connectionId);
    }

    /** Records one tag as inherited through a connection. */
    async insertInheritedTag(connectionId, tagId) {
        return await this.db.prepare('INSERT INTO InheritedTags (connection_id, tag_id) VALUES (?, ?)').run(connectionId, tagId);
    }

    /** Graph node ids of every card in a document. */
    async getFlashcardNodeIds(documentId) {
        return await this.db.prepare('SELECT node_id FROM Flashcards WHERE document_id = ?').all(documentId);
    }

    /** Nodes and edges for the graph view, shaded by this person's progress. */
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

    /** The Documents row with this globalHash. */
    async getDocumentByHash(hash) {
        return await this.db.prepare('SELECT id, node_id, relative_path, name FROM Documents WHERE global_hash = ?').get(hash);
    }

    /** Records a `flashback://` link whose target does not exist yet. */
    async upsertDocumentLinkQueue(sourceHash, targetHash, anchorText) {
        return await this.db.prepare(
            'INSERT OR IGNORE INTO DocumentLinks (source_hash, target_hash, anchor_text) VALUES (?, ?, ?)'
        ).run(sourceHash, targetHash, anchorText ?? '');
    }

    /** Queued links waiting for this target to appear. */
    async getPendingLinksForTarget(targetHash) {
        return await this.db.prepare('SELECT * FROM DocumentLinks WHERE target_hash = ?').all(targetHash);
    }

    /** Queued links originating in this document. */
    async getPendingLinksFromSource(sourceHash) {
        return await this.db.prepare('SELECT * FROM DocumentLinks WHERE source_hash = ?').all(sourceHash);
    }

    /** Clears a document's queued links. */
    async deleteDocumentLinkQueueBySource(sourceHash) {
        return await this.db.prepare('DELETE FROM DocumentLinks WHERE source_hash = ?').run(sourceHash);
    }

    /** Drops every resolved link edge leaving a node. */
    async deleteDocumentLinkConnections(nodeId) {
        const { linkConnTypeId } = await this._typeIds();
        if (!linkConnTypeId) return;
        return await this.db.prepare(
            'DELETE FROM Connections WHERE origin_id = ? AND type_id = ?'
        ).run(nodeId, linkConnTypeId);
    }

    /** Creates a resolved link edge between two documents. */
    async insertDocumentLinkConnection(sourceNodeId, targetNodeId) {
        const { linkConnTypeId } = await this._typeIds();
        if (!linkConnTypeId) throw new Error('link ConnectionType missing — run migrations');
        return await this.db.prepare(
            'INSERT INTO Connections (origin_id, destiny_id, type_id) VALUES (?, ?, ?)'
        ).run(sourceNodeId, targetNodeId, linkConnTypeId);
    }

    /** Resolved `flashback://` link edges for one document, both directions. */
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

    /** Creates a Decks row. */
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

    /** One deck by globalHash. */
    async getDeckByHash(hash) {
        return await this.db.prepare('SELECT id, node_id, global_hash, name, description, is_system, created_at, updated_at FROM Decks WHERE global_hash = ?').get(hash);
    }

    /** The vault's system deck, which holds every standalone card. */
    async getSystemDeck() {
        return await this.db.prepare('SELECT id, node_id, global_hash, name, description, is_system, created_at, updated_at FROM Decks WHERE is_system = 1 LIMIT 1').get();
    }

    /** Graph node id for a card, by globalHash. */
    async getFlashcardNodeIdByHash(cardHash) {
        const row = await this.db.prepare('SELECT node_id FROM Flashcards WHERE global_hash = ?').get(cardHash);
        return row?.node_id ?? null;
    }

    /** Links a card into a deck in the graph. */
    async insertDeckConnection(deckNodeId, cardNodeId) {
        const { deckConnTypeId } = await this._typeIds();
        if (!deckConnTypeId) return;
        await this.db.prepare(
            'INSERT INTO Connections (origin_id, destiny_id, type_id) VALUES (?, ?, ?)'
        ).run(deckNodeId, cardNodeId, deckConnTypeId);
    }

    /** Unlinks a card from a deck in the graph. */
    async deleteDeckConnection(deckNodeId, cardNodeId) {
        const { deckConnTypeId } = await this._typeIds();
        if (!deckConnTypeId) return;
        await this.db.prepare(
            'DELETE FROM Connections WHERE origin_id = ? AND destiny_id = ? AND type_id = ?'
        ).run(deckNodeId, cardNodeId, deckConnTypeId);
    }

    /** Stores a deck's tags on the deck to card connection, so they reach the card without touching its document inheritance. */
    async setDeckConnectionInheritedTags(deckNodeId, cardNodeId, tagIds) {
        const { deckConnTypeId } = await this._typeIds();
        if (!deckConnTypeId) return;
        const conn = await this.getOrCreateConnection(deckNodeId, cardNodeId, deckConnTypeId);
        await this.clearInheritedTags(conn.id);
        for (const tagId of tagIds) await this.insertInheritedTag(conn.id, tagId);
    }

    /** Every deck, with its entry count. */
    async getAllDecks() {
        return await this.db.prepare(`
            SELECT d.*, COUNT(e.id) as entry_count
            FROM Decks d
            LEFT JOIN DeckEntries e ON e.deck_id = d.id
            GROUP BY d.id
            ORDER BY d.updated_at DESC
        `).all();
    }

    /** Updates a deck's mutable fields. */
    async updateDeck(id, data) {
        await this.db.prepare(`
            UPDATE Decks SET name = ?, description = ?, updated_at = datetime('now')
            WHERE id = ?
        `).run(data.name, data.description ?? null, id);
    }

    /** Deletes a deck row. */
    async deleteDeck(id) {
        await this.db.prepare('DELETE FROM Decks WHERE id = ?').run(id);
    }

    /** Adds a card to a deck. */
    async insertDeckEntry(data) {
        return await this.db.prepare(`
            INSERT INTO DeckEntries (deck_id, card_hash, document_path, position, inline_card)
            VALUES (?, ?, ?, ?, ?)
        `).run(data.deckId, data.cardHash, data.documentPath ?? null, data.position ?? 0, data.inlineCard ?? null);
    }

    /** A deck's entries with this person's schedule joined on. */
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

    /** One deck entry. */
    async getDeckEntryByCardHash(deckId, cardHash) {
        return await this.db.prepare('SELECT id FROM DeckEntries WHERE deck_id = ? AND card_hash = ?').get(deckId, cardHash);
    }

    /** Removes a card from a deck. */
    async deleteDeckEntry(deckId, cardHash) {
        await this.db.prepare('DELETE FROM DeckEntries WHERE deck_id = ? AND card_hash = ?').run(deckId, cardHash);
    }

    /** How many cards a deck holds. */
    async getDeckEntryCount(deckId) {
        return (await this.db.prepare('SELECT COUNT(*) as c FROM DeckEntries WHERE deck_id = ?').get(deckId)).c;
    }

    /** Adds the card browser's `origin` filter (`ai` or `human`) to a condition list. */
    _flashcardOriginCondition(origin, conditions) {
        if (origin === 'ai') conditions.push("f.origin = 'ai'");
        else if (origin === 'human') conditions.push("(f.origin IS NULL OR f.origin <> 'ai')");
    }

    /** Shared WHERE builder for the card browser's list and count queries, which must filter identically. */
    _flashcardFilters({ search, level, cardType, origin, flagged, flagKind }, scope) {
        const account = scoped(scope);
        const params = [];
        const conditions = [];

        if (search) {
            const term = `%${search}%`;
            conditions.push('(c.frontText LIKE ? OR c.backText LIKE ? OR c.answerText LIKE ? OR f.name LIKE ?)');
            params.push(term, term, term, term);
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

        if (flagged || flagKind) {
            const kindClause = flagKind ? ' AND cf.kind = ?' : '';
            conditions.push(`EXISTS (SELECT 1 FROM CardFlags cf
                WHERE cf.flashcard_id = f.id AND cf.account_id = ? AND cf.dismissed_at IS NULL${kindClause})`);
            params.push(account);
            if (flagKind) params.push(flagKind);
        }

        return { where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', params };
    }

    /** A page of the card browser, filtered and sorted. */
    async getAllFlashcards({ search = null, level = null, cardType = null, origin = null, flagged = false, flagKind = null, sortBy = 'level', sortDir = 'desc', limit = 50, offset = 0 } = {}, scope) {
        const account = scoped(scope);
        const { where, params } = this._flashcardFilters({ search, level, cardType, origin, flagged, flagKind }, account);
        const sortCols = {
            level: 'p.level', name: 'f.name', last_recall: 'p.last_recall',
            lapses: 'p.fsrs_lapses', difficulty: 'p.fsrs_difficulty',
        };
        const sortCol = sortCols[sortBy] ?? 'p.level';
        const dir = sortDir === 'asc' ? 'ASC' : 'DESC';
        const nullsLast = sortCol === 'p.fsrs_difficulty' ? `${sortCol} IS NULL, ` : '';

        return await this.db.prepare(`
            SELECT f.global_hash, f.name, COALESCE(p.level, 0) AS level, p.last_recall, f.card_type,
                   p.fsrs_lapses as lapses, p.fsrs_difficulty as difficulty, f.origin,
                   c.frontText, c.backText, c.answerText, c.custom_html,
                   d.relative_path as document_path, d.name as document_name,
                   pc.name as category,
                   -- Scalar subquery, not a join: the browser renders a flag chip per
                   -- row without an N+1, and a twice-flagged card stays one row.
                   (SELECT GROUP_CONCAT(cf.kind) FROM CardFlags cf
                     WHERE cf.flashcard_id = f.id AND cf.account_id = ? AND cf.dismissed_at IS NULL) AS flags
            FROM Flashcards f
            ${PROGRESS_JOIN()}
            JOIN FlashcardContent c ON f.content_id = c.id
            LEFT JOIN Documents d ON f.document_id = d.id
            LEFT JOIN PedagogicalCategories pc ON f.category_id = pc.id
            ${where}
            ORDER BY ${nullsLast}${sortCol} ${dir}, f.name ASC
            LIMIT ? OFFSET ?
        `).all(account, account, ...params, limit, offset);
    }

    /** Row count matching the card browser's current filters. */
    async getFlashcardCountFiltered({ search = null, level = null, cardType = null, origin = null, flagged = false, flagKind = null } = {}, scope) {
        const account = scoped(scope);
        const { where, params } = this._flashcardFilters({ search, level, cardType, origin, flagged, flagKind }, account);
        const contentJoin = search ? 'JOIN FlashcardContent c ON f.content_id = c.id' : '';

        return (await this.db.prepare(`
            SELECT COUNT(*) as c FROM Flashcards f ${PROGRESS_JOIN()} ${contentJoin} ${where}
        `).get(account, ...params)).c;
    }

    /** Rewrites a card's content fields. */
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

    /** Removes a card from every deck it belongs to. */
    async deleteFlashcardDeckEntries(cardHash) {
        return await this.db.prepare('DELETE FROM DeckEntries WHERE card_hash = ?').run(cardHash);
    }

    /** Every deck holding this card, with `is_system` so callers can tell shared from standalone. */
    async getDecksContainingCard(cardHash) {
        return await this.db.prepare(`
            SELECT d.id, d.global_hash, d.name, d.is_system
            FROM DeckEntries e
            JOIN Decks d ON d.id = e.deck_id
            WHERE e.card_hash = ?
        `).all(cardHash);
    }

    /** Answer bodies the card-health classifier calibrates `long` against, capped rather than vault-wide. */
    async getFlashcardAnswerSamples(limit = 2000) {
        return await this.db.prepare(`
            SELECT f.card_type, c.backText, c.answerText, c.custom_html
            FROM Flashcards f
            JOIN FlashcardContent c ON f.content_id = c.id
            WHERE c.backText IS NOT NULL OR c.answerText IS NOT NULL OR c.custom_html IS NOT NULL
            LIMIT ?
        `).all(limit);
    }

    /** Vault-wide review stream for session segmentation, excluding the Doctor's synthetic rebuild rows. */
    async getRecentReviewSessionRows(since, scope) {
        return await this.db.prepare(`
            SELECT rl.id, f.id AS flashcard_id, rl.timestamp, rl.outcome
            FROM progress.ReviewLogs rl
            JOIN Flashcards f ON f.global_hash = rl.card_hash
            WHERE rl.outcome IS NOT NULL AND rl.account_id = ? AND rl.timestamp >= ?
            ORDER BY rl.timestamp ASC, rl.id ASC
        `).all(scoped(scope), since);
    }

    /** This person's health watermark for a card. */
    async getCardHealth(flashcardId, scope) {
        return await this.db.prepare(
            'SELECT * FROM CardHealth WHERE flashcard_id = ? AND account_id = ?'
        ).get(flashcardId, scoped(scope)) ?? null;
    }

    /** Creates or updates this person's card-health row. */
    async upsertCardHealth(flashcardId, { epochAt = null, epochReason = null, contentFingerprint = null }, scope) {
        return await this.db.prepare(`
            INSERT INTO CardHealth (flashcard_id, account_id, epoch_at, epoch_reason, content_fingerprint, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(flashcard_id, account_id) DO UPDATE SET
                epoch_at            = excluded.epoch_at,
                epoch_reason        = excluded.epoch_reason,
                content_fingerprint = excluded.content_fingerprint,
                updated_at          = excluded.updated_at
        `).run(flashcardId, scoped(scope), epochAt, epochReason, contentFingerprint, new Date().toISOString());
    }

    /** Records a re-evaluation that did not address the card. */
    async setCardHealthFingerprint(flashcardId, contentFingerprint, scope) {
        return await this.db.prepare(
            'UPDATE CardHealth SET content_fingerprint = ?, updated_at = ? WHERE flashcard_id = ? AND account_id = ?'
        ).run(contentFingerprint, new Date().toISOString(), flashcardId, scoped(scope));
    }

    /** This person's flags on a card. */
    async getCardFlags(flashcardId, { includeDismissed = false } = {}, scope) {
        const filter = includeDismissed ? '' : ' AND dismissed_at IS NULL';
        return await this.db.prepare(
            `SELECT * FROM CardFlags WHERE flashcard_id = ? AND account_id = ?${filter} ORDER BY detected_at DESC`
        ).all(flashcardId, scoped(scope));
    }

    /** Raises or refreshes a flag in place, leaving `dismissed_at` untouched. */
    async upsertCardFlag({ flashcardId, kind, confidence, score, evidence, levelAtDetection, reviewLogId }, scope) {
        return await this.db.prepare(`
            INSERT INTO CardFlags
                (flashcard_id, account_id, kind, confidence, score, evidence_json,
                 level_at_detection, detected_at, review_log_id, dismissed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
            ON CONFLICT(flashcard_id, account_id, kind) DO UPDATE SET
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

    /** Clears this person's flags on a card, optionally limited to `kinds`. */
    async deleteCardFlags(flashcardId, { kinds = null, includeDismissed = false } = {}, scope) {
        const params = [flashcardId, scoped(scope)];
        let sql = 'DELETE FROM CardFlags WHERE flashcard_id = ? AND account_id = ?';
        if (!includeDismissed) sql += ' AND dismissed_at IS NULL';
        if (kinds?.length) {
            sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
            params.push(...kinds);
        }
        return (await this.db.prepare(sql).run(...params)).changes;
    }

    /** Clears EVERY account's flags on a card; the edit hook, see ACCESS.md. */
    async deleteAllCardFlags(flashcardId) {
        return (await this.db.prepare('DELETE FROM CardFlags WHERE flashcard_id = ?').run(flashcardId)).changes;
    }

    /** Stamps a new epoch and fingerprint on every account analysed on this card, seeding the owner's row when there is none. */
    async resetAllCardHealth(flashcardId, { epochAt, epochReason, contentFingerprint }) {
        const changed = (await this.db.prepare(`
            UPDATE CardHealth SET epoch_at = ?, epoch_reason = ?, content_fingerprint = ?, updated_at = ?
            WHERE flashcard_id = ?
        `).run(epochAt, epochReason, contentFingerprint, new Date().toISOString(), flashcardId)).changes;
        if (changed === 0) {
            await this.upsertCardHealth(flashcardId, { epochAt, epochReason, contentFingerprint }, OWNER_SCOPE);
        }
        return changed;
    }

    /** Marks one flag as ruled on, suppressing it without deleting it. */
    async dismissCardFlag(flashcardId, kind, scope) {
        return (await this.db.prepare(
            'UPDATE CardFlags SET dismissed_at = ? WHERE flashcard_id = ? AND account_id = ? AND kind = ?'
        ).run(new Date().toISOString(), flashcardId, scoped(scope), kind)).changes;
    }

    /** Runs SQLite's `PRAGMA integrity_check`. */
    async integrityCheck() {
        return (await this.db.prepare('PRAGMA integrity_check').get()).integrity_check;
    }

    /** Every Documents row. */
    async getAllDocuments() {
        return await this.db.prepare('SELECT id, folder_id, node_id, global_hash, relative_path, absolute_path, name, encoding FROM Documents').all();
    }

    /** Every Folders row. */
    async getAllFolders() {
        return await this.db.prepare('SELECT id, parent_id, node_id, global_hash, relative_path, absolute_path, name FROM Folders').all();
    }

    /** Every Media row. */
    async getAllMedia() {
        return await this.db.prepare('SELECT id, hash, name, relative_path, absolute_path FROM Media').all();
    }

    /** How many cards belong to no document. */
    async getStandaloneCardCount() {
        return (await this.db.prepare('SELECT COUNT(*) as c FROM Flashcards WHERE document_id IS NULL').get()).c;
    }

    /** How many queued links are still unresolved. */
    async getPendingLinkCount() {
        return (await this.db.prepare('SELECT COUNT(*) as c FROM DocumentLinks').get()).c;
    }

    /** Rewrites a deck entry's inline card snapshot. */
    async updateDeckEntryInlineCard(deckId, cardHash, inlineCard) {
        this.db.prepare('UPDATE DeckEntries SET inline_card = ? WHERE deck_id = ? AND card_hash = ?')
            .run(inlineCard, deckId, cardHash);
    }

    /** Rebuild only: re-seeds one log row per card so SM-2 ease survives; `outcome` is NULL to mark it synthetic. */
    async insertSyntheticReviewLog(flashcardId, easeFactor, level, scope) {
        await this.db.prepare(`
            INSERT INTO progress.ReviewLogs (card_hash, account_id, timestamp, outcome, ease_factor, level)
            VALUES ((SELECT global_hash FROM Flashcards WHERE id = ?), ?, datetime('now'), NULL, ?, ?)
        `).run(flashcardId, scoped(scope), easeFactor, level ?? 0);
    }

    /** Empties every derived table ahead of a Doctor rebuild. */
    async wipeDerivedContent() {
        await this.db.transaction(async () => {
            await this.db.prepare('DELETE FROM DeckEntries').run();
            await this.db.prepare('DELETE FROM InheritedTags').run();
            await this.db.prepare('DELETE FROM CardFlags').run();
            await this.db.prepare('DELETE FROM CardHealth').run();
            await this.db.prepare('DELETE FROM CardProgress').run();
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

    /** Copies a legacy `type_answer` card's graded answer out of `backText` into `answerText`. */
    async backfillTypeAnswerAnswerText() {
        return (await this.db.prepare(`
            UPDATE FlashcardContent
               SET answerText = backText,
                   backText   = NULL
             WHERE answerText IS NULL
               AND id IN (SELECT content_id FROM Flashcards WHERE card_type = 'type_answer')
        `).run()).changes;
    }

    /** Which canonical updates this vault has finished. */
    async getCanonicalVersions() {
        return new Set((await this.db.prepare('SELECT version FROM CanonicalVersion').all()).map(r => r.version));
    }

    /** The applied schema version. */
    async getSchemaVersion() {
        const row = await this.db.prepare('SELECT MAX(version) AS version FROM SchemaVersion').get();
        return row?.version ?? 0;
    }

    /** Marks a canonical update as finished. */
    async recordCanonicalVersion(version, description = null) {
        await this.db.prepare(
            'INSERT OR REPLACE INTO CanonicalVersion (version, description) VALUES (?, ?)'
        ).run(version, description);
    }

    /** Every highlight on a document. */
    async getHighlightsByDocumentId(documentId) {
        return await this.db.prepare(
            'SELECT * FROM Highlights WHERE document_id = ? ORDER BY start ASC'
        ).all(documentId);
    }

    /** One highlight by globalHash. */
    async getHighlightByHash(hash) {
        return await this.db.prepare('SELECT * FROM Highlights WHERE global_hash = ?').get(hash);
    }

    /** Creates a Highlights row. */
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

    /** Updates a highlight's colour or anchor. */
    async updateHighlight(hash, data) {
        return await this.db.prepare(
            'UPDATE Highlights SET color = ?, note = ? WHERE global_hash = ?'
        ).run(data.color, data.note ?? '', hash);
    }

    /** Deletes a highlight. */
    async deleteHighlight(hash) {
        return await this.db.prepare('DELETE FROM Highlights WHERE global_hash = ?').run(hash);
    }

    /** Paths of every document carrying at least one highlight. */
    async getHighlightedDocumentPaths() {
        return (await this.db.prepare(`
            SELECT DISTINCT d.relative_path
            FROM Highlights h
            JOIN Documents d ON h.document_id = d.id
            ORDER BY d.relative_path ASC
        `).all()).map(r => r.relative_path);
    }

    /** Reconciles a document's Highlights rows against its sidecar. */
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

    /** Every pedagogical category. */
    async getCategories() {
        return await this.db.prepare(
            'SELECT id, name, priority, description FROM PedagogicalCategories ORDER BY priority ASC, name ASC'
        ).all();
    }

    /** One category by name. */
    async getCategoryByName(name) {
        return await this.db.prepare('SELECT id, name, priority, description FROM PedagogicalCategories WHERE name = ?').get(name);
    }

    /** How many cards use a category. */
    async getCategoryUsageCount(id) {
        return (await this.db.prepare(
            'SELECT COUNT(*) as c FROM Flashcards WHERE category_id = ?'
        ).get(id)).c;
    }

    /** Creates a category. */
    async insertCategory({ name, priority = 0, description = '' }) {
        return (await this.db.prepare(
            'INSERT INTO PedagogicalCategories (name, priority, description) VALUES (?, ?, ?)'
        ).run(name, priority, description)).lastInsertRowid;
    }

    /** Renames or re-describes a category. */
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

    /** Deletes a category. */
    async deleteCategory(id) {
        await this.db.prepare('DELETE FROM PedagogicalCategories WHERE id = ?').run(id);
    }
}

export default new DocumentQuery();
