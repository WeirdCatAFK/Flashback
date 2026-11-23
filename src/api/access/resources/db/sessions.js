import db from '../../primitives/database.js';
import { PROGRESS_JOIN, scoped } from './sql.js';
import * as nodeRows from './nodes.js';

export async function getFacets(hashes) {
    const facets = new Map();
    if (!hashes?.length) return facets;

    const { tagConnTypeId, linkConnTypeId, inheritanceTypeId, deckConnTypeId } = await nodeRows.typeIds();
    const marks = (arr) => arr.map(() => '?').join(', ');

    const base = await db.prepare(`
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
        const direct = await db.prepare(`
            SELECT c.origin_id AS nodeId, t.name AS name
            FROM Connections c
            JOIN Tags t ON t.node_id = c.destiny_id
            WHERE c.origin_id IN (${nodeMarks}) AND c.type_id = ?
        `).all(...nodeIds, tagConnTypeId);
        const inherited = await db.prepare(`
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

    const deckRows = await db.prepare(`
        SELECT de.card_hash AS globalHash, de.deck_id AS deckId
        FROM DeckEntries de
        WHERE de.card_hash IN (${marks(hashes)})
    `).all(...hashes);
    for (const row of deckRows) facets.get(row.globalHash)?.deckIds.add(row.deckId);

    const docNodeIds = [...new Set(base.map(r => r.docNodeId).filter(id => id != null))];
    if (docNodeIds.length > 0 && linkConnTypeId) {
        const docNodeMarks = marks(docNodeIds);
        const links = await db.prepare(`
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
            for (const row of await db.prepare(
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
        (await db.prepare('SELECT id, parent_id AS parentId FROM Folders').all())
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

export async function getReviewOrder(sessionId, scope) {
    return await db.prepare(`
        SELECT rl.session_position AS position, rl.card_hash AS globalHash
        FROM progress.ReviewLogs rl
        WHERE rl.session_id = ? AND rl.account_id = ?
        ORDER BY rl.session_position ASC, rl.id ASC
    `).all(sessionId, scoped(scope));
}

export async function getDue({
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

    const allRows = await db.prepare(`
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
