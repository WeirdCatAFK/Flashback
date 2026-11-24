import * as Files from '../resources/files.js';
import { withDocument } from '../resources/pathLock.js';
import * as categoryRows from '../resources/db/categories.js';
import { sealEmitter } from '../../seal/seal.js';
import { LATEST_VERSION } from '../../config/updates/registry.js';
import * as Documents from './documents.js';
import * as Decks from './decks.js';

const FILE = '_categories.json';

const fail = (message, status) => Object.assign(new Error(message), { status });

async function byId(id) {
    const category = (await categoryRows.getAll()).find((c) => c.id === id);
    if (!category) throw fail('category not found', 404);
    return category;
}

function _readFile() {
    const text = Files.readReserved(FILE);
    if (text === null) return null;
    try {
        const data = JSON.parse(text);
        return Array.isArray(data?.categories) ? data.categories : null;
    } catch {
        return null;
    }
}

async function _writeFile() {
    const categories = (await categoryRows.getAll())
        .map(({ name, priority, description }) => ({ name, priority, description: description ?? '' }));
    Files.writeReserved(FILE, JSON.stringify({ formatVersion: LATEST_VERSION, categories }, null, 2) + '\n');
    await sealEmitter.edit(FILE);
}

/** Changes the index and rewrites _categories.json under one lock. Card rewrites run after it returns, because they take the structure lock. */
async function _change(fn) {
    return await withDocument(FILE, async () => {
        const result = await fn();
        await _writeFile();
        return result;
    });
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
    return await _change(() => categoryRows.insert({
        name: name.trim(),
        priority: Number(priority) || 0,
        description: description ?? '',
    }));
}

export async function update(id, { name, priority, description }) {
    const current = await byId(id);
    const nextName = name !== undefined ? String(name).trim() : undefined;
    if (nextName === '') throw fail('name must not be empty', 400);
    const renamed = nextName !== undefined && nextName !== current.name;
    if (renamed && await categoryRows.getByName(nextName)) {
        throw fail(`A category named "${nextName}" already exists`, 409);
    }
    await _change(() => categoryRows.update(id, {
        name: nextName,
        priority: priority !== undefined ? Number(priority) : undefined,
        description,
    }));
    if (renamed) await rewriteCards(current.name, nextName);
}

export async function remove(id, { clear = false } = {}) {
    const current = await byId(id);
    if (current.cards > 0 && !clear) throw fail(`In use by ${current.cards} flashcard(s)`, 409);
    if (current.cards > 0) await rewriteCards(current.name, null);
    await _change(() => categoryRows.remove(id));
}

/** Copies _categories.json into the index, as the Doctor does with deck files. Returns how many categories it restored or changed. */
export async function syncFromFile() {
    const categories = _readFile();
    if (!categories) return 0;
    let changed = 0;
    for (const { name, priority = 0, description = '' } of categories) {
        if (typeof name !== 'string' || !name.trim()) continue;
        const row = await categoryRows.getByName(name);
        if (!row) {
            await categoryRows.insert({ name, priority, description });
            changed++;
        } else if (row.priority !== priority || (row.description ?? '') !== description) {
            await categoryRows.update(row.id, { priority, description });
            changed++;
        }
    }
    return changed;
}

/** Writes _categories.json once for a vault from an older build, whose categories lived only in the index. */
export async function exportIfMissing() {
    if (_readFile() !== null) return false;
    if ((await categoryRows.getAll()).length === 0) return false;
    await withDocument(FILE, () => _writeFile());
    return true;
}
