import db from '../../primitives/database.js';
import { escapeLike } from './sql.js';

export async function getByHash(hash) {
    return await db.prepare('SELECT * FROM Folders WHERE global_hash = ?').get(hash);
}

export async function getByPath(relPath) {
    return await db.prepare('SELECT * FROM Folders WHERE relative_path = ?').get(relPath);
}

export async function insert(data) {
    const stmt = db.prepare(`
        INSERT INTO Folders (node_id, global_hash, parent_id, relative_path, absolute_path, name, presence)
        VALUES (?, ?, ?, ?, ?, ?, 0)
    `);
    return await stmt.run(data.nodeId, data.globalHash, data.parentId ?? null, data.relativePath, data.absolutePath, data.name);
}

export async function getByAbsolutePath(absPath) {
    return await db.prepare('SELECT * FROM Folders WHERE absolute_path = ?').get(absPath);
}

export async function getByNodeId(nodeId) {
    return await db.prepare('SELECT * FROM Folders WHERE node_id = ?').get(nodeId);
}

export async function getParentId(folderId) {
    return await db.prepare('SELECT parent_id FROM Folders WHERE id = ?').get(folderId);
}

export async function getChildren(parentId) {
    return await db.prepare('SELECT id, node_id, relative_path, absolute_path FROM Folders WHERE parent_id = ?').all(parentId);
}

export async function updateMetadata(id, data) {
    if (data.globalHash) {
        await db.prepare('UPDATE Folders SET global_hash = ? WHERE id = ?').run(data.globalHash, id);
    }
}

export async function getByPaths(relPaths) {
    if (relPaths.length === 0) return [];
    const placeholders = relPaths.map(() => '?').join(', ');
    return await db.prepare(`SELECT * FROM Folders WHERE relative_path IN (${placeholders})`).all(...relPaths);
}

export async function rename(newName, newRelPath, newAbsPath, oldAbsPath) {
    db.prepare('UPDATE Folders SET name = ?, relative_path = ?, absolute_path = ? WHERE absolute_path = ?')
        .run(newName, newRelPath, newAbsPath, oldAbsPath);
}

export async function cascadeRenamePaths(oldRelPath, newRelPath, oldAbsPath, newAbsPath) {
    db.prepare(`UPDATE Folders SET relative_path = ? || substr(relative_path, length(?) + 1), absolute_path = ? || substr(absolute_path, length(?) + 1) WHERE absolute_path LIKE ? || '%' ESCAPE '\\'`)
        .run(newRelPath, oldRelPath, newAbsPath, oldAbsPath, escapeLike(oldAbsPath));
}

export async function move(newRelPath, newAbsPath, oldAbsPath, newParentId) {
    db.prepare('UPDATE Folders SET relative_path = ?, absolute_path = ?, parent_id = ? WHERE absolute_path = ?')
        .run(newRelPath, newAbsPath, newParentId ?? null, oldAbsPath);
}

export async function deleteTree(absPath, sep) {
    db.prepare(`DELETE FROM Folders WHERE absolute_path = ? OR absolute_path LIKE ? ESCAPE '\\'`)
        .run(absPath, escapeLike(absPath) + sep + '%');
}

export async function getByAbsPathPrefix(absPrefix, excludeAbsPath) {
    return db.prepare(`SELECT absolute_path, relative_path FROM Folders WHERE absolute_path LIKE ? || '%' ESCAPE '\\' AND absolute_path != ?`)
        .all(escapeLike(absPrefix), excludeAbsPath);
}

export async function getNodeIdByAbsPath(absPath) {
    const row = await db.prepare('SELECT node_id FROM Folders WHERE absolute_path = ?').get(absPath);
    return row ? row.node_id : null;
}

export async function getById(folderId) {
    return await db.prepare('SELECT * FROM Folders WHERE id = ?').get(folderId);
}

export async function getChildPresences(parentId) {
    return await db.prepare('SELECT presence FROM Folders WHERE parent_id = ?').all(parentId);
}

export async function updatePresence(folderId, presence) {
    return await db.prepare('UPDATE Folders SET presence = ? WHERE id = ?').run(presence, folderId);
}

export async function getAll() {
    return await db.prepare('SELECT id, parent_id, node_id, global_hash, relative_path, absolute_path, name FROM Folders').all();
}
