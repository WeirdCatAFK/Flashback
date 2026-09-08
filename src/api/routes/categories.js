import { Router } from 'express';
import query from '../access/resources/query.js';

const router = Router();

const catchError = (fn) => (req, res, next) =>
    Promise.resolve().then(() => fn(req, res, next)).catch(next);

/** Every pedagogical category. */
router.get('/', catchError(async (req, res) => {
    res.json(await query.getCategories());
}));

/** Creates a category. */
router.post('/', catchError(async (req, res) => {
    const { name, priority = 0, description = '' } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'name required' });
    const id = await query.insertCategory({
        name: name.trim(),
        priority: Number(priority) || 0,
        description: description ?? '',
    });
    res.status(201).json({ id });
}));

/** Renames or re-describes a category. */
router.put('/:id', catchError(async (req, res) => {
    const id = Number(req.params.id);
    const { name, priority, description } = req.body;
    await query.updateCategory(id, {
        name: name !== undefined ? name.trim() : undefined,
        priority: priority !== undefined ? Number(priority) : undefined,
        description,
    });
    res.json({ ok: true });
}));

/** Deletes a category. */
router.delete('/:id', catchError(async (req, res) => {
    const id = Number(req.params.id);
    const count = await query.getCategoryUsageCount(id);
    if (count > 0) return res.status(409).json({ error: `In use by ${count} flashcard(s)` });
    await query.deleteCategory(id);
    res.json({ ok: true });
}));

export default router;
