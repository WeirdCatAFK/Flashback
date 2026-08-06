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

// GET /api/flashcards/:hash — resolve any card (standalone or anchored) to its
// content + source document path, so clients can route edits correctly.
router.get('/:hash', catchError((req, res) => {
    const card = decks.getCard(req.params.hash);
    res.json(card);
}));

// POST /api/flashcards — create standalone card
// `origin` marks provenance ('ai' = created by an AI assistant); set once at
// creation, never editable afterwards — the PUT below deliberately ignores it.
router.post('/', catchError(async (req, res) => {
    const { frontText, backText, name, cardType = 'basic', category, customHtml } = req.body;
    const origin = req.body.origin === 'ai' ? 'ai' : null;
    const globalHash = await decks.createStandaloneCard({ frontText, backText, name, cardType, category, customHtml, origin });
    res.status(201).json({ globalHash });
}));

// GET /api/flashcards/:hash/detail — everything the card detail view needs in one
// request: content, current schedule, full review ledger, a sampled retention curve,
// and any card-health flags. `algorithm` is the browser's preference when the caller
// has one; omit it and the server detects the vault's from its review history and
// echoes back the one it used.
//
// `flags` is a read here, never a computation: classification runs at review time, only
// on a card that has just failed. Opening a card's detail view must not be able to
// accuse it of anything.
router.get('/:hash/detail', catchError((req, res) => {
    const card = decks.getCard(req.params.hash);     // throws "not found" → 404
    const insights = srs.getCardInsights(req.params.hash, { algorithm: req.query.algorithm || null });
    res.json({ card, ...insights, flags: cardHealth.getFlags(req.params.hash) });
}));

// GET /api/flashcards/:hash/flags — just the card-health flags, with their evidence.
//
// Same read as `/detail` exposes, without the review ledger and retention curve around it.
// It exists for callers that want to know *why* a card was flagged but have no use for its
// full history — chiefly the MCP server, where the ledger would be a large payload spent to
// reach a four-element array.
router.get('/:hash/flags', catchError((req, res) => {
    decks.getCard(req.params.hash);                  // throws "not found" → 404
    res.json({ flags: cardHealth.getFlags(req.params.hash) });
}));

// POST /api/flashcards/:hash/flags/:kind/dismiss — the user has ruled on this flag.
//
// Suppresses it rather than deleting it, so it stops re-announcing itself on every later
// failure while its evidence stays current. Only the named flag is affected (a card can
// carry both guards at once). Editing the card clears the suppression — a rewritten card
// gets judged fresh.
router.post('/:hash/flags/:kind/dismiss', catchError((req, res) => {
    const dismissed = cardHealth.dismiss(req.params.hash, req.params.kind);
    if (!dismissed) return res.status(404).json({ error: 'No such flag on this card' });
    res.json({ ok: true, flags: cardHealth.getFlags(req.params.hash) });
}));

// PUT /api/flashcards/:hash — update any card, standalone or document-anchored
// (partial: omitted fields keep their stored values).
//
// The two live in different canonical files, but as with DELETE below a client
// holding a hash shouldn't have to know which — the server resolves the card's home
// and dispatches. Editing an anchored card used to be refused here outright.
router.put('/:hash', catchError(async (req, res) => {
    const { hash } = req.params;
    const { frontText, backText, name, cardType, category, customHtml, tags } = req.body;
    const card = decks.getCard(hash);   // throws "not found" → 404

    if (!card.documentPath) {
        await decks.updateStandaloneCard(hash, { frontText, backText, name, cardType, category, customHtml });
        cardHealth.onCardEdited(hash);
        return res.json({ ok: true, documentPath: null });
    }

    // tags are a sidecar concept — standalone cards inherit theirs from their deck.
    await docs.updateFlashcard(card.documentPath, hash, {
        frontText, backText, name, cardType, category, customHtml, tags,
    });

    // The card's flags describe a card that no longer exists, so they go and the
    // analysis window restarts here. cardHealth's own fingerprint check would catch this
    // at the next failing review regardless (and catches edits through paths this route
    // never sees — MCP, a Seal rollback, a Doctor reindex); this is here so the flag
    // disappears the moment the user saves.
    cardHealth.onCardEdited(hash);
    res.json({ ok: true, documentPath: card.documentPath });
}));

// DELETE /api/flashcards/:hash — delete any card, standalone or document-anchored.
//
// The two live in different canonical files (the system deck's JSON vs. the source
// document's sidecar), but a client deleting a card shouldn't have to know or care
// which — it has a hash, and the server can resolve the card's home itself. Decks are
// unlinked first, while the card's node still exists for removeEntry to unhook.
router.delete('/:hash', catchError(async (req, res) => {
    const { hash } = req.params;
    const card = decks.getCard(hash);   // throws "not found" → 404

    if (!card.documentPath) {
        await decks.deleteStandaloneCard(hash);   // handles its own system-deck cleanup
        return res.json({ ok: true, documentPath: null });
    }

    const decksTouched = await decks.removeCardEverywhere(hash);
    await docs.deleteFlashcard(card.documentPath, hash);
    res.json({ ok: true, documentPath: card.documentPath, decksTouched });
}));

export default router;
