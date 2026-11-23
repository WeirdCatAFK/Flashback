import db from '../../primitives/database.js';
import { PROGRESS_JOIN, cardMatchSql, scoped } from './sql.js';

export async function search(query) {
    const term = `%${query}%`;
    const docs = await db.prepare(`SELECT 'document' as type, name, relative_path, global_hash FROM Documents WHERE name LIKE ?`).all(term);
    const cards = await db.prepare(`
        SELECT 'flashcard' as type, f.global_hash, c.frontText, c.backText, c.answerText
        FROM Flashcards f JOIN FlashcardContent c ON f.content_id = c.id
        WHERE c.frontText LIKE ? OR c.backText LIKE ? OR c.answerText LIKE ? OR f.global_hash = ? OR f.name LIKE ?
    `).all(term, term, term, query, term);
    const tags = await db.prepare(`SELECT 'tag' as type, t.name, null as frontText, null as backText, null as answerText FROM Tags t WHERE t.name LIKE ?`).all(term);
    return [...docs, ...cards, ...tags];
}

export async function superSearch({ q = null, tag = null, deck = null, document: docQ = null, folder = null, limit = 20 } = {}, scope) {
    const hasFilter = tag || deck || docQ || folder;
    const probe = limit + 1;
    const cut = (rows) => rows.slice(0, limit);
    if (hasFilter) {
        const flashcards = await searchFlashcards({ q, tag, deck, docQ, folder, limit: probe }, scope);
        return { flashcards: cut(flashcards), truncated: { flashcards: flashcards.length > limit } };
    }

    if (!q || !q.trim()) return { folders: [], documents: [], flashcards: [], tags: [], decks: [], truncated: {} };
    const term = `%${q.trim()}%`;

    const folders = await db.prepare(
        `SELECT name, relative_path as path, global_hash FROM Folders WHERE name LIKE ? LIMIT ?`
    ).all(term, probe);

    const documents = await db.prepare(
        `SELECT name, relative_path as path, global_hash FROM Documents WHERE name LIKE ? LIMIT ?`
    ).all(term, probe);

    const flashcards = await searchFlashcards({ q: q.trim(), limit: probe }, scope);

    const tags = await db.prepare(
        `SELECT name FROM Tags WHERE name LIKE ? LIMIT ?`
    ).all(term, probe);

    const decks = await db.prepare(
        `SELECT name, global_hash FROM Decks WHERE name LIKE ? LIMIT ?`
    ).all(term, probe);

    const groups = { folders, documents, flashcards, tags, decks };
    const truncated = Object.fromEntries(Object.entries(groups).map(([k, rows]) => [k, rows.length > limit]));
    return { ...Object.fromEntries(Object.entries(groups).map(([k, rows]) => [k, cut(rows)])), truncated };
}

async function searchFlashcards({ q = null, tag = null, deck = null, docQ = null, folder = null, limit = 50 } = {}, scope) {
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
        const match = cardMatchSql(q);
        conditions.push(match.sql);
        condParams.push(...match.params);
    }

    const whereSQL = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const allParams = [...cteParams, scoped(scope), ...condParams, limit];

    return await db.prepare(`
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
