import { Router } from 'express';
import * as Categories from '../access/modules/categories.js';

const router = Router();

const catchError = (fn) => (req, res, next) =>
    Promise.resolve().then(() => fn(req, res, next)).catch(next);

router.get('/', catchError(async (req, res) => {
    res.json(await Categories.list());
}));

router.post('/', catchError(async (req, res) => {
    const id = await Categories.create(req.body ?? {});
    res.status(201).json({ id });
}));

router.put('/:id', catchError(async (req, res) => {
    await Categories.update(Number(req.params.id), req.body ?? {});
    res.json({ ok: true });
}));

router.delete('/:id', catchError(async (req, res) => {
    const clear = req.query.clear === '1' || req.query.clear === 'true';
    await Categories.remove(Number(req.params.id), { clear });
    res.json({ ok: true });
}));

export default router;
