import { Router } from 'express';
import * as Decks from '../access/modules/decks.js';
import * as Documents from '../access/modules/documents.js';
import * as Srs from '../access/modules/srs.js';
import * as CardHealth from '../access/modules/cardHealth.js';

const router = Router();

const catchError = (fn) => (req, res, next) =>
    Promise.resolve().then(() => fn(req, res, next)).catch((err) => {
        if (err.message?.includes('not found')) return res.status(404).json({ error: err.message });
        if (err.message?.includes('document')) return res.status(400).json({ error: err.message });
        if (err.message?.startsWith('Unknown category')) return res.status(400).json({ error: err.message });
        if (err.message?.startsWith('Unknown flag kind')) return res.status(400).json({ error: err.message });
        next(err);
    });

router.get('/:hash', catchError(async (req, res) => {
    const card = await Decks.getCard(req.params.hash);
    res.json({ ...card, etag: Documents.cardEtag(card.documentPath, req.params.hash) });
}));

router.post('/', catchError(async (req, res) => {
    const { frontText, backText, answerText, name, cardType = 'basic', category, customHtml, tags } = req.body;
    const origin = req.body.origin === 'ai' ? 'ai' : null;
    const globalHash = await Decks.createStandaloneCard({ frontText, backText, answerText, name, cardType, category, customHtml, origin, tags });
    res.status(201).json({ globalHash });
}));

router.get('/:hash/detail', catchError(async (req, res) => {
    const card = await Decks.getCard(req.params.hash);
    const insights = await Srs.getCardInsights(req.params.hash, { algorithm: req.query.algorithm || null });
    res.json({ card, ...insights, flags: await CardHealth.getFlags(req.params.hash) });
}));

router.get('/:hash/flags', catchError(async (req, res) => {
    await Decks.getCard(req.params.hash);
    res.json({ flags: await CardHealth.getFlags(req.params.hash) });
}));

router.post('/:hash/flags/:kind/dismiss', catchError(async (req, res) => {
    const dismissed = await CardHealth.dismiss(req.params.hash, req.params.kind);
    if (!dismissed) return res.status(404).json({ error: 'No such flag on this card' });
    res.json({ ok: true, flags: await CardHealth.getFlags(req.params.hash) });
}));

router.put('/:hash', catchError(async (req, res) => {
    const { hash } = req.params;
    const { frontText, backText, answerText, name, cardType, category, customHtml, tags } = req.body;
    const card = await Decks.getCard(hash);

    if (!card.documentPath) {
        await Decks.updateStandaloneCard(hash, { frontText, backText, answerText, name, cardType, category, customHtml, tags });
        await CardHealth.onCardEdited(hash);
        return res.json({ ok: true, documentPath: null });
    }

    const updated = await Documents.updateFlashcard(card.documentPath, hash, {
        frontText, backText, answerText, name, cardType, category, customHtml, tags,
    }, { ifMatch: req.body.ifMatch });

    await CardHealth.onCardEdited(hash);
    res.json({ ok: true, documentPath: card.documentPath, etag: Documents.entityEtag(updated) });
}));

router.delete('/:hash', catchError(async (req, res) => {
    const { hash } = req.params;
    const card = await Decks.getCard(hash);

    if (!card.documentPath) {
        await Decks.deleteStandaloneCard(hash);
        return res.json({ ok: true, documentPath: null });
    }

    const decksTouched = await Decks.removeCardEverywhere(hash);
    await Documents.deleteFlashcard(card.documentPath, hash);
    res.json({ ok: true, documentPath: card.documentPath, decksTouched });
}));

export default router;
