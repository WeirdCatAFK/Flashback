import { Router } from 'express';
import Decks from '../access/orchestration/decks.js';
import Documents from '../access/orchestration/documents.js';
import srs from '../access/orchestration/srs.js';
import cardHealth from '../access/orchestration/cardHealth.js';

const router = Router();
const decks = new Decks();
const docs = new Documents();

const catchError = (fn) => (req, res, next) =>
    Promise.resolve().then(() => fn(req, res, next)).catch((err) => {
        if (err.message?.includes('not found')) return res.status(404).json({ error: err.message });
        if (err.message?.includes('document')) return res.status(400).json({ error: err.message });
        if (err.message?.startsWith('Unknown category')) return res.status(400).json({ error: err.message });
        if (err.message?.startsWith('Unknown flag kind')) return res.status(400).json({ error: err.message });
        next(err);
    });

router.get('/:hash', catchError(async (req, res) => {
    const card = await decks.getCard(req.params.hash);
    res.json({ ...card, etag: docs.cardEtag(card.documentPath, req.params.hash) });
}));

router.post('/', catchError(async (req, res) => {
    const { frontText, backText, answerText, name, cardType = 'basic', category, customHtml, tags } = req.body;
    const origin = req.body.origin === 'ai' ? 'ai' : null;
    const globalHash = await decks.createStandaloneCard({ frontText, backText, answerText, name, cardType, category, customHtml, origin, tags });
    res.status(201).json({ globalHash });
}));

router.get('/:hash/detail', catchError(async (req, res) => {
    const card = await decks.getCard(req.params.hash);
    const insights = await srs.getCardInsights(req.params.hash, { algorithm: req.query.algorithm || null });
    res.json({ card, ...insights, flags: await cardHealth.getFlags(req.params.hash) });
}));

router.get('/:hash/flags', catchError(async (req, res) => {
    await decks.getCard(req.params.hash);
    res.json({ flags: await cardHealth.getFlags(req.params.hash) });
}));

router.post('/:hash/flags/:kind/dismiss', catchError(async (req, res) => {
    const dismissed = await cardHealth.dismiss(req.params.hash, req.params.kind);
    if (!dismissed) return res.status(404).json({ error: 'No such flag on this card' });
    res.json({ ok: true, flags: await cardHealth.getFlags(req.params.hash) });
}));

router.put('/:hash', catchError(async (req, res) => {
    const { hash } = req.params;
    const { frontText, backText, answerText, name, cardType, category, customHtml, tags } = req.body;
    const card = await decks.getCard(hash);

    if (!card.documentPath) {
        await decks.updateStandaloneCard(hash, { frontText, backText, answerText, name, cardType, category, customHtml, tags });
        await cardHealth.onCardEdited(hash);
        return res.json({ ok: true, documentPath: null });
    }

    const updated = await docs.updateFlashcard(card.documentPath, hash, {
        frontText, backText, answerText, name, cardType, category, customHtml, tags,
    }, { ifMatch: req.body.ifMatch });

    await cardHealth.onCardEdited(hash);
    res.json({ ok: true, documentPath: card.documentPath, etag: docs.files.entityEtag(updated) });
}));

router.delete('/:hash', catchError(async (req, res) => {
    const { hash } = req.params;
    const card = await decks.getCard(hash);

    if (!card.documentPath) {
        await decks.deleteStandaloneCard(hash);
        return res.json({ ok: true, documentPath: null });
    }

    const decksTouched = await decks.removeCardEverywhere(hash);
    await docs.deleteFlashcard(card.documentPath, hash);
    res.json({ ok: true, documentPath: card.documentPath, decksTouched });
}));

export default router;
