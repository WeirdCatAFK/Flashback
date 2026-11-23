import { Router } from 'express';
import * as categoryRows from '../access/resources/db/categories.js';
import Documents from '../access/modules/documents.js';
import Decks from '../access/modules/decks.js';

const router = Router();

const catchError = (fn) => (req, res, next) =>
    Promise.resolve().then(() => fn(req, res, next)).catch(next);

const docs = new Documents();

const categoryById = async (id) => (await categoryRows.getAll()).find((c) => c.id === id);

router.get('/', catchError(async (req, res) => {
    res.json(await categoryRows.getAll());
}));

router.post('/', catchError(async (req, res) => {
    const { name, priority = 0, description = '' } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'name required' });
    const id = await categoryRows.insert({
        name: name.trim(),
        priority: Number(priority) || 0,
        description: description ?? '',
    });
    res.status(201).json({ id });
}));

router.put('/:id', catchError(async (req, res) => {
    const id = Number(req.params.id);
    const current = await categoryById(id);
    if (!current) return res.status(404).json({ error: 'category not found' });
    const { name, priority, description } = req.body;
    const nextName = name !== undefined ? String(name).trim() : undefined;
    if (nextName === '') return res.status(400).json({ error: 'name must not be empty' });
    const renamed = nextName !== undefined && nextName !== current.name;
    if (renamed && await categoryRows.getByName(nextName)) {
        return res.status(409).json({ error: `A category named "${nextName}" already exists` });
    }
    await categoryRows.update(id, {
        name: nextName,
        priority: priority !== undefined ? Number(priority) : undefined,
        description,
    });
    if (renamed) {
        await docs.rewriteCategory(current.name, nextName);
        await new Decks().rewriteCategory(current.name, nextName);
    }
    res.json({ ok: true });
}));

router.delete('/:id', catchError(async (req, res) => {
    const id = Number(req.params.id);
    const current = await categoryById(id);
    if (!current) return res.status(404).json({ error: 'category not found' });
    const clear = req.query.clear === '1' || req.query.clear === 'true';
    if (current.cards > 0 && !clear) {
        return res.status(409).json({ error: `In use by ${current.cards} flashcard(s)` });
    }
    if (current.cards > 0) {
        await docs.rewriteCategory(current.name, null);
        await new Decks().rewriteCategory(current.name, null);
    }
    await categoryRows.remove(id);
    res.json({ ok: true });
}));

export default router;
