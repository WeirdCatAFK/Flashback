import db from '../../primitives/database.js';
import { escapeLike } from './sql.js';

export async function getInFolder(folderId) {
    return await db.prepare('SELECT id, node_id, relative_path FROM Documents WHERE folder_id = ?').all(folderId);
}

export async function getByPath(relPath) {
    return await db.prepare('SELECT * FROM Documents WHERE relative_path = ?').get(relPath);
}

export async function insert(data) {
    const stmt = db.prepare(`
        INSERT INTO Documents (folder_id, node_id, global_hash, relative_path, absolute_path, name, encoding, presence)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0)
    `);
    const info = await stmt.run(data.folderId, data.nodeId, data.globalHash, data.relativePath, data.absolutePath, data.name, data.encoding ?? null);
    return info;
}

export async function updateMetadata(id, data) {
    if (data.globalHash) {
        await db.prepare('UPDATE Documents SET global_hash = ? WHERE id = ?').run(data.globalHash, id);
    }
}

export async function remove(id) {
    await db.prepare('DELETE FROM Documents WHERE id = ?').run(id);
}

export async function rename(newName, newRelPath, newAbsPath, oldAbsPath) {
    db.prepare('UPDATE Documents SET name = ?, relative_path = ?, absolute_path = ? WHERE absolute_path = ?')
        .run(newName, newRelPath, newAbsPath, oldAbsPath);
}

export async function cascadeRenamePaths(oldRelPath, newRelPath, oldAbsPath, newAbsPath) {
    db.prepare(`UPDATE Documents SET relative_path = ? || substr(relative_path, length(?) + 1), absolute_path = ? || substr(absolute_path, length(?) + 1) WHERE absolute_path LIKE ? || '%' ESCAPE '\\'`)
        .run(newRelPath, oldRelPath, newAbsPath, oldAbsPath, escapeLike(oldAbsPath));
}

export async function move(newFolderId, newRelPath, newAbsPath, oldAbsPath) {
    db.prepare('UPDATE Documents SET folder_id = ?, relative_path = ?, absolute_path = ? WHERE absolute_path = ?')
        .run(newFolderId, newRelPath, newAbsPath, oldAbsPath);
}

export async function deleteByAbsPath(absPath) {
    await db.prepare('DELETE FROM Documents WHERE absolute_path = ?').run(absPath);
}

export async function getByAbsPathPrefix(absPrefix) {
    return db.prepare(`SELECT absolute_path, relative_path FROM Documents WHERE absolute_path LIKE ? || '%' ESCAPE '\\'`)
        .all(escapeLike(absPrefix));
}

export async function getInTree(absPrefix) {
    return db.prepare(`SELECT id, global_hash, relative_path, absolute_path, name
        FROM Documents WHERE absolute_path LIKE ? || '%' ESCAPE '\\'`)
        .all(escapeLike(absPrefix));
}

export async function getByAbsolutePath(absPath) {
    return await db.prepare('SELECT * FROM Documents WHERE absolute_path = ?').get(absPath);
}

export async function getNodeIdByAbsPath(absPath) {
    const row = await db.prepare('SELECT node_id FROM Documents WHERE absolute_path = ?').get(absPath);
    return row ? row.node_id : null;
}

export async function getFolderIdById(documentId) {
    return await db.prepare('SELECT folder_id FROM Documents WHERE id = ?').get(documentId);
}

export async function getPresenceStats(folderId) {
    return await db.prepare('SELECT count(*) as cnt, sum(presence) as total FROM Documents WHERE folder_id = ?').get(folderId);
}

export async function updatePresence(documentId, score) {
    return await db.prepare('UPDATE Documents SET presence = ? WHERE id = ?').run(score, documentId);
}

export async function getByHash(hash) {
    return await db.prepare('SELECT id, node_id, relative_path, name FROM Documents WHERE global_hash = ?').get(hash);
}

export async function getAll() {
    return await db.prepare('SELECT id, folder_id, node_id, global_hash, relative_path, absolute_path, name, encoding FROM Documents').all();
}
