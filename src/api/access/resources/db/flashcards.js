import db from '../../primitives/database.js';
import { LIVE_ANCHOR_SQL, PROGRESS_JOIN, cardMatchSql, carriesTagSql, highlightAnchor, scoped } from './sql.js';
import * as cardProgressRows from './cardProgress.js';

export async function getByDocument(documentId, scope) {
    return await db.prepare(`
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

export async function getCountsByFolder(folderId) {
    return await db.prepare(`
        SELECT d.name, COUNT(fc.id) AS count
        FROM Documents d
        LEFT JOIN Flashcards fc ON fc.document_id = d.id
        WHERE d.folder_id = ?
        GROUP BY d.id
    `).all(folderId);
}

export async function getCountsInFolderTrees(folderIds) {
    if (folderIds.length === 0) return new Map();
    const placeholders = folderIds.map(() => '?').join(', ');
    const rows = await db.prepare(`
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

export async function insert(data, scope) {
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

    const contentStmt = db.prepare(`
        INSERT INTO FlashcardContent (custom_html, frontText, backText, answerText, front_img, back_img, front_sound, back_sound)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const contentInfo = await contentStmt.run(customHtml, frontText, backText, answerText, fImg, bImg, fSnd, bSnd);

    let referenceId = null;
    if (data.vanillaData?.location) {
        const loc = data.vanillaData.location;
        const d = loc.data || {};
        const bboxJson = d.bbox ? JSON.stringify(d.bbox) : null;
        const refStmt = db.prepare(`
            INSERT INTO FlashcardReference (type, start, end, page, bbox) VALUES (?, ?, ?, ?, ?)
        `);
        const refInfo = await refStmt.run(loc.type, d.start || null, d.end || null, d.page || null, bboxJson);
        referenceId = refInfo.lastInsertRowid;
    }

    let categoryId = null;
    if (data.category) {
        const cat = await db.prepare("SELECT id FROM PedagogicalCategories WHERE name = ?").get(data.category);
        if (cat) categoryId = cat.id;
    }

    const stmt = db.prepare(`
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

    await cardProgressRows.write(info.lastInsertRowid, scope, data);
    return info;
}

export async function update(id, data, scope) {
    let categoryId = null;
    if (data.category) {
        const cat = await db.prepare("SELECT id FROM PedagogicalCategories WHERE name = ?").get(data.category);
        if (cat) categoryId = cat.id;
    }

    await db.prepare(`
        UPDATE Flashcards
        SET category_id = ?, name = ?, fileIndex = ?, card_type = ?, origin = ?
        WHERE id = ?
    `).run(
        categoryId, data.name || null, data.fileIndex, data.cardType || 'basic', data.origin || null, id,
    );
    if (data.vanillaData !== undefined) {
        await db.prepare('UPDATE Flashcards SET highlight_hash = ? WHERE id = ?').run(highlightAnchor(data), id);
    }

    await cardProgressRows.write(id, scope, data);

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
        await db.prepare(`UPDATE FlashcardContent SET ${contentUpdates.join(', ')} WHERE id = ?`).run(...params);
    }
}

export async function remove(id) {
    await db.prepare('DELETE FROM Flashcards WHERE id = ?').run(id);
}

export async function getByHash(hash) {
    return await db.prepare('SELECT id, document_id FROM Flashcards WHERE global_hash = ?').get(hash);
}

export async function getContentByHash(hash, scope) {
    return await db.prepare(`
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

export async function getCount() {
    return (await db.prepare('SELECT COUNT(*) as c FROM Flashcards').get()).c;
}

export async function getNodeIds(documentId) {
    return await db.prepare('SELECT node_id FROM Flashcards WHERE document_id = ?').all(documentId);
}

export async function getNodeIdByHash(cardHash) {
    const row = await db.prepare('SELECT node_id FROM Flashcards WHERE global_hash = ?').get(cardHash);
    return row?.node_id ?? null;
}

function originCondition(origin, conditions) {
    if (origin === 'ai' || origin === 'import') conditions.push(`f.origin = '${origin}'`);
    else if (origin === 'human') conditions.push('f.origin IS NULL');
}

function filterClause({ search, level, cardType, origin, flagged, flagKind, source = null, tag = null, categoryId = null, anchor = null }, scope) {
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
        const match = cardMatchSql(search);
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
    originCondition(origin, conditions);
    if (anchor === 'none') conditions.push('f.highlight_hash IS NULL');
    else if (anchor === 'highlight' || anchor === 'missing') {
        conditions.push(`f.highlight_hash IS NOT NULL AND ${anchor === 'missing' ? 'NOT ' : ''}EXISTS (${LIVE_ANCHOR_SQL})`);
    }

    if (tag) {
        conditions.push(carriesTagSql());
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

function catalogueSelect() {
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

function catalogueOrder(sortBy, sortDir) {
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

export async function getHashesFiltered(filters = {}, scope, { sortBy = 'created', sortDir = 'asc' } = {}) {
    const account = scoped(scope);
    const { where, params } = filterClause(filters, account);
    return await db.prepare(`
        SELECT f.global_hash, f.name, p.last_recall, REPLACE(d.relative_path, '\\', '/') AS document_path
        FROM Flashcards f ${PROGRESS_JOIN()}
        JOIN FlashcardContent c ON f.content_id = c.id
        LEFT JOIN Documents d ON f.document_id = d.id
        ${where}
        ORDER BY ${catalogueOrder(sortBy, sortDir)}
    `).all(account, ...params);
}

export async function getByHashes(hashes, scope) {
    if (!hashes.length) return [];
    const account = scoped(scope);
    const rows = await db.prepare(`
        ${catalogueSelect()}
        WHERE f.global_hash IN (SELECT value FROM json_each(?))
    `).all(account, account, JSON.stringify(hashes));
    const byHash = new Map(rows.map((r) => [r.global_hash, r]));
    return hashes.map((h) => byHash.get(h)).filter(Boolean);
}

export async function getDocumentPaths() {
    return await db.prepare(`
        SELECT f.global_hash, REPLACE(d.relative_path, '\\', '/') AS document_path
        FROM Flashcards f LEFT JOIN Documents d ON f.document_id = d.id
    `).all();
}

export async function getAll({ search = null, level = null, cardType = null, origin = null, flagged = false, flagKind = null, source = null, tag = null, categoryId = null, anchor = null, sortBy = 'level', sortDir = 'desc', limit = 50, offset = 0 } = {}, scope) {
    const account = scoped(scope);
    const { where, params } = filterClause({ search, level, cardType, origin, flagged, flagKind, source, tag, categoryId, anchor }, account);
    return await db.prepare(`
        ${catalogueSelect()}
        ${where}
        ORDER BY ${catalogueOrder(sortBy, sortDir)}
        LIMIT ? OFFSET ?
    `).all(account, account, ...params, limit, offset);
}

export async function getCountFiltered({ search = null, level = null, cardType = null, origin = null, flagged = false, flagKind = null, source = null, tag = null, categoryId = null, anchor = null } = {}, scope) {
    const account = scoped(scope);
    const { where, params } = filterClause({ search, level, cardType, origin, flagged, flagKind, source, tag, categoryId, anchor }, account);
    const contentJoin = search ? 'JOIN FlashcardContent c ON f.content_id = c.id' : '';

    return (await db.prepare(`
        SELECT COUNT(*) as c FROM Flashcards f ${PROGRESS_JOIN()} ${contentJoin} ${where}
    `).get(account, ...params)).c;
}

export async function updateContentByHash(hash, { frontText, backText, answerText, name, cardType, category, customHtml }) {
    const card = await db.prepare('SELECT id, content_id FROM Flashcards WHERE global_hash = ?').get(hash);
    if (!card) return false;
    let categoryId = null;
    if (category) {
        const cat = await db.prepare("SELECT id FROM PedagogicalCategories WHERE name = ?").get(category);
        if (cat) categoryId = cat.id;
    }
    db.prepare('UPDATE Flashcards SET name = ?, card_type = ?, category_id = ? WHERE id = ?')
        .run(name || null, cardType || 'basic', categoryId, card.id);
    db.prepare('UPDATE FlashcardContent SET frontText = ?, backText = ?, answerText = ?, custom_html = ? WHERE id = ?')
        .run(frontText || null, backText || null, answerText || null, customHtml || null, card.content_id);
    return true;
}

export async function getAnswerSamples(limit = 2000) {
    return await db.prepare(`
        SELECT f.card_type, c.backText, c.answerText, c.custom_html
        FROM Flashcards f
        JOIN FlashcardContent c ON f.content_id = c.id
        WHERE c.backText IS NOT NULL OR c.answerText IS NOT NULL OR c.custom_html IS NOT NULL
        LIMIT ?
    `).all(limit);
}

export async function getStandaloneCount() {
    return (await db.prepare('SELECT COUNT(*) as c FROM Flashcards WHERE document_id IS NULL').get()).c;
}

export async function backfillTypeAnswerAnswerText() {
    return (await db.prepare(`
        UPDATE FlashcardContent
           SET answerText = backText,
               backText   = NULL
         WHERE answerText IS NULL
           AND id IN (SELECT content_id FROM Flashcards WHERE card_type = 'type_answer')
    `).run()).changes;
}

export async function getMissingHighlightHash() {
    return await db.prepare(`
        SELECT f.id, f.global_hash, d.relative_path
        FROM Flashcards f
        JOIN FlashcardReference r ON r.id = f.reference_id
        JOIN Documents d ON d.id = f.document_id
        WHERE r.type = 'highlight' AND f.highlight_hash IS NULL
    `).all();
}

export async function setHighlightHash(id, highlightHash) {
    return await db.prepare('UPDATE Flashcards SET highlight_hash = ? WHERE id = ?').run(highlightHash, id);
}
