import db from '../../primitives/database.js';
import { escapeLike } from './sql.js';

export async function insert(data) {
    const stmt = db.prepare(`
        INSERT INTO Media (hash, name, relative_path, absolute_path)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(hash) DO UPDATE SET
            relative_path=excluded.relative_path,
            absolute_path=excluded.absolute_path
    `);
    return await stmt.run(data.hash, data.name, data.relativePath, data.absolutePath);
}

export async function getByHash(hash) {
    return await db.prepare('SELECT * FROM Media WHERE hash = ?').get(hash);
}

export async function deleteByAbsPath(absolutePath) {
    return await db.prepare('DELETE FROM Media WHERE absolute_path = ?').run(absolutePath);
}

export async function getByAbsPathPrefix(prefix) {
    return await db.prepare('SELECT * FROM Media WHERE absolute_path LIKE ?').all(prefix + '%');
}

export async function updatePath(oldAbsPath, newRelPath, newAbsPath) {
    return db.prepare('UPDATE Media SET relative_path = ?, absolute_path = ? WHERE absolute_path = ?')
        .run(newRelPath, newAbsPath, oldAbsPath);
}

export async function cascadePaths(oldRelPath, newRelPath, oldAbsPath, newAbsPath) {
    db.prepare(`UPDATE Media SET relative_path = ? || substr(relative_path, length(?) + 1), absolute_path = ? || substr(absolute_path, length(?) + 1) WHERE absolute_path LIKE ? || '%' ESCAPE '\\'`)
        .run(newRelPath, oldRelPath, newAbsPath, oldAbsPath, escapeLike(oldAbsPath));
}

export async function getAll() {
    return await db.prepare('SELECT id, hash, name, relative_path, absolute_path FROM Media').all();
}
