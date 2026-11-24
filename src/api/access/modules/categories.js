import * as categoryRows from '../resources/db/categories.js';
import * as Documents from './documents.js';
import * as Decks from './decks.js';

const fail = (message, status) => Object.assign(new Error(message), { status });

async function byId(id) {
    const category = (await categoryRows.getAll()).find((c) => c.id === id);
    if (!category) throw fail('category not found', 404);
    return category;
}

async function rewriteCards(from, to) {
    await Documents.rewriteCategory(from, to);
    await Decks.rewriteCategory(from, to);
}

export async function list() {
    return await categoryRows.getAll();
}

export async function create({ name, priority = 0, description = '' }) {
    if (!name?.trim()) throw fail('name required', 400);
    return await categoryRows.insert({
        name: name.trim(),
        priority: Number(priority) || 0,
        description: description ?? '',
    });
}

export async function update(id, { name, priority, description }) {
    const current = await byId(id);
    const nextName = name !== undefined ? String(name).trim() : undefined;
    if (nextName === '') throw fail('name must not be empty', 400);
    const renamed = nextName !== undefined && nextName !== current.name;
    if (renamed && await categoryRows.getByName(nextName)) {
        throw fail(`A category named "${nextName}" already exists`, 409);
    }
    await categoryRows.update(id, {
        name: nextName,
        priority: priority !== undefined ? Number(priority) : undefined,
        description,
    });
    if (renamed) await rewriteCards(current.name, nextName);
}

export async function remove(id, { clear = false } = {}) {
    const current = await byId(id);
    if (current.cards > 0 && !clear) throw fail(`In use by ${current.cards} flashcard(s)`, 409);
    if (current.cards > 0) await rewriteCards(current.name, null);
    await categoryRows.remove(id);
}
