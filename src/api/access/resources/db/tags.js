import db from '../../primitives/database.js';
import * as nodeRows from './nodes.js';

export async function getAll() {
    return (await db.prepare('SELECT DISTINCT name FROM Tags ORDER BY name ASC').all()).map(r => r.name);
}

export async function getWithCounts() {
    const { tagConnTypeId } = await nodeRows.typeIds();
    return await db.prepare(`
        SELECT t.name AS name, COUNT(c.id) AS count
        FROM Tags t
        LEFT JOIN Connections c
          ON c.destiny_id = t.node_id AND c.type_id = ?
        GROUP BY t.node_id, t.name
        ORDER BY count DESC, t.name ASC
    `).all(tagConnTypeId);
}

export async function getOverview() {
    const { tagConnTypeId } = await nodeRows.typeIds();
    const reach = await db.prepare(`
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
    const carried = await db.prepare(`
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

export async function getByName(name) {
    return await db.prepare('SELECT * FROM Tags WHERE name = ?').get(name);
}

export async function insert(name, nodeId) {
    return await db.prepare('INSERT INTO Tags (name, node_id, presence) VALUES (?, ?, 0)').run(name, nodeId);
}

export async function syncNode(nodeId, tagNodeIds) {
    const { tagNodeTypeId, tagConnTypeId } = await nodeRows.typeIds();

    const currentConns = await db.prepare(`
        SELECT c.id, c.destiny_id FROM Connections c
        JOIN Nodes n ON c.destiny_id = n.id
        WHERE c.origin_id = ? AND n.type_id = ? AND c.type_id = ?
    `).all(nodeId, tagNodeTypeId, tagConnTypeId);

    const currentTagIdSet = new Set(currentConns.map(c => c.destiny_id));
    const tagNodeIdSet = new Set(tagNodeIds);

    for (const tid of tagNodeIds) {
        if (!currentTagIdSet.has(tid)) {
            await db.prepare("INSERT INTO Connections (origin_id, destiny_id, type_id) VALUES (?, ?, ?)").run(nodeId, tid, tagConnTypeId);
        }
    }
    for (const conn of currentConns) {
        if (!tagNodeIdSet.has(conn.destiny_id)) {
            await db.prepare("DELETE FROM Connections WHERE id = ?").run(conn.id);
            await deleteIfOrphaned(conn.destiny_id);
        }
    }
}

async function deleteIfOrphaned(tagNodeId) {
    const { tagConnTypeId } = await nodeRows.typeIds();
    const remaining = await db.prepare(
        "SELECT 1 FROM Connections WHERE destiny_id = ? AND type_id = ? LIMIT 1"
    ).get(tagNodeId, tagConnTypeId);
    if (!remaining) {
        await db.prepare("DELETE FROM Tags WHERE node_id = ?").run(tagNodeId);
    }
}

export async function getInheritedNames(nodeId) {
    return (await db.prepare(`
        SELECT DISTINCT t.name FROM InheritedTags it
        JOIN Connections c ON it.connection_id = c.id
        JOIN Tags t ON t.id = it.tag_id
        WHERE c.destiny_id = ?
          AND c.type_id IN (SELECT id FROM ConnectionTypes WHERE name IN ('inheritance', 'deck'))
    `).all(nodeId)).map(t => t.name);
}

export async function getDirectNames(nodeId) {
    const { tagConnTypeId } = await nodeRows.typeIds();
    return (await db.prepare(`
        SELECT t.name FROM Connections c
        JOIN Tags t ON t.node_id = c.destiny_id
        WHERE c.origin_id = ? AND c.type_id = ?
    `).all(nodeId, tagConnTypeId)).map(r => r.name);
}

export async function clearInherited(connectionId) {
    return await db.prepare('DELETE FROM InheritedTags WHERE connection_id = ?').run(connectionId);
}

export async function insertInherited(connectionId, tagId) {
    return await db.prepare('INSERT INTO InheritedTags (connection_id, tag_id) VALUES (?, ?)').run(connectionId, tagId);
}
