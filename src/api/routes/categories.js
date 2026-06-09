import { Router } from 'express';
import query from '../access/query.js';

const router = Router();

const catchError = (fn) => (req, res, next) =>
    Promise.resolve().then(() => fn(req, res, next)).catch(next);

// GET /api/categories
router.get('/', catchError((req, res) => {
    res.json(query.getCategories());
}));

// POST /api/categories — { name, priority?, description? }
router.post('/', catchError((req, res) => {
    const { name, priority = 0, description = '' } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'name required' });
    const id = query.insertCategory({
        name: name.trim(),
        priority: Number(priority) || 0,
        description: description ?? '',
    });
    res.status(201).json({ id });
}));

// PUT /api/categories/:id — { name?, priority?, description? }
router.put('/:id', catchError((req, res) => {
    const id = Number(req.params.id);
    const { name, priority, description } = req.body;
    query.updateCategory(id, {
        name: name !== undefined ? name.trim() : undefined,
        priority: priority !== undefined ? Number(priority) : undefined,
        description,
    });
    res.json({ ok: true });
}));

// DELETE /api/categories/:id
router.delete('/:id', catchError((req, res) => {
    const id = Number(req.params.id);
    const count = query.getCategoryUsageCount(id);
    if (count > 0) return res.status(409).json({ error: `In use by ${count} flashcard(s)` });
    query.deleteCategory(id);
    res.json({ ok: true });
}));

export default router;
