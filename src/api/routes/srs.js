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

// POST /api/srs/review
// Body: { path?, flashcardHash, algorithm, ...algorithm-specific }
//   leitner/sm2: outcome, easeFactor, newLevel (computed client-side)
//   fsrs:        rating (1-4), requestRetention (server computes the schedule)
// path is optional: document-linked cards include it so the sidecar is updated;
// standalone cards (no document) omit it and only the DB is updated.
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

    // Ordering telemetry is composed here, like card health below, so the scheduler never
    // learns the graph exists. Derived from `prevCardHash` — what the trainer ACTUALLY
    // showed before this card — rather than from the sequencer's plan, because a card
    // re-queued after a failed grade is presented at a position nobody planned.
    // Best-effort by construction: measureOrdering returns nulls rather than throwing.
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

    // Card health is composed here rather than inside srs.js, the way /detail already
    // composes decks + srs — it keeps the scheduler ignorant of the classifier and works
    // identically for both branches above. Failures classify; passes only clear a flag
    // once the card is genuinely back up to strength (see cardHealth.onReview).
    //
    // Returned so the Trainer can report at the end of the session. Never fatal: a
    // classifier bug must not cost the user a graded review that is already persisted.
    let flags = [];
    try {
        flags = await cardHealth.onReview(flashcardHash, { outcome, rating });
    } catch (err) {
        console.error('card health evaluation failed:', err);
    }
    res.json({ ok: true, flags });
}));

// POST /api/srs/undo
// Body: { path?, flashcardHash, algorithm }
// Reverses the card's most recent review (a misgraded result): removes the last
// log and restores the card's prior SRS state. Like /review, `path` is present for
// document-linked cards (so the sidecar is corrected too) and omitted for standalone.
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

    // The retracted grade may be the one that raised a flag. Re-classify against what's
    // left of the ledger so an undone review doesn't leave behind a verdict it earned.
    try {
        await cardHealth.evaluate(flashcardHash);
    } catch (err) {
        console.error('card health re-evaluation failed:', err);
    }
    res.json({ ok: true, restored });
}));

// GET /api/srs/stats
// The level histogram behind the Flashcards sidebar, with the mastery summary of it.
// Delegates rather than assembling the pieces here: this route used to hand-roll `boxes`
// and `total` alongside an unreachable SRS.getLeitnerStats() that also computed
// `masteryPercentage`, so the sidecar read a field the route never sent and displayed
// "Mastery 0%" for every vault, forever.
router.get('/stats', catchError(async (req, res) => {
    res.json(await SRS.getLeitnerStats(currentScope()));
}));

// POST /api/srs/migrate
// Body: { from: 'leitner'|'sm2', to: 'leitner'|'sm2' }
// Translates all card progress from one algorithm's scale to the other using
// interval-matched mapping, so the review schedule is preserved as closely as possible.
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

// POST /api/srs/optimize
// Fits the vault's FSRS weights from its own rated review history and persists
// them (no-op below the minimum-data threshold). Returns before/after loss and
// review counts. No body required.
router.post('/optimize', catchError(async (req, res) => {
    const result = await SRS.optimizeParameters();
    res.json({ ok: true, ...result });
}));

// GET /api/srs/fsrs-info
// Optimizer status for the Config panel: rated-review count, whether the weights
// have been fitted, and when.
router.get('/fsrs-info', catchError(async (req, res) => {
    res.json(await SRS.getFsrsInfo());
}));

/**
 * How far through the vault this person is: how much of it they have read, and how well they
 * know the cards drawn from it.
 *
 * Composed here rather than inside `srs.js` for the same reason selection and sequencing are
 * composed in `/due`: the two halves come from different orchestrators and neither may import
 * the other. `readProgress` reaches the filesystem through `files.js`, and pulling that into
 * the scheduler is exactly what "srs.js never imports documents.js" exists to prevent.
 *
 * Both halves carry a complete denominator — an unread document counts as 0 rather than being
 * left out, and so does an unreviewed card — so this is a fraction of the whole vault and not
 * a report card on the part of it already touched.
 *
 * Neither half is used as evidence about the other when it has nothing to say. A vault of
 * standalone cards has no documents to read, and averaging a `read` of 0 into its score would
 * be a statement about material that does not exist; likewise a reference vault carrying no
 * cards. Only when both denominators are empty is there no answer, and then it is `null`
 * rather than a zero that would read as "you have done none of it".
 *
 * `stats` supplies the maturity counts, which are already computed and partition the same
 * card set — no second pass over the cards.
 */
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

// GET /api/srs/statistics?algorithm=leitner|sm2|fsrs
// Vault-wide analytics for the Stats view (retention, acquisition, maturity, due
// forecast, activity heatmap, streaks, completeness). Retention counts only reviews past a
// card's learning phase; the learning phase is reported separately under `acquisition`.
// `completeness` is how much of the vault has been read and learned — see vaultCompleteness,
// and note it is NOT `acquisition`, which is about the learning phase of a review.
// Read-only. Algorithm defaults server-side.
router.get('/statistics', catchError(async (req, res) => {
    const algorithm = req.query.algorithm || undefined;
    const stats = await SRS.getStatistics({ algorithm });
    stats.completeness = await vaultCompleteness(stats);
    res.json(stats);
}));

// GET /api/srs/due
// Query params (all optional, user preferences come from browser storage):
//   algorithm=leitner|sm2  — SRS scheduling algorithm (stored in localStorage by the frontend)
//   maxNew=<n>             — new cards to introduce per session (stored in localStorage)
//   minPriority=<n>        — only include cards whose pedagogical category priority >= n
//   folder=<relPath>       — restrict to a folder subtree
//   document=<relPath>     — restrict to one document
//   deck=<hash>            — restrict to cards in a specific deck
//   tag=<name>             — restrict to cards tagged with this name (repeatable)
//   excludeFolder=<relPath>   — hold back a folder subtree (repeatable)
//   excludeDocument=<relPath> — hold back one document (repeatable)
//   excludeDeck=<hash>        — hold back a deck's cards (repeatable)
//   excludeTag=<name>         — hold back cards carrying this effective tag (repeatable)
//   read=only              — hold back cards drawn from material the caller has not read past
//   order=interleaved|shuffle|priority — presentation order (localStorage `fb-trainer-order`)
//   seed=<n>               — fixed PRNG seed; for tests and reproducing a reported session
//
// The exclusions exist because the include filters cannot express the shape the problem
// actually has when a bulk import lands: nobody wants to enumerate the twelve folders they
// still want in order to park the one that just arrived.
//
// `read=only` is composed here rather than inside srs.js, exactly like vaultCompleteness
// below and for the same reason — readProgress reaches the filesystem, and the scheduler may
// not import anything that does. studyFilter() returns two plain lists and the scheduler
// never learns what they mean.
//
// Selection and sequencing are composed here, never folded into each other: SRS.getDue
// decides WHICH cards are due purely from due dates, then the sequencer decides the ORDER
// they are presented in. Topology must never move a card across days — that would corrupt
// the retention estimates the scheduler depends on.
//
// `queue` is the ordered session and is what the trainer consumes; `due`/`new` stay in the
// response for callers that only want the counts.
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

    // Repeatable, using the same idiom as `tag`: Express hands over a string for one
    // occurrence and an array for several, and `[].concat` flattens both to a list.
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
        // Which rung of the degradation ladder this session settled on. Surfaced so a
        // "the shuffle looks wrong" report can be diagnosed without reproducing the vault.
        relaxation: sequenced.relaxation,
    });
}));

export default router;
