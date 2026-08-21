/**
 * Query.js
 * Data Access Layer for Flashback.
 * Handles all direct SQLite interactions.
 */

import db from '../primitives/database.js';
import { OWNER_SCOPE } from '../../requestContext.js';

/**
 * SPACED-REPETITION PROGRESS IS SCOPED TO A PERSON.
 *
 * Every method below that reads or writes a schedule, a review log, a health verdict or a
 * fitted weight vector takes a `scope`: an account id, or the literal 'owner' for the vault's
 * Author (requestContext.js OWNER_SCOPE). It is always an explicit argument and is never read
 * from ambient state here — `query.js` is the data layer, and whose data a statement returns
 * is not something a call site should have to go somewhere else to find out.
 *
 * `scoped()` refuses a missing one rather than defaulting. Defaulting to the owner would make
 * a forgotten argument return the owner's schedule to whoever asked, which is precisely the
 * bug this whole layer exists to prevent, and it would do it silently.
 */
function scoped(scope) {
    if (typeof scope !== 'string' || scope.length === 0) {
        throw new Error(
            'query: this call needs an account scope (an account id, or OWNER_SCOPE). '
            + 'Resolve it once at the orchestrator boundary with requestContext.currentScope().'
        );
    }
    return scope;
}

/**
 * The join that turns a Flashcards row into one person's view of that card.
 *
 * A missing CardProgress row means "never reviewed by this person", which is exactly what a
 * zero level and a NULL last_recall meant when these columns lived on Flashcards — so every
 * reader COALESCEs and nothing has to be seeded on card creation.
 *
 * The `?` binds the scope, and it binds at the position where the join appears in the
 * statement. Callers must push the scope onto their parameter list at the same point.
 */
/** The camelCase names a caller (sidecar data, a scheduler result) uses for schedule state. */
const PROGRESS_KEYS = [
    'level', 'sm2Reps', 'lastRecall', 'fsrsStability', 'fsrsDifficulty',
    'fsrsDue', 'fsrsState', 'fsrsReps', 'fsrsLapses',
];

const PROGRESS_JOIN = (cardAlias = 'f', progressAlias = 'p') =>
    `LEFT JOIN CardProgress ${progressAlias} ON ${progressAlias}.flashcard_id = ${cardAlias}.id AND ${progressAlias}.account_id = ?`;

/**
 * Per-card "how well learned is this" score in 0..1, as a SQL expression over a
 * CardProgress row aliased as `t` — one PERSON's grasp of the card, not the card's own
 * property. `t` may be an outer-joined alias, in which case every arm reads NULL and the
 * COALESCE at the bottom returns 0: a card nobody has reviewed is a card nobody has learned.
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

    /**
     * Drops the type-id cache on a vault switch.
     *
     * NodeTypes/ConnectionTypes rows are seeded per database, so their autoincrement ids
     * are only stable WITHIN one vault. Carrying them across a switch would silently write
     * the other vault's type ids into this vault's Nodes and Connections.
     */
    onVaultOpened() {
        this._typeCache = null;
    }

    // Lazily resolves stable lookup IDs for NodeTypes/ConnectionTypes that never
    // change at runtime, so callers in hot paths avoid repeated SELECT lookups.
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
     * @param {string} typeName - e.g., 'Folder', 'Document', 'Flashcard', 'Tag'
     * @returns {number} The node ID.
     */
    async createNode(typeName) {
        const type = await this.db.prepare('SELECT id FROM NodeTypes WHERE name = ?').get(typeName);
        if (!type) throw new Error(`${typeName} node type missing.`);
        const info = await this.db.prepare('INSERT INTO Nodes (type_id) VALUES (?)').run(type.id);
        return info.lastInsertRowid;
    }

    // --- Folders ---

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

    // --- Documents ---

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

    // --- Flashcards ---

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

    // Returns a Map<folderId, count> covering each root and its entire subtree.
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

        // 1. Content
        const contentStmt = this.db.prepare(`
            INSERT INTO FlashcardContent (custom_html, frontText, backText, answerText, front_img, back_img, front_sound, back_sound)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const contentInfo = await contentStmt.run(customHtml, frontText, backText, answerText, fImg, bImg, fSnd, bSnd);

        // 2. Reference
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

        // 3. Main Entry
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

        // Any schedule carried on `data` is the SCOPE's, not the card's. In practice that
        // scope is always the owner: this data comes from a `.flashback` sidecar, and the
        // sidecar is the owner's record of their own progress.
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

        await this._writeProgress(id, scope, data);

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
            await this.db.prepare(`UPDATE FlashcardContent SET ${contentUpdates.join(', ')} WHERE id = ?`).run(...params);
        }
    }

    async deleteFlashcard(id) {
        await this.db.prepare('DELETE FROM Flashcards WHERE id = ?').run(id);
        // Triggers handle: Nodes, FlashcardContent, FlashcardReference
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

    // --- CardProgress primitives ---
    //
    // Everything below that changes a schedule funnels through _upsertProgress, so there is
    // exactly one statement in the app that creates a progress row and exactly one place that
    // decides what an absent field means.

    /**
     * Creates or replaces one person's schedule for one card.
     *
     * `state` is snake_case and complete: every column is written, because a partial upsert
     * would leave a card half-scheduled under one algorithm and half under another. Callers
     * that only know part of the state read the row first.
     */
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

    /**
     * Applies whatever schedule a caller's camelCase payload carries — sidecar data on import,
     * a merge result on sync.
     *
     * Two guards, answering different questions. If the payload mentions no schedule field at
     * all it is a metadata-only write and must leave the schedule alone: a caller that never
     * spoke about progress has not asked for it to be erased. If it mentions only defaults AND
     * there is no row yet, the card is simply new, and writing a row of zeros for every card
     * in the vault would fill the table with rows indistinguishable from absence — which is
     * what every reader's COALESCE already treats them as.
     */
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

    // Batch-seed FSRS state during an algorithm migration (keyed by global_hash).
    // Also sets `level` (display-strength scalar) from the seeded interval so
    // level-based UI is correct immediately after switching into FSRS.
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
            JOIN ReviewLogs lr ON lr.flashcard_id = f.id
            WHERE lr.account_id = ?
              AND lr.id IN (SELECT MAX(id) FROM ReviewLogs WHERE account_id = ? GROUP BY flashcard_id)
        `).all(account, account);
        return new Map(rows.map(r => [r.global_hash, r.ease_factor]));
    }

    /**
     * The shape shared by every batch writer that sets SOME columns of a progress row, by
     * card hash, leaving the rest of that person's state alone.
     *
     * An INSERT ... SELECT rather than an UPDATE, because the card may be one this person has
     * never reviewed: there is no row to update, and an UPDATE would match nothing and report
     * success. The SELECT list carries the untouched columns forward from the outer-joined
     * `p`, so a first write lands defaults and a later one preserves what is there.
     *
     * Parameter order is: account, then the SELECT list's own binds, then account again (for
     * the join), then the card hash.
     */
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

    // Records a graded review against ONE PERSON's schedule. `newValue` is that algorithm's
    // own progress scalar — SM-2's rep count, or the Leitner box — and only that column moves;
    // the other algorithm's state is carried forward untouched so switching back and forth
    // does not erase either.
    async updateFlashcardReview(id, timestamp, newValue, algorithm = 'leitner', scope) {
        const current = await this.getCardProgress(id, scope) ?? {};
        const next = { ...current, last_recall: timestamp };
        if (algorithm === 'sm2') next.sm2_reps = newValue;
        else next.level = newValue;
        await this._upsertProgress(id, scope, next);
    }

    async insertReviewLog(data) {
        // FSRS fields (rating + post-review snapshot) default to null so the
        // existing Leitner/SM-2 callers keep working unchanged.
        // Session-ordering columns record how the card was PRESENTED (see
        // migrations/009_session_ordering.js). They default to null so every caller
        // without a trainer session — the MCP server, scripts, tests — keeps working,
        // and so "not recorded" stays distinguishable from "distance 0".
        await this.db.prepare(`
            INSERT INTO ReviewLogs
                (flashcard_id, account_id, timestamp, outcome, ease_factor, level, algorithm,
                 rating, fsrs_stability, fsrs_difficulty, fsrs_due, fsrs_state,
                 session_id, session_position, prev_distance, nearest_sibling_lag)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

    // Everything the sequencer needs to judge how related two cards are, for a whole
    // session in a fixed number of statements. Per-card getInheritedTagNames/
    // getDirectTagNames would be two statements per card — ~400 for a 200-card session —
    // and this runs on every /due.
    //
    // Returns Map<globalHash, { docId, folderId, ancestorIds, tags:Set, deckIds:Set,
    // linkedDocIds:Set }>. A standalone card (no document) has docId/folderId null and
    // still carries its tags and decks, so it is never confusable by location alone.
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

        // --- Tags: direct on the card, plus inherited from its document/folder/decks.
        // Both feed one set: the sequencer only cares that two cards share a label, not
        // how each of them acquired it.
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

        // --- Decks
        const deckRows = await this.db.prepare(`
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
            const links = await this.db.prepare(`
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

        // --- Folder ancestry, two levels up. The whole Folders table is a few hundred
        // rows at most, so one read beats a recursive CTE per distinct folder.
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

    // The cards already reviewed in one trainer session, in presentation order. Feeds
    // the nearest-confusable-sibling lag on the next review: the server recomputes it
    // from what was actually shown rather than trusting a client-side count, so a card
    // re-queued after a failed grade is counted at both of its positions.
    async getSessionReviewOrder(sessionId, scope) {
        return await this.db.prepare(`
            SELECT rl.session_position AS position, f.global_hash AS globalHash
            FROM ReviewLogs rl
            JOIN Flashcards f ON f.id = rl.flashcard_id
            WHERE rl.session_id = ? AND rl.account_id = ?
            ORDER BY rl.session_position ASC, rl.id ASC
        `).all(sessionId, scoped(scope));
    }

    // The most recent real review's algorithm marker plus the fields that betray a
    // scheduler on rows written before ReviewLogs.algorithm existed. Feeds
    // srs.detectAlgorithm(), which is how the server answers "which scheduler does
    // this vault use?" without a browser to ask.
    async getLatestReviewAlgorithm(scope) {
        return await this.db.prepare(`
            SELECT algorithm, rating
            FROM ReviewLogs
            WHERE outcome IS NOT NULL AND account_id = ?
            ORDER BY timestamp DESC, id DESC
            LIMIT 1
        `).get(scoped(scope)) ?? null;
    }

    // --- FSRS per-card state ---

    // Load a card's FSRS record shaped for access/orchestration/fsrs.js (last_recall aliased to
    // last_review). Fields are null for a card never reviewed under FSRS.
    async getFlashcardFsrsState(id, scope) {
        return await this.db.prepare(`
            SELECT fsrs_stability AS stability, fsrs_difficulty AS difficulty,
                   fsrs_due AS due, fsrs_state AS state,
                   fsrs_reps AS reps, fsrs_lapses AS lapses, last_recall AS last_review
            FROM CardProgress WHERE flashcard_id = ? AND account_id = ?
        `).get(id, scoped(scope)) ?? null;
    }

    // Persist a computed FSRS state (from fsrs.nextState) back onto the card.
    // Also writes `level` — the app-wide display-strength scalar every algorithm
    // maintains (LevelDot, box histogram, mastery counts) — derived by the caller
    // from the FSRS interval so level-based UI stays meaningful under FSRS.
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

    // --- FSRS weight vector (one row per account) ---
    //
    // Per-account because the weights ARE the person: they are fitted to one individual's
    // rated history and describe how fast that individual forgets. A reader scheduled against
    // the owner's fitted weights is being scheduled against someone else's memory, which is
    // why /api/srs/optimize is a reader-level action rather than an administrative one.

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

    // Every FSRS-rated review across the vault, grouped/ordered per card, for the
    // parameter optimizer. Excludes pre-FSRS logs (rating IS NULL).
    async getAllReviewHistories(scope) {
        return await this.db.prepare(`
            SELECT flashcard_id, timestamp, rating
            FROM ReviewLogs
            WHERE rating IS NOT NULL AND account_id = ?
            ORDER BY flashcard_id ASC, id ASC
        `).all(scoped(scope));
    }

    // Undo support: drop a card's most recent review so a misgraded result can be
    // taken back. Returns true if a row was removed, false if the card had no logs.
    async deleteLatestReviewLog(flashcardId, scope) {
        const row = await this.db.prepare(
            'SELECT id FROM ReviewLogs WHERE flashcard_id = ? AND account_id = ? ORDER BY id DESC LIMIT 1'
        ).get(flashcardId, scoped(scope));
        if (!row) return false;
        await this.db.prepare('DELETE FROM ReviewLogs WHERE id = ?').run(row.id);
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
    async getFlashcardReviewHistory(flashcardId, scope) {
        return await this.db.prepare(`
            SELECT id, timestamp, outcome, ease_factor, level, algorithm, rating,
                   fsrs_stability, fsrs_difficulty, fsrs_due, fsrs_state
            FROM ReviewLogs
            WHERE flashcard_id = ? AND account_id = ?
            ORDER BY id ASC
        `).all(flashcardId, scoped(scope));
    }

    // Everything the schedulers need to place one card on its curve. The ease-factor
    // subselect deliberately does NOT skip synthetic rows: after a Doctor rebuild that
    // row is the only carrier of the card's SM-2 ease (see getLatestEaseFactors and the
    // latest_ef CTE in getDueFlashcards, which both read it the same way).
    async getFlashcardSrsStateByHash(hash, scope) {
        const account = scoped(scope);
        return await this.db.prepare(`
            SELECT f.id, f.global_hash,
                   COALESCE(p.level, 0) AS level, COALESCE(p.sm2_reps, 0) AS sm2_reps,
                   p.last_recall, p.fsrs_stability, p.fsrs_difficulty,
                   COALESCE(p.fsrs_state, 0) AS fsrs_state, p.fsrs_due,
                   COALESCE(p.fsrs_reps, 0) AS fsrs_reps, COALESCE(p.fsrs_lapses, 0) AS fsrs_lapses,
                   (SELECT rl.ease_factor FROM ReviewLogs rl
                     WHERE rl.flashcard_id = f.id AND rl.account_id = ?
                     ORDER BY rl.id DESC LIMIT 1) AS ease_factor
            FROM Flashcards f
            ${PROGRESS_JOIN()}
            WHERE f.global_hash = ?
        `).get(account, account, hash);
    }

    // The card's now-latest review after an undo — the state to restore it to.
    // Null when no reviews remain (the card is new again).
    async getLatestReviewLog(flashcardId, scope) {
        return await this.db.prepare(`
            SELECT timestamp, outcome, ease_factor, level,
                   rating, fsrs_stability, fsrs_difficulty, fsrs_due, fsrs_state
            FROM ReviewLogs WHERE flashcard_id = ? AND account_id = ? ORDER BY id DESC LIMIT 1
        `).get(flashcardId, scoped(scope)) ?? null;
    }

    // Restore a card's SRS state after an undo. Mirrors updateFlashcardReview but
    // allows a null last_recall (card reverts to never-reviewed) and touches only
    // the algorithm's own progress column.
    async undoFlashcardReview(id, value, lastRecall, algorithm = 'leitner', scope) {
        const current = await this.getCardProgress(id, scope) ?? {};
        const next = { ...current, last_recall: lastRecall };
        if (algorithm === 'sm2') next.sm2_reps = value;
        else next.level = value;
        await this._upsertProgress(id, scope, next);
    }

    // Every card in the vault falls in exactly one box for this person, and a card they have
    // never reviewed is in box 0 — hence the outer join and the COALESCE rather than a
    // GROUP BY over CardProgress, which would omit the entire new-card pile.
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

    async getMasteredFlashcardCount(threshold, scope) {
        return (await this.db.prepare(
            'SELECT COUNT(*) as c FROM CardProgress WHERE account_id = ? AND level >= ?'
        ).get(scoped(scope), threshold)).c;
    }

    // Per-day review counts for the Stats activity heatmap and retention. Real
    // reviews only — synthetic rebuild logs carry a NULL outcome and are excluded.
    // `sinceIso` optionally bounds the window (null = all time), as an inclusive
    // 'YYYY-MM-DD' local day. Days are the user's local calendar days, not UTC ones —
    // see the note above the diary aggregates for why, and keep every day-keyed query
    // on the same boundary.
    async getReviewActivity(sinceIso = null, scope) {
        const clause = sinceIso
            ? "WHERE outcome IS NOT NULL AND account_id = ? AND date(timestamp, 'localtime') >= ?"
            : 'WHERE outcome IS NOT NULL AND account_id = ?';
        const stmt = this.db.prepare(`
            SELECT date(timestamp, 'localtime') AS day,
                   COUNT(*) AS total,
                   SUM(CASE WHEN outcome = 1 THEN 1 ELSE 0 END) AS correct
            FROM ReviewLogs
            ${clause}
            GROUP BY day
            ORDER BY day ASC
        `);
        const account = scoped(scope);
        return sinceIso ? await stmt.all(account, sinceIso) : await stmt.all(account);
    }

    // Total / correct review counts for the retention headline. `sinceIso` bounds
    // the window (null = all time). Excludes synthetic (NULL-outcome) logs.
    async getReviewTotals(sinceIso = null, scope) {
        const clause = sinceIso
            ? "WHERE outcome IS NOT NULL AND account_id = ? AND date(timestamp, 'localtime') >= ?"
            : 'WHERE outcome IS NOT NULL AND account_id = ?';
        const stmt = this.db.prepare(`
            SELECT COUNT(*) AS total,
                   SUM(CASE WHEN outcome = 1 THEN 1 ELSE 0 END) AS correct
            FROM ReviewLogs
            ${clause}
        `);
        const account = scoped(scope);
        return sinceIso ? await stmt.get(account, sinceIso) : await stmt.get(account);
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

    // Emits a leading `?` for the account scope. Because the CTE opens the statement, that
    // bind is always parameter 1 — which is why every caller below passes the scope first.
    // Numbering a person's reps over everyone's reviews would put a reader's first sight of a
    // card at rep 40 and file it under the review phase.
    _orderedReviewsCte() {
        return `
            WITH ordered AS (
                SELECT flashcard_id, outcome, timestamp,
                       ROW_NUMBER() OVER (
                           PARTITION BY flashcard_id ORDER BY timestamp ASC, id ASC
                       ) AS rep
                FROM ReviewLogs
                WHERE outcome IS NOT NULL AND account_id = ?
            )
        `;
    }

    // → { learning: { total, correct }, review: { total, correct } } (zeroed when a
    // phase has no reviews, so callers never have to null-check the buckets).
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

    // Outcomes of each card's very first review — how much material lands on first
    // contact. One row per card, so `total` here counts cards, not reviews.
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

    // Acquisition cost: how many attempts each card took before it was first recalled
    // correctly (1 = right on first sight). Cards never yet recalled are absent — they
    // have no answer yet, and counting their attempts so far would bias the average.
    // Returns raw rows; the averaging/median lives in srs.js.
    async getReviewsToFirstRecall(scope) {
        return await this.db.prepare(`
            ${this._orderedReviewsCte()}
            SELECT flashcard_id, MIN(rep) AS attempts
            FROM ordered
            WHERE outcome = 1
            GROUP BY flashcard_id
        `).all(scoped(scope));
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

    async getDayReviewTotals(dayIso, scope) {
        return await this.db.prepare(`
            SELECT COUNT(*) AS reviews,
                   COUNT(DISTINCT flashcard_id) AS uniqueCards,
                   SUM(CASE WHEN outcome = 0 THEN 1 ELSE 0 END) AS failed
            FROM ReviewLogs
            WHERE outcome IS NOT NULL AND account_id = ? AND date(timestamp, 'localtime') = ?
        `).get(scoped(scope), dayIso);
    }

    // The day's reviews split into acquisition (a card's first `learningReviews`
    // reviews, ever — not just today's) and review phase. Same shape and rationale as
    // getReviewTotalsByPhase; the day filter is applied after the numbering.
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

    // Cards whose earliest-ever real review falls on this day — i.e. cards first
    // seen (in review terms) on `dayIso`. Idempotent: depends only on log history.
    async getDayNewCards(dayIso, scope) {
        return (await this.db.prepare(`
            SELECT COUNT(*) AS newCards FROM (
                SELECT flashcard_id, MIN(date(timestamp, 'localtime')) AS firstDay
                FROM ReviewLogs
                WHERE outcome IS NOT NULL AND account_id = ?
                GROUP BY flashcard_id
                HAVING firstDay = ?
            )
        `).get(scoped(scope), dayIso)).newCards;
    }

    // Reviews grouped by deck for the day. A card in multiple decks (rare) counts
    // once per deck — this is a per-deck view, not a partition of the day's reviews.
    //
    // The system deck is excluded: it isn't a deck the user built, it's the automatic
    // home every card without a source document falls into, so as a bar in a "By deck"
    // breakdown it reads as a real grouping when it carries no intent. Its reviews are
    // still in the day's totals, exactly as standalone cards are absent from
    // getDayByDocument but counted there too.
    async getDayByDeck(dayIso, scope) {
        return await this.db.prepare(`
            SELECT d.name AS deck,
                   COUNT(*) AS reviews,
                   SUM(CASE WHEN rl.outcome = 0 THEN 1 ELSE 0 END) AS failed
            FROM ReviewLogs rl
            JOIN Flashcards f ON f.id = rl.flashcard_id
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

    // Reviews grouped by source document for the day (document-anchored cards only;
    // standalone cards have no document_id and are excluded here).
    async getDayByDocument(dayIso, scope) {
        return await this.db.prepare(`
            SELECT doc.relative_path AS path,
                   COUNT(*) AS reviews,
                   SUM(CASE WHEN rl.outcome = 0 THEN 1 ELSE 0 END) AS failed
            FROM ReviewLogs rl
            JOIN Flashcards f ON f.id = rl.flashcard_id
            JOIN Documents doc ON doc.id = f.document_id
            WHERE rl.outcome IS NOT NULL AND rl.account_id = ? AND date(rl.timestamp, 'localtime') = ?
            GROUP BY doc.id
            ORDER BY reviews DESC, doc.relative_path ASC
        `).all(scoped(scope), dayIso);
    }

    // Cards that were failed at least once on the day, most-failed first. `front`
    // is the vanilla front text (NULL for custom-HTML cards — caller substitutes).
    async getDayStruggledCards(dayIso, limit = 10, scope) {
        return await this.db.prepare(`
            SELECT f.global_hash AS globalHash,
                   fc.frontText AS front,
                   SUM(CASE WHEN rl.outcome = 0 THEN 1 ELSE 0 END) AS failCount
            FROM ReviewLogs rl
            JOIN Flashcards f ON f.id = rl.flashcard_id
            LEFT JOIN FlashcardContent fc ON fc.id = f.content_id
            WHERE rl.outcome IS NOT NULL AND rl.account_id = ? AND date(rl.timestamp, 'localtime') = ?
            GROUP BY f.id
            HAVING failCount > 0
            ORDER BY failCount DESC, f.id ASC
            LIMIT ?
        `).all(scoped(scope), dayIso, limit);
    }

    // Distinct local-calendar days that carry at least one real review, ascending.
    // Drives the diary "rebuild all summaries" command and streak computation.
    async getReviewActivityDays(scope) {
        return (await this.db.prepare(`
            SELECT date(timestamp, 'localtime') AS day
            FROM ReviewLogs
            WHERE outcome IS NOT NULL AND account_id = ?
            GROUP BY day
            ORDER BY day ASC
        `).all(scoped(scope))).map(r => r.day);
    }

    async getDueFlashcards({ algorithm = 'leitner', folder = null, deck = null, tags = null, maxNew = 20, minPriority = 0 } = {}, scope) {
        const account = scoped(scope);
        const cteParts = [];
        const whereConditions = [];

        // Binds are grouped by WHERE THEY APPEAR in the finished statement, because that is
        // the only thing that decides their order, and this statement is assembled from
        // optional pieces. Three groups, concatenated at the bottom in exactly this sequence:
        //
        //   folderParams — the folder_tree CTE, which is emitted first
        //   efParams     — the latest_ef CTE (SM-2 only), emitted second
        //   cardsParams  — the cards CTE: its progress join first, then its WHERE filters
        //
        // A single flat array worked while only the WHERE clause had binds. It stopped
        // working the moment the account scope had to appear inside two of the CTEs.
        const folderParams = [];
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

        if (deck !== null) {
            whereConditions.push(`f.global_hash IN (
                SELECT de.card_hash FROM DeckEntries de
                JOIN Decks dk ON dk.id = de.deck_id
                WHERE dk.global_hash = ?
            )`);
            cardsParams.push(deck);
        }

        if (algorithm === 'sm2') {
            // One person's latest ease per card. Scoped twice: the inner MAX(id) has to be
            // taken over this person's rows too, or a busier reader's newer log id would
            // decide which row the outer filter never finds.
            cteParts.push(`latest_ef AS (
                SELECT flashcard_id, ease_factor FROM ReviewLogs
                WHERE account_id = ?
                  AND id IN (SELECT MAX(id) FROM ReviewLogs WHERE account_id = ? GROUP BY flashcard_id)
            )`);
            efParams.push(account, account);
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
            cardsParams.push(...tags, ...tags);
        }

        if (minPriority > 0) {
            whereConditions.push('COALESCE(pc.priority, 0) >= ?');
            cardsParams.push(minPriority);
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
                WHEN COALESCE(p.sm2_reps, 0) <= 1 THEN 1
                WHEN p.sm2_reps = 2 THEN 6
                ELSE min(365, CAST(ROUND(6.0 * pow(${easeFactorExpr}, CAST(p.sm2_reps - 2 AS REAL))) AS INTEGER))
               END`
            : `CASE
                WHEN COALESCE(p.level, 0) <= 0 THEN 0
                ELSE min(365, CAST(pow(2.0, CAST(COALESCE(p.level, 0) - 1 AS REAL)) AS INTEGER))
               END`;

        const isFsrs = algorithm === 'fsrs';

        // Expose the algorithm-relevant count as "level" so the frontend shows a
        // meaningful number regardless of which algorithm is active. For FSRS the
        // stability (rounded, in days) is the natural "strength" number.
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
        // The progress join opens the cards CTE, so its bind leads that CTE's group.
        cardsParams.unshift(account);

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

        const allRows = await this.db.prepare(`
            WITH RECURSIVE ${cteParts.join(',\n')}
            SELECT *,
              ${dueDateExpr} AS due_date,
              ${statusExpr} AS _status
            FROM cards
        `).all(...folderParams, ...efParams, ...cardsParams);

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

    async getAllTags() {
        return (await this.db.prepare('SELECT DISTINCT name FROM Tags ORDER BY name ASC').all()).map(r => r.name);
    }

    // Every tag with how many entities apply it directly (a 'tag' connection
    // pointing at the tag's node). Inherited occurrences are derived elsewhere and
    // deliberately not counted here — this is "where is this tag actually set".
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

    // Removes a Tag whose node no longer has any 'tag' connection pointing to it,
    // so tags with zero references stop showing up in getAllTags()/list_tags.
    // Deleting the Tags row cascades to its Node (AFTER DELETE trigger) and to any
    // InheritedTags via tag_id ON DELETE CASCADE.
    async deleteTagIfOrphaned(tagNodeId) {
        const { tagConnTypeId } = await this._typeIds();
        const remaining = await this.db.prepare(
            "SELECT 1 FROM Connections WHERE destiny_id = ? AND type_id = ? LIMIT 1"
        ).get(tagNodeId, tagConnTypeId);
        if (!remaining) {
            await this.db.prepare("DELETE FROM Tags WHERE node_id = ?").run(tagNodeId);
        }
    }

    // --- Media ---

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

    // Re-points a single media row after its file has been carried to another
    // folder. Keyed on the old absolute path because the hash is unchanged by a
    // move — the bytes are identical, only the location moved.
    async updateMediaPath(oldAbsPath, newRelPath, newAbsPath) {
        return this.db.prepare('UPDATE Media SET relative_path = ?, absolute_path = ? WHERE absolute_path = ?')
            .run(newRelPath, newAbsPath, oldAbsPath);
    }

    // Prefix-rewrites every media row beneath a folder that was moved or renamed.
    // A folder carries its own media/ dir along on disk, so the files are fine —
    // it is only the derived index that would otherwise keep the stale paths.
    async cascadeMediaPaths(oldRelPath, newRelPath, oldAbsPath, newAbsPath) {
        this.db.prepare(`UPDATE Media SET relative_path = ? || substr(relative_path, length(?) + 1), absolute_path = ? || substr(absolute_path, length(?) + 1) WHERE absolute_path LIKE ? || '%' ESCAPE '\\'`)
            .run(newRelPath, oldRelPath, newAbsPath, oldAbsPath, this._escapeLike(oldAbsPath));
    }

    // --- Subscriptions ---

    async getSubscription(magazineId) {
        return await this.db.prepare('SELECT * FROM Subscriptions WHERE magazine_id = ?').get(magazineId);
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

    // --- Path Mutations ---

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

    async getFoldersByAbsPathPrefix(absPrefix, excludeAbsPath) {
        return this.db.prepare(`SELECT absolute_path, relative_path FROM Folders WHERE absolute_path LIKE ? || '%' ESCAPE '\\' AND absolute_path != ?`)
            .all(this._escapeLike(absPrefix), excludeAbsPath);
    }

    // --- Connections ---

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

    // --- Search & Graph ---

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

    // Unified search across all entity types.
    // - Global mode (only q): returns { folders, documents, flashcards, tags, decks }
    // - Filter mode (tag/deck/document/folder): returns { flashcards } matching all supplied filters
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
        // The progress join sits in the FROM clause, so its bind falls between the CTEs and
        // the WHERE filters.
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

    // --- Presence ---

    // Feeds Documents.presence, which is a STORED, sidecar-mirrored field and therefore the
    // owner's: `presence` travels with the document and is part of what the canonical layer
    // says about it. So this one takes a scope like everything else but its caller always
    // passes the owner — a reader's grade must not rewrite what the sidecar claims.
    // The live graph rollups below are the per-caller counterpart.
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

    // --- Inheritance ---

    async getHierarchyTypeId() {
        return { id: (await this._typeIds()).inheritanceTypeId };
    }

    // Inherited tags reach a node through two connection types: 'inheritance'
    // (folder/document → child) and 'deck' (deck → member card). Only card nodes
    // are ever the destiny of a 'deck' connection, so broadening the filter never
    // adds tags to documents/folders — it just lets a deck's tags flow to its
    // cards. DISTINCT dedupes a tag a card inherits from both its document and a deck.
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

    // The graph shades every node by how well it is known, which is a fact about the VIEWER,
    // not about the vault — so all three CARD_LEARNED_SQL rollups read that person's progress.
    //
    // `presence` is the exception on this same query and stays as it is: it is a stored,
    // sidecar-mirrored field belonging to the document itself (see getFlashcardAvgLevel).
    // The live rollups answer "how well do I know this"; presence answers "what does the
    // canonical layer record about it".
    //
    // Three binds, in the order the joins appear in the statement: the folder_rollup CTE,
    // then the per-card join, then the per-document subquery. All three are the same value,
    // so the order is documentation rather than a trap — but it stops being the same value
    // the day someone adds a second scope to this query.
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

    // --- Document Links ---

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

    // Resolved flashback:// link edges for one document, both directions.
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

    // --- Decks ---

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

    // Stores a deck's tags as InheritedTags on the deck → card connection, so they
    // flow to the card via getInheritedTagNames without touching the card's own
    // document-inheritance connection. Removing the card from the deck (or deleting
    // the deck) drops the connection, and InheritedTags cascades on connection_id.
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
            // COALESCE, not `p.level = ?`: filtering for box 0 must return the new-card pile,
            // and those cards have no progress row for this person at all.
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

    async getAllFlashcards({ search = null, level = null, cardType = null, origin = null, flagged = false, flagKind = null, sortBy = 'level', sortDir = 'desc', limit = 50, offset = 0 } = {}, scope) {
        const account = scoped(scope);
        const { where, params } = this._flashcardFilters({ search, level, cardType, origin, flagged, flagKind }, account);
        const sortCols = {
            level: 'p.level', name: 'f.name', last_recall: 'p.last_recall',
            lapses: 'p.fsrs_lapses', difficulty: 'p.fsrs_difficulty',
        };
        const sortCol = sortCols[sortBy] ?? 'p.level';
        const dir = sortDir === 'asc' ? 'ASC' : 'DESC';
        // fsrs_difficulty is only set once a card has been rated under FSRS, so
        // sorting by it must sink the unrated cards to the bottom in BOTH
        // directions — SQLite would otherwise float every NULL to the top of the
        // ascending ("easiest first") page and bury the real answer.
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

    async getFlashcardCountFiltered({ search = null, level = null, cardType = null, origin = null, flagged = false, flagKind = null } = {}, scope) {
        const account = scoped(scope);
        const { where, params } = this._flashcardFilters({ search, level, cardType, origin, flagged, flagKind }, account);
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

    // Every deck holding this card. DeckEntries key on card_hash rather than a
    // Flashcards foreign key, so deleting a card cascades nothing here — callers
    // that destroy a card must walk this list and unlink it deck by deck (each deck
    // also has a canonical JSON file to rewrite). See decks.removeCardEverywhere.
    // `is_system` matters to callers deciding whether a card is "shared": every
    // standalone card lives in the system deck by definition, so counting it as a
    // second owner would make every imported card look shared.
    async getDecksContainingCard(cardHash) {
        return await this.db.prepare(`
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
    async getFlashcardAnswerSamples(limit = 2000) {
        return await this.db.prepare(`
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
    async getRecentReviewSessionRows(since, scope) {
        return await this.db.prepare(`
            SELECT id, flashcard_id, timestamp, outcome
            FROM ReviewLogs
            WHERE outcome IS NOT NULL AND account_id = ? AND timestamp >= ?
            ORDER BY timestamp ASC, id ASC
        `).all(scoped(scope), since);
    }

    // A verdict is about how the card is BUILT, but its evidence is one person's interval
    // trajectory — so the watermark and the flags are per (card, person). Two people can be at
    // different points in the same card's analysis, and one person's dismissal is not
    // everyone's. An edit needs no cross-account bump: each row compares against the card's
    // current content_fingerprint on its own next evaluation.
    async getCardHealth(flashcardId, scope) {
        return await this.db.prepare(
            'SELECT * FROM CardHealth WHERE flashcard_id = ? AND account_id = ?'
        ).get(flashcardId, scoped(scope)) ?? null;
    }

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

    // Only the fingerprint changed (the card was re-evaluated without being addressed).
    async setCardHealthFingerprint(flashcardId, contentFingerprint, scope) {
        return await this.db.prepare(
            'UPDATE CardHealth SET content_fingerprint = ?, updated_at = ? WHERE flashcard_id = ? AND account_id = ?'
        ).run(contentFingerprint, new Date().toISOString(), flashcardId, scoped(scope));
    }

    async getCardFlags(flashcardId, { includeDismissed = false } = {}, scope) {
        const filter = includeDismissed ? '' : ' AND dismissed_at IS NULL';
        return await this.db.prepare(
            `SELECT * FROM CardFlags WHERE flashcard_id = ? AND account_id = ?${filter} ORDER BY detected_at DESC`
        ).all(flashcardId, scoped(scope));
    }

    // Re-raising refreshes a flag's evidence in place rather than stacking duplicates
    // (UNIQUE(flashcard_id, account_id, kind)). `dismissed_at` is deliberately NOT
    // overwritten: a flag the user has already ruled on stays suppressed while its numbers
    // stay current.
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

    // `kinds` limits the delete to specific signatures (used when a guard fires and the
    // now-unsupported mouthful/probe verdicts must be withdrawn). Omit it to clear all.
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

    // --- Deliberately cross-account ---
    //
    // The two below take NO scope, and that is the point: they are the edit hook. When a
    // card's content changes, every account's verdict about it is about a card that no longer
    // exists, so every account's flags go and every account's watermark moves. The fingerprint
    // check in buildContext would reach the same state one failure at a time; these make it
    // happen the moment the user saves, for everyone, instead of leaving a reader staring at a
    // verdict on text they can see has been rewritten.
    async deleteAllCardFlags(flashcardId) {
        return (await this.db.prepare('DELETE FROM CardFlags WHERE flashcard_id = ?').run(flashcardId)).changes;
    }

    // Stamps a new epoch and fingerprint on every account that has ever been analysed on this
    // card, and seeds the owner's row when there is none — so a card edited before anyone
    // reviewed it still records the fingerprint it was edited to.
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

    async dismissCardFlag(flashcardId, kind, scope) {
        return (await this.db.prepare(
            'UPDATE CardFlags SET dismissed_at = ? WHERE flashcard_id = ? AND account_id = ? AND kind = ?'
        ).run(new Date().toISOString(), flashcardId, scoped(scope), kind)).changes;
    }

    // --- Doctor / Reconciliation ---

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

    // Rebuild only: a card's SM-2 ease factor lives in its latest ReviewLogs row
    // (see getLatestEaseFactors), so recovery re-seeds one synthetic log entry per
    // card. outcome is NULL to mark it as synthetic rather than a real review.
    async insertSyntheticReviewLog(flashcardId, easeFactor, level, scope) {
        await this.db.prepare(`
            INSERT INTO ReviewLogs (flashcard_id, account_id, timestamp, outcome, ease_factor, level)
            VALUES (?, ?, datetime('now'), NULL, ?, ?)
        `).run(flashcardId, scoped(scope), easeFactor, level ?? 0);
    }

    // Deletes all rows derived from the canonical layer, keeping reference data
    // (NodeTypes, ConnectionTypes, PedagogicalCategories, SchemaVersion) and
    // Subscriptions. Order respects FKs; entity-delete triggers clean up
    // FlashcardContent/FlashcardReference, and the final Nodes sweep is safe
    // because every table referencing node_id has just been emptied.
    async wipeDerivedContent() {
        await this.db.transaction(async () => {
            await this.db.prepare('DELETE FROM DeckEntries').run();
            await this.db.prepare('DELETE FROM InheritedTags').run();
            // Card health is derived from ReviewLogs, which this wipe destroys — so the
            // flags must go with it rather than outlive the evidence that earned them.
            // Cards re-earn them from new review behaviour. (The FK would cascade from
            // Flashcards anyway; explicit here so the ordering is intentional.)
            await this.db.prepare('DELETE FROM CardFlags').run();
            await this.db.prepare('DELETE FROM CardHealth').run();
            await this.db.prepare('DELETE FROM ReviewLogs').run();
            // Every schedule in the vault, everybody's. Derived by definition — the owner's
            // comes back from the sidecars during the rebuild, and every other account's is
            // re-projected from the accounts store's AccountProgress. This is exactly the
            // step that makes those two canonical homes load-bearing rather than decorative.
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

    // Highest applied schema migration. Half of the pair a client compares before trusting
    // a vault it did not open itself (the other half is getCanonicalVersions()); served by
    // GET /api/vault. Returns 0 on a database whose migrations have never run.
    async getSchemaVersion() {
        const row = await this.db.prepare('SELECT MAX(version) AS version FROM SchemaVersion').get();
        return row?.version ?? 0;
    }

    async recordCanonicalVersion(version, description = null) {
        await this.db.prepare(
            'INSERT OR REPLACE INTO CanonicalVersion (version, description) VALUES (?, ?)'
        ).run(version, description);
    }

    // --- Highlights ---

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

    // Distinct workspace documents that currently have at least one highlight —
    // the vault-wide entry point for highlight listings (the per-document
    // detail always comes from the sidecar, the canonical layer).
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

    // --- Pedagogical Categories ---

    async getCategories() {
        return await this.db.prepare(
            'SELECT id, name, priority, description FROM PedagogicalCategories ORDER BY priority ASC, name ASC'
        ).all();
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

export default new DocumentQuery();
