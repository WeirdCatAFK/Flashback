import db from '../../primitives/database.js';
import { PROGRESS_JOIN, scoped } from './sql.js';
import * as nodeRows from './nodes.js';
import * as tagRows from './tags.js';

export async function insert(data) {
    const { deckNodeTypeId } = await nodeRows.typeIds();
    if (!deckNodeTypeId) throw new Error('Deck node type missing — run migrations');
    const nodeInfo = await db.prepare('INSERT INTO Nodes (type_id) VALUES (?)').run(deckNodeTypeId);
    const nodeId = nodeInfo.lastInsertRowid;
    const info = await db.prepare(`
        INSERT INTO Decks (node_id, global_hash, name, description, is_system)
        VALUES (?, ?, ?, ?, ?)
    `).run(nodeId, data.globalHash, data.name, data.description ?? null, data.isSystem ?? 0);
    return info.lastInsertRowid;
}

export async function getByHash(hash) {
    return await db.prepare('SELECT id, node_id, global_hash, name, description, is_system, created_at, updated_at FROM Decks WHERE global_hash = ?').get(hash);
}

export async function getSystem() {
    return await db.prepare('SELECT id, node_id, global_hash, name, description, is_system, created_at, updated_at FROM Decks WHERE is_system = 1 LIMIT 1').get();
}

export async function insertConnection(deckNodeId, cardNodeId) {
    const { deckConnTypeId } = await nodeRows.typeIds();
    if (!deckConnTypeId) return;
    await db.prepare(
        'INSERT INTO Connections (origin_id, destiny_id, type_id) VALUES (?, ?, ?)'
    ).run(deckNodeId, cardNodeId, deckConnTypeId);
}

export async function deleteConnection(deckNodeId, cardNodeId) {
    const { deckConnTypeId } = await nodeRows.typeIds();
    if (!deckConnTypeId) return;
    await db.prepare(
        'DELETE FROM Connections WHERE origin_id = ? AND destiny_id = ? AND type_id = ?'
    ).run(deckNodeId, cardNodeId, deckConnTypeId);
}

export async function setConnectionInheritedTags(deckNodeId, cardNodeId, tagIds) {
    const { deckConnTypeId } = await nodeRows.typeIds();
    if (!deckConnTypeId) return;
    const conn = await nodeRows.getOrCreateConnection(deckNodeId, cardNodeId, deckConnTypeId);
    await tagRows.clearInherited(conn.id);
    for (const tagId of tagIds) await tagRows.insertInherited(conn.id, tagId);
}

export async function getAll() {
    return await db.prepare(`
        SELECT d.*, COUNT(e.id) as entry_count
        FROM Decks d
        LEFT JOIN DeckEntries e ON e.deck_id = d.id
        GROUP BY d.id
        ORDER BY d.updated_at DESC
    `).all();
}

export async function getAllEntryHashes() {
    return await db.prepare('SELECT deck_id, card_hash FROM DeckEntries').all();
}

export async function update(id, data) {
    await db.prepare(`
        UPDATE Decks SET name = ?, description = ?, updated_at = datetime('now')
        WHERE id = ?
    `).run(data.name, data.description ?? null, id);
}

export async function remove(id) {
    await db.prepare('DELETE FROM Decks WHERE id = ?').run(id);
}

export async function insertEntry(data) {
    return await db.prepare(`
        INSERT INTO DeckEntries (deck_id, card_hash, document_path, position, inline_card)
        VALUES (?, ?, ?, ?, ?)
    `).run(data.deckId, data.cardHash, data.documentPath ?? null, data.position ?? 0, data.inlineCard ?? null);
}

export async function getEntries(deckId, scope) {
    return await db.prepare(`
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

export async function getEntryByCardHash(deckId, cardHash) {
    return await db.prepare('SELECT id FROM DeckEntries WHERE deck_id = ? AND card_hash = ?').get(deckId, cardHash);
}

export async function deleteEntry(deckId, cardHash) {
    await db.prepare('DELETE FROM DeckEntries WHERE deck_id = ? AND card_hash = ?').run(deckId, cardHash);
}

export async function getEntryCount(deckId) {
    return (await db.prepare('SELECT COUNT(*) as c FROM DeckEntries WHERE deck_id = ?').get(deckId)).c;
}

export async function deleteCardEntries(cardHash) {
    return await db.prepare('DELETE FROM DeckEntries WHERE card_hash = ?').run(cardHash);
}

export async function getContainingCard(cardHash) {
    return await db.prepare(`
        SELECT d.id, d.global_hash, d.name, d.is_system
        FROM DeckEntries e
        JOIN Decks d ON d.id = e.deck_id
        WHERE e.card_hash = ?
    `).all(cardHash);
}

export async function updateEntryInlineCard(deckId, cardHash, inlineCard) {
    db.prepare('UPDATE DeckEntries SET inline_card = ? WHERE deck_id = ? AND card_hash = ?')
        .run(inlineCard, deckId, cardHash);
}

export async function hasSystemColumn() {
    const cols = await db.prepare('PRAGMA table_info(Decks)').all();
    return cols.some((c) => c.name === 'is_system');
}
