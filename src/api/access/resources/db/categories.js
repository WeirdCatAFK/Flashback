import db from '../../primitives/database.js';

export async function getAll() {
    return await db.prepare(`
        SELECT pc.id, pc.name, pc.priority, pc.description,
               (SELECT COUNT(*) FROM Flashcards f WHERE f.category_id = pc.id) AS cards
        FROM PedagogicalCategories pc ORDER BY pc.priority ASC, pc.name ASC
    `).all();
}

export async function getByName(name) {
    return await db.prepare('SELECT id, name, priority, description FROM PedagogicalCategories WHERE name = ?').get(name);
}

export async function insert({ name, priority = 0, description = '' }) {
    return (await db.prepare(
        'INSERT INTO PedagogicalCategories (name, priority, description) VALUES (?, ?, ?)'
    ).run(name, priority, description)).lastInsertRowid;
}

export async function update(id, data) {
    const fields = [];
    const params = [];
    if (data.name !== undefined)        { fields.push('name = ?');        params.push(data.name); }
    if (data.priority !== undefined)    { fields.push('priority = ?');    params.push(data.priority); }
    if (data.description !== undefined) { fields.push('description = ?'); params.push(data.description); }
    if (!fields.length) return;
    params.push(id);
    await db.prepare(`UPDATE PedagogicalCategories SET ${fields.join(', ')} WHERE id = ?`).run(...params);
}

export async function remove(id) {
    await db.prepare('DELETE FROM PedagogicalCategories WHERE id = ?').run(id);
}
