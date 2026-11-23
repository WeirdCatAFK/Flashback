import db from '../../primitives/database.js';
import * as nodeRows from './nodes.js';

export async function upsertQueue(sourceHash, targetHash, anchorText) {
    return await db.prepare(
        'INSERT OR IGNORE INTO DocumentLinks (source_hash, target_hash, anchor_text) VALUES (?, ?, ?)'
    ).run(sourceHash, targetHash, anchorText ?? '');
}

export async function getPendingForTarget(targetHash) {
    return await db.prepare('SELECT * FROM DocumentLinks WHERE target_hash = ?').all(targetHash);
}

export async function getPendingFromSource(sourceHash) {
    return await db.prepare('SELECT * FROM DocumentLinks WHERE source_hash = ?').all(sourceHash);
}

export async function deleteQueueBySource(sourceHash) {
    return await db.prepare('DELETE FROM DocumentLinks WHERE source_hash = ?').run(sourceHash);
}

export async function deleteConnections(nodeId) {
    const { linkConnTypeId } = await nodeRows.typeIds();
    if (!linkConnTypeId) return;
    return await db.prepare(
        'DELETE FROM Connections WHERE origin_id = ? AND type_id = ?'
    ).run(nodeId, linkConnTypeId);
}

export async function insertConnection(sourceNodeId, targetNodeId) {
    const { linkConnTypeId } = await nodeRows.typeIds();
    if (!linkConnTypeId) throw new Error('link ConnectionType missing — run migrations');
    return await db.prepare(
        'INSERT INTO Connections (origin_id, destiny_id, type_id) VALUES (?, ?, ?)'
    ).run(sourceNodeId, targetNodeId, linkConnTypeId);
}

export async function getEdges(nodeId) {
    const { linkConnTypeId } = await nodeRows.typeIds();
    if (!linkConnTypeId) return { outgoing: [], backlinks: [] };
    const outgoing = await db.prepare(`
        SELECT d.name, d.relative_path AS path, d.global_hash
        FROM Connections c JOIN Documents d ON d.node_id = c.destiny_id
        WHERE c.origin_id = ? AND c.type_id = ?
    `).all(nodeId, linkConnTypeId);
    const backlinks = await db.prepare(`
        SELECT d.name, d.relative_path AS path, d.global_hash
        FROM Connections c JOIN Documents d ON d.node_id = c.origin_id
        WHERE c.destiny_id = ? AND c.type_id = ?
    `).all(nodeId, linkConnTypeId);
    return { outgoing, backlinks };
}

export async function getPendingCount() {
    return (await db.prepare('SELECT COUNT(*) as c FROM DocumentLinks').get()).c;
}
