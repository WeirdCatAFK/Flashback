import { Router } from 'express';
import query from '../access/resources/query.js';
import Documents from '../access/orchestration/documents.js';
import Decks from '../access/orchestration/decks.js';

const router = Router();

const catchError = (fn) => (req, res, next) =>
    Promise.resolve().then(() => fn(req, res, next)).catch(next);

/**
 * A card names its category in its sidecar or deck file, so a rename or a clearing delete
 * rewrites those files too (`rewriteCategory` on both orchestrators), not only the row.
 */
const docs = new Documents();

/** The category with this id, or undefined. */
const categoryById = async (id) => (await query.getCategories()).find((c) => c.id === id);

/** Every pedagogical category, each with how many cards use it. */
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

/**
 * Renames, re-describes or re-prioritises a category. A rename rewrites every card that
 * names it; renaming onto another category's name is refused rather than merged.
 */
router.put('/:id', catchError(async (req, res) => {
    const id = Number(req.params.id);
    const current = await categoryById(id);
    if (!current) return res.status(404).json({ error: 'category not found' });
    const { name, priority, description } = req.body;
    const nextName = name !== undefined ? String(name).trim() : undefined;
    if (nextName === '') return res.status(400).json({ error: 'name must not be empty' });
    const renamed = nextName !== undefined && nextName !== current.name;
    if (renamed && await query.getCategoryByName(nextName)) {
        return res.status(409).json({ error: `A category named "${nextName}" already exists` });
    }
    await query.updateCategory(id, {
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

/**
 * Deletes a category. Refuses while any card uses it, unless `?clear=1` asks for those
 * cards to lose it first — a choice the caller makes after saying so, never a silent one.
 */
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
    await query.deleteCategory(id);
    res.json({ ok: true });
}));

export default router;
