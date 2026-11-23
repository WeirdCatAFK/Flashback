import db from '../../primitives/database.js';

let typeCache = null;

export function onVaultOpened() {
    typeCache = null;
}

export async function typeIds() {
    if (!typeCache) {
        const tagNodeType  = await db.prepare("SELECT id FROM NodeTypes WHERE name = 'Tag'").get();
        const deckNodeType = await db.prepare("SELECT id FROM NodeTypes WHERE name = 'Deck'").get();
        const inheritType  = await db.prepare("SELECT id FROM ConnectionTypes WHERE name = 'inheritance'").get();
        const tagConnType  = await db.prepare("SELECT id FROM ConnectionTypes WHERE name = 'tag'").get();
        const deckConnType = await db.prepare("SELECT id FROM ConnectionTypes WHERE name = 'deck'").get();
        const linkConnType = await db.prepare("SELECT id FROM ConnectionTypes WHERE name = 'link'").get();
        typeCache = {
            tagNodeTypeId:  tagNodeType?.id,
            deckNodeTypeId: deckNodeType?.id,
            inheritanceTypeId: inheritType?.id,
            tagConnTypeId:  tagConnType?.id,
            deckConnTypeId: deckConnType?.id,
            linkConnTypeId: linkConnType?.id,
        };
    }
    return typeCache;
}

export async function create(typeName) {
    const type = await db.prepare('SELECT id FROM NodeTypes WHERE name = ?').get(typeName);
    if (!type) throw new Error(`${typeName} node type missing.`);
    const info = await db.prepare('INSERT INTO Nodes (type_id) VALUES (?)').run(type.id);
    return info.lastInsertRowid;
}

export async function insertInheritance(parentNodeId, childNodeId) {
    const typeId = (await typeIds()).inheritanceTypeId;
    if (!typeId) throw new Error('inheritance connection type missing');
    return await db.prepare(
        'INSERT INTO Connections (origin_id, destiny_id, type_id) VALUES (?, ?, ?)'
    ).run(parentNodeId, childNodeId, typeId);
}

export async function deleteInheritance(parentNodeId, childNodeId) {
    const typeId = (await typeIds()).inheritanceTypeId;
    if (!typeId) return;
    await db.prepare(
        'DELETE FROM Connections WHERE origin_id = ? AND destiny_id = ? AND type_id = ?'
    ).run(parentNodeId, childNodeId, typeId);
}

export async function getHierarchyTypeId() {
    return { id: (await typeIds()).inheritanceTypeId };
}

export async function getOrCreateConnection(originId, destId, typeId) {
    let conn = await db.prepare('SELECT id FROM Connections WHERE origin_id = ? AND destiny_id = ? AND type_id = ?').get(originId, destId, typeId);
    if (!conn) {
        const info = await db.prepare('INSERT INTO Connections (origin_id, destiny_id, type_id) VALUES (?, ?, ?)').run(originId, destId, typeId);
        conn = { id: info.lastInsertRowid };
    }
    return conn;
}
