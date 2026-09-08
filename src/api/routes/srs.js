import { Router } from 'express';
import path from 'path';
import Documents from '../access/orchestration/documents.js';
import SRS from '../access/orchestration/srs.js';
import cardHealth from '../access/orchestration/cardHealth.js';
import sequencer from '../access/orchestration/sequencer.js';
import readProgress from '../access/orchestration/readProgress.js';
import query from '../access/resources/query.js';
import { currentScope } from '../requestContext.js';

const router = Router();
const docs = new Documents();
const norm = (p) => p ? path.normalize(p) : p;
const catchError = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.post('/review', catchError(async (req, res) => {
    const relPath = norm(req.body.path);
    const {
        flashcardHash, outcome, easeFactor, newLevel, algorithm, rating, requestRetention,
        sessionId, sessionPosition, prevCardHash,
    } = req.body;
    if (!flashcardHash) {
        return res.status(400).json({ error: 'flashcardHash required' });
    }
    if (algorithm === 'fsrs') {
        if (rating == null) return res.status(400).json({ error: 'rating (1-4) required for fsrs' });
    } else if (outcome == null || easeFactor == null || newLevel == null) {
        return res.status(400).json({ error: 'outcome, easeFactor, and newLevel required' });
    }

    const ordering = sessionId
        ? {
            sessionId,
            sessionPosition: sessionPosition ?? null,
            ...await sequencer.measureOrdering({ sessionId, cardHash: flashcardHash, prevCardHash }),
        }
        : {};

    const opts = { rating, requestRetention, ordering };
    if (relPath) {
        await docs.submitReview(relPath, flashcardHash, outcome, easeFactor, newLevel, algorithm, opts);
    } else {
        await SRS.submitReview(flashcardHash, outcome, easeFactor, newLevel, algorithm, opts);
    }

    let flags = [];
    try {
        flags = await cardHealth.onReview(flashcardHash, { outcome, rating });
    } catch (err) {
        console.error('card health evaluation failed:', err);
    }
    res.json({ ok: true, flags });
}));

router.post('/undo', catchError(async (req, res) => {
    const relPath = norm(req.body.path);
    const { flashcardHash, algorithm } = req.body;
    if (!flashcardHash) {
        return res.status(400).json({ error: 'flashcardHash required' });
    }
    let restored;
    if (relPath) {
        restored = await docs.undoReview(relPath, flashcardHash, algorithm);
    } else {
        ({ restored } = await SRS.undoReview(flashcardHash, algorithm));
    }

    try {
        await cardHealth.evaluate(flashcardHash);
    } catch (err) {
        console.error('card health re-evaluation failed:', err);
    }
    res.json({ ok: true, restored });
}));

router.get('/stats', catchError(async (req, res) => {
    res.json(await SRS.getLeitnerStats(currentScope()));
}));

router.post('/migrate', catchError(async (req, res) => {
    const { from, to } = req.body;
    if (!from || !to || from === to) {
        return res.status(400).json({ error: 'from and to are required and must differ' });
    }
    const ALGS = ['leitner', 'sm2', 'fsrs'];
    if (!ALGS.includes(from) || !ALGS.includes(to)) {
        return res.status(400).json({ error: 'from and to must be leitner, sm2, or fsrs' });
    }
    const count = await SRS.migrateProgress(from, to);
    res.json({ ok: true, count });
}));

router.post('/optimize', catchError(async (req, res) => {
    const result = await SRS.optimizeParameters();
    res.json({ ok: true, ...result });
}));

router.get('/fsrs-info', catchError(async (req, res) => {
    res.json(await SRS.getFsrsInfo());
}));

/** How far through the vault this person is: how much of it they have read, and how well they know the cards drawn from it. */
async function vaultCompleteness(stats) {
    const scope = currentScope();
    const [rollup, learned] = await Promise.all([
        readProgress.rollup('', { scope }),
        query.getVaultLearned(scope),
    ]);

    const documents = rollup.total ?? 0;
    const cards = learned.cards ?? 0;
    const readPct = documents > 0 ? rollup.percent : null;
    const knownPct = cards > 0 ? learned.learnedSum / cards : null;

    let percent = null;
    if (readPct != null && knownPct != null) percent = (readPct + knownPct) / 2;
    else if (readPct != null) percent = readPct;
    else if (knownPct != null) percent = knownPct;

    return {
        percent,
        read: {
            percent: readPct,
            documents,
            finished: rollup.finished,
            inProgress: rollup.inProgress,
            unread: rollup.unread,
        },
        known: {
            percent: knownPct,
            cards,
            mature: stats.maturity.mature,
            young: stats.maturity.young,
            new: stats.maturity.new,
        },
    };
}

/** The caller's review analytics, joined with vault completeness. */
router.get('/statistics', catchError(async (req, res) => {
    const algorithm = req.query.algorithm || undefined;
    const stats = await SRS.getStatistics({ algorithm });
    stats.completeness = await vaultCompleteness(stats);
    res.json(stats);
}));

/** The cards to study now, already in presentation order. */
router.get('/due', catchError(async (req, res) => {
    const algorithm = req.query.algorithm || undefined;
    const folder = req.query.folder ? norm(req.query.folder) : null;
    const document = req.query.document ? norm(req.query.document) : null;
    const deck = req.query.deck || null;
    const rawTags = req.query.tag;
    const tags = rawTags ? [].concat(rawTags).filter(Boolean) : null;
    const maxNew = req.query.maxNew != null ? parseInt(req.query.maxNew, 10) : undefined;
    const minPriority = req.query.minPriority != null ? parseInt(req.query.minPriority, 10) : undefined;
    const order = req.query.order || 'interleaved';
    const seed = req.query.seed != null ? parseInt(req.query.seed, 10) : null;

    /** Every day this person has a summary or an entry for, newest first. */
    const list = (raw, map = (v) => v) => {
        const values = raw ? [].concat(raw).filter(Boolean).map(map) : [];
        return values.length ? values : null;
    };
    const excludeFolders = list(req.query.excludeFolder, norm);
    const excludeDocuments = list(req.query.excludeDocument, norm);
    const excludeDecks = list(req.query.excludeDeck);
    const excludeTags = list(req.query.excludeTag);

    const readGate = req.query.read === 'only'
        ? await readProgress.studyFilter({ scope: currentScope() })
        : null;

    const result = await SRS.getDue({
        algorithm, folder, document, deck, tags: tags?.length ? tags : null, maxNew, minPriority,
        readGate, excludeFolders, excludeDocuments, excludeDecks, excludeTags,
    });
    const sequenced = await sequencer.sequence({
        due: result.due,
        newCards: result.new,
        order,
        seed: Number.isFinite(seed) ? seed : null,
    });

    res.json({
        ...result,
        queue: sequenced.queue,
        sessionId: sequenced.sessionId,
        order: sequenced.order,
        relaxation: sequenced.relaxation,
    });
}));

export default router;
