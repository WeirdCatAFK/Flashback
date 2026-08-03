/**
 * cardHealth.js — failure-signature classification.
 *
 * Flashback classifies cards by how they behave under review and flags the ones worth
 * acting on. The problem it exists to solve: two cards can have an identical pass rate
 * and need opposite treatment.
 *
 *   MOUTHFUL — the card is badly built. Too much to hold at once. Action: split it.
 *   PROBE    — the card is hard because it forces the reviewer to confront a wrong
 *              assumption. Failures are the mechanism, not a defect. Action: keep it,
 *              optionally add a companion card naming the misconception.
 *              (Hypercorrection effect; Kapur's productive failure.)
 *
 * Telling them apart requires the DERIVATIVE, NOT THE LEVEL. A probe converges — lapses
 * cluster early, each relearn cycle ends at a longer interval than the last, difficulty
 * plateaus or falls. A bumpy climb. A mouthful oscillates around a floor — every lapse
 * resets to roughly the same short interval, difficulty ratchets up monotonically, and
 * the card never leaves the learning band.
 *
 * Two more detectors ship alongside them and they are NOT extras — they are what stops
 * MOUTHFUL from being wrong. A card reviewed 40 days past due failed because of the
 * delay; a card that always lands in the last third of a 90-card session shows depressed
 * grades regardless of quality. When either fires it SUPPRESSES the mouthful/probe
 * verdict, because it means the trajectory evidence is contaminated. The guard is the
 * diagnosis.
 *
 * DATA CONSTRAINT. ReviewLogs stores the grade, not the typed answer, so error-content
 * analysis (edit distance between successive wrong answers, matching a wrong answer
 * against another card's back) is unavailable. Everything here runs on grades +
 * timestamps + FSRS-derived state + static card structure.
 *
 * STRUCTURE. The expensive, impure work happens once in buildContext(); every detector
 * is a pure function of that context. Adding a detector later is one entry in DETECTORS
 * plus a test — which is the whole extensibility story, and the reason the evidence
 * gathering does not live inside the detectors.
 *
 * Tier 3. Imports `query` (and the pure `fsrs` helpers) only — never `documents`, never
 * `srs`. Read-only toward the canonical layer: flags are derived data, live only in
 * SQLite, and are never written to a `.flashback` sidecar. Sealing a flag would mean a
 * git commit on every failed review.
 *
 * NEVER AUTO-SPLIT, NEVER AUTO-BURY. Every flag ends in a named recommendation the user
 * chooses to act on.
 */

import crypto from 'crypto';
import query from './query.js';
import * as fsrs from './fsrs.js';

const DAY_MS = 86400000;

// --- Tunables -----------------------------------------------------------------
// Named rather than inlined because these are the knobs that decide how noisy the
// feature is, and they should be arguable from one place.

// A card has RECOVERED when a passing review carries it back to this strength.
// A single pass is emphatically not recovery: most cards get a passing grade every
// session, and a mouthful passes constantly at a one-day interval — that is precisely
// the behaviour being flagged. `level` is maintained under all three schedulers
// (srs._applyFsrs mirrors the FSRS interval onto it), so this reads the same whichever
// one is active. Level 3 ≈ a 4-day interval.
const RECOVERY_LEVEL = 3;

// Reviews later than this multiple of their scheduled interval are excluded from the
// trajectory outright — the grade measures the delay, not the card.
const OVERDUE_EXCLUDE_RATIO = 3.0;
// ...and this much late already taints a failure enough to count toward overdue drift.
const OVERDUE_SUSPECT_RATIO = 2.0;

// Session segmentation: ReviewLogs has no session id, so sessions are clustered on
// inter-review gaps across the whole vault.
const SESSION_GAP_MS = 30 * 60 * 1000;
const SESSION_WINDOW_DAYS = 90;
const SESSION_CACHE_MS = 60000;

// "Late in the session" starts here, and a session must be at least this long for
// position to mean anything at all.
const LATE_SESSION_POSITION = 0.66;
const FATIGUE_MIN_SESSION_LEN = 20;

// Confidence gates — the three detection windows. Below these, nothing is emitted:
// flags are meant to be rare, and a card that has failed twice has not yet said anything.
const HIGH_MIN_LAPSES = 4;
const HIGH_MIN_WINDOW_DAYS = 14;
const MODERATE_MIN_FAILURES = 2;

// A trajectory that never reaches this interval after HIGH_MIN_LAPSES cycles has not
// left the learning band, whatever its slope says.
const LEARNING_BAND_DAYS = 7;

// Structural prior thresholds. lengthRatio is measured against the vault's own median
// answer, never an absolute character count — 40 characters means something very
// different in a kana vault and in a case-law vault.
const OVERLOADED_LENGTH_RATIO = 2.0;
const OVERLOADED_CHUNKS = 4;
const OVERLOADED_TOKENS = 40;
const COMPACT_LENGTH_RATIO = 1.0;
const COMPACT_CHUNKS = 2;

const GUARD_KINDS = ['overdue_drift', 'session_fatigue'];
const SIGNATURE_KINDS = ['mouthful', 'probe'];
export const FLAG_KINDS = [...GUARD_KINDS, ...SIGNATURE_KINDS];

// --- Pure helpers -------------------------------------------------------------

function median(nums) {
    if (!nums.length) return null;
    const s = [...nums].sort((a, b) => a - b);
    const mid = s.length / 2;
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[mid - 1] + s[mid]) / 2;
}

// Least-squares slope of y against its own index. Returns 0 for fewer than two points
// (no trend is not the same as a downward trend — a one-cycle card must not read as
// oscillating just because there is nothing to compare).
function slope(ys) {
    const n = ys.length;
    if (n < 2) return 0;
    const meanX = (n - 1) / 2;
    const meanY = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
        num += (i - meanX) * (ys[i] - meanY);
        den += (i - meanX) ** 2;
    }
    return den === 0 ? 0 : num / den;
}

// Strip HTML and markdown noise so token counts measure prose, not markup. Custom cards
// store raw HTML; imported cards routinely carry <br>, <div> and entities.
export function plainText(html) {
    if (!html) return '';
    return String(html)
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&[a-z]+;/gi, ' ')
        .replace(/[ \t]+/g, ' ')
        // Collapse the whitespace the tag stripping leaves behind, so `<p>a</p><br>b`
        // counts as two lines rather than four.
        .replace(/[ \t]*\n[ \t\n]*/g, '\n')
        .trim();
}

/**
 * The load a card's answer puts on the reviewer, as far as it can be measured from
 * static text. This is the authoring-time prior: with grade-only logs it is the best
 * available proxy for "too much to hold at once".
 *
 * It is deliberately EVIDENCE ONLY — it never surfaces on its own. A long answer that
 * reviews fine is never mentioned, because criticising a card that is working is exactly
 * the failure mode this feature was designed to avoid.
 */
export function analyzeStructure({ cardType, backText, customHtml, frontText } = {}) {
    // A cloze's load is its deletion count, not its prose length: the reviewer is being
    // asked to produce N separate things from one context.
    const clozeSource = `${frontText ?? ''}\n${backText ?? ''}`;
    const clozeDeletions = cardType === 'cloze'
        ? (clozeSource.match(/\{\{c\d+::/g) ?? clozeSource.match(/\{\{[^}]+\}\}/g) ?? []).length
        : 0;

    const text = plainText(cardType === 'custom' ? customHtml : backText)
        || plainText(backText) || plainText(customHtml);

    const tokens = text ? text.split(/\s+/).filter(Boolean).length : 0;
    const lines = text ? text.split(/\n+/).map(l => l.trim()).filter(Boolean) : [];
    const listItems = lines.filter(l => /^([-*•]|\d+[.)])\s+/.test(l)).length;
    const clauses = text ? text.split(/[.;:,\n]+/).map(c => c.trim()).filter(Boolean).length : 0;

    // The most demanding reading of "how many separate things is this".
    const chunks = Math.max(lines.length, listItems, clauses, clozeDeletions);

    return { tokens, lines: lines.length, listItems, clauses, clozeDeletions, chunks };
}

/**
 * Classify structure against the vault's own baseline.
 * `overloaded` / `compact` / `neutral`.
 */
export function structuralPrior(structure, medianTokens) {
    const base = medianTokens && medianTokens > 0 ? medianTokens : null;
    const lengthRatio = base ? structure.tokens / base : null;

    const overloaded =
        (lengthRatio !== null && lengthRatio >= OVERLOADED_LENGTH_RATIO) ||
        structure.chunks >= OVERLOADED_CHUNKS ||
        structure.tokens >= OVERLOADED_TOKENS;

    const compact =
        (lengthRatio === null || lengthRatio <= COMPACT_LENGTH_RATIO) &&
        structure.chunks <= COMPACT_CHUNKS &&
        structure.tokens < OVERLOADED_TOKENS;

    return {
        prior: overloaded ? 'overloaded' : compact ? 'compact' : 'neutral',
        lengthRatio: lengthRatio === null ? null : Math.round(lengthRatio * 100) / 100,
        medianTokens: base,
        ...structure,
    };
}

/**
 * The scheduled interval (days) a card was sitting on when a given review arrived,
 * derived from the PREVIOUS log's post-review snapshot.
 *
 * Under FSRS this is exact — stability was snapshotted per review, and
 * intervalFromStability is the same function that produced the schedule. Under
 * Leitner/SM-2 there is no memory model to read, so the log's `level` scalar stands in
 * (levelInterval mirrors srs.leitnerInterval). That is an approximation and is labelled
 * as one in the flag's evidence, the same honesty the retention curve already applies
 * with `model: 'approximated'`.
 */
export function levelInterval(level) {
    if (!level || level <= 0) return 0;
    return Math.min(365, Math.pow(2, level - 1));
}

function intervalAfterLog(log) {
    if (log?.fsrs_stability != null) {
        return fsrs.intervalFromStability(log.fsrs_stability, 0.9);
    }
    return levelInterval(log?.level);
}

/**
 * Turn a raw ReviewLogs ledger into the per-review records the detectors read.
 *
 * Synthetic rebuild rows (outcome === null, written by the Vault Doctor) are dropped —
 * they are not reviews and srs.getCardInsights already keeps them out of retention.
 * Rows at or before `epochAt` are dropped too: after the user addresses a card, history
 * from before the fix is not evidence against the card that replaced it.
 */
export function buildReviewRecords(logs, { epochAt = null, sessionIndex = null } = {}) {
    const real = logs.filter(l => l.outcome !== null && l.outcome !== undefined);
    const epochMs = epochAt ? Date.parse(epochAt) : null;
    const out = [];

    for (let i = 0; i < real.length; i++) {
        const log = real[i];
        const at = Date.parse(log.timestamp);
        if (epochMs !== null && !(at > epochMs)) continue;

        // The interval entering this review comes from the previous log — including one
        // that predates the epoch, because the card's schedule genuinely carried over
        // even though its grade history no longer counts.
        const prev = real[i - 1] ?? null;
        const intervalIn = prev ? intervalAfterLog(prev) : 0;
        const elapsedDays = prev ? (at - Date.parse(prev.timestamp)) / DAY_MS : 0;

        const pass = log.rating != null ? log.rating > 1 : log.outcome === 1;
        const session = sessionIndex?.get(log.id) ?? null;

        out.push({
            id: log.id,
            at: log.timestamp,
            atMs: at,
            pass,
            rating: log.rating ?? null,
            intervalIn,
            elapsedDays,
            // A card with no scheduled interval yet (first review, or a lapsed Leitner
            // card in box 0) cannot be "late" — leave the ratio null rather than
            // dividing by zero and calling every new card overdue.
            overdueRatio: intervalIn > 0 ? elapsedDays / intervalIn : null,
            levelAfter: log.level ?? null,
            stabilityAfter: log.fsrs_stability ?? null,
            difficultyAfter: log.fsrs_difficulty ?? null,
            sessionKey: session?.key ?? null,
            sessionPos: session?.pos ?? null,
            sessionLen: session?.len ?? null,
        });
    }
    return out;
}

/**
 * Segment a vault-wide review stream into sessions on inter-review gaps, then index
 * each log id to its normalized position within its session.
 *
 * ReviewLogs has no session id, so this is derived rather than recorded — which has the
 * advantage of working retroactively on every vault's existing history.
 */
export function segmentSessions(rows, gapMs = SESSION_GAP_MS) {
    const index = new Map();
    let session = [];
    let key = 0;
    let lastMs = null;

    const flush = () => {
        if (!session.length) return;
        const len = session.length;
        session.forEach((row, i) => {
            // Single-review sessions have no meaningful position; call it 0 rather
            // than dividing by zero.
            index.set(row.id, { key, pos: len > 1 ? i / (len - 1) : 0, len });
        });
        key += 1;
        session = [];
    };

    for (const row of rows) {
        const ms = Date.parse(row.timestamp);
        if (lastMs !== null && ms - lastMs > gapMs) flush();
        session.push(row);
        lastMs = ms;
    }
    flush();
    return index;
}

/**
 * Segment reviews into LAPSE CYCLES and take the peak interval each one reached.
 *
 * A cycle opens at a failure and closes at the review before the next failure. Its peak
 * is the longest interval the card climbed back to before falling over again. The
 * resulting series P = [P₁ … Pₖ] is the whole discriminator: a probe's peaks climb, a
 * mouthful's sit on a floor.
 */
export function lapseCycles(reviews) {
    const cycles = [];
    let current = null;

    for (const r of reviews) {
        if (!r.pass) {
            if (current) cycles.push(current);
            current = { startedAt: r.at, peak: 0, reviews: 0 };
            continue;
        }
        if (!current) continue;   // passes before the first failure open no cycle
        current.peak = Math.max(current.peak, r.intervalIn);
        current.reviews += 1;
    }
    if (current) cycles.push(current);
    return cycles;
}

/**
 * Does this card's trajectory climb or sit on a floor?
 * Returns { shape: 'converging'|'oscillating'|'unclear', peaks, peakSlope, difficultySlope }.
 */
/**
 * Drop reviews that arrived so far past their due date that the grade measures the
 * delay rather than the card.
 *
 * This runs ahead of every judgement ABOUT the card — the trajectory and the confidence
 * gates — while `overdueDrift` deliberately reads the unfiltered ledger, because lateness
 * is the thing it is reporting. Without this, a card whose failures are only sometimes
 * late (too few to trip the guard) would still have its peak series dragged down by them.
 */
export function onSchedule(reviews) {
    return reviews.filter(r => r.overdueRatio == null || r.overdueRatio <= OVERDUE_EXCLUDE_RATIO);
}

export function classifyTrajectory(allReviews) {
    const reviews = onSchedule(allReviews);
    // Only cycles that actually completed a relearn carry a peak. A cycle that opened
    // at a failure and never got an interval back — the card failed again immediately,
    // or the history simply ends there — has nothing to say about whether the card is
    // climbing, and counting it as a zero would fake a downward trend out of missing data.
    const cycles = lapseCycles(reviews).filter(c => c.reviews > 0);
    const peaks = cycles.map(c => c.peak);

    const difficulties = reviews.map(r => r.difficultyAfter).filter(d => d != null);
    const difficultySlope = difficulties.length >= 3 ? slope(difficulties) : null;

    if (peaks.length < 2) {
        return { shape: 'unclear', peaks, peakSlope: 0, difficultySlope, cycles: peaks.length };
    }

    // log1p so a 1→3 day climb counts like 10→30, and a zero peak (relapsed before ever
    // getting an interval back) stays representable.
    const peakSlope = slope(peaks.map(p => Math.log1p(p)));
    const climbed = peaks[peaks.length - 1] > peaks[0];
    const stuckInLearningBand = peaks.length >= HIGH_MIN_LAPSES
        && Math.max(...peaks) < LEARNING_BAND_DAYS;

    let shape;
    if (stuckInLearningBand) {
        // Never left the learning band after four cycles. Whatever the slope says, this
        // card is not converging on anything.
        shape = 'oscillating';
    } else if (peakSlope > 0 && climbed) {
        shape = 'converging';
    } else if (peakSlope <= 0) {
        shape = 'oscillating';
    } else {
        shape = 'unclear';
    }

    return { shape, peaks, peakSlope, difficultySlope, cycles: peaks.length };
}

// Did the card fail twice inside a single session — after the answer had already been
// shown that day? The moderate-confidence window. Leitner and SM-2 re-queue a failed
// card within the same session (Trainer.jsx), so this is a reachable signal, not a
// theoretical one.
export function hasWithinSessionRepeatFailure(reviews) {
    const failuresPerSession = new Map();
    for (const r of reviews) {
        if (r.pass || r.sessionKey == null) continue;
        const n = (failuresPerSession.get(r.sessionKey) ?? 0) + 1;
        failuresPerSession.set(r.sessionKey, n);
        if (n >= 2) return true;
    }
    return false;
}

// --- Detectors ----------------------------------------------------------------
// Each is a pure function of the prepared context, returning a flag or null.

/**
 * OVERDUE DRIFT (guard). The card failed because it was reviewed weeks past due, not
 * because of how it is built. Compute elapsed/scheduled per review; if most of the
 * card's failures arrived badly late, that is the diagnosis and the trajectory evidence
 * cannot be trusted.
 */
function overdueDrift(ctx) {
    const failures = ctx.reviews.filter(r => !r.pass && r.overdueRatio != null);
    if (failures.length < 3) return null;

    const late = failures.filter(r => r.overdueRatio > OVERDUE_SUSPECT_RATIO);
    if (late.length * 2 < failures.length) return null;

    const worst = Math.max(...late.map(r => r.overdueRatio));
    return {
        kind: 'overdue_drift',
        confidence: 'high',
        score: late.length / failures.length,
        evidence: {
            failures: failures.length,
            lateFailures: late.length,
            worstOverdueRatio: Math.round(worst * 100) / 100,
            medianOverdueRatio: Math.round(median(late.map(r => r.overdueRatio)) * 100) / 100,
        },
    };
}

/**
 * SESSION-POSITION FATIGUE (guard). Cards that habitually land in the last third of a
 * long session show depressed grades regardless of quality. If this card only fails
 * late and passes when it comes up early, the flag belongs on the routine, not the card
 * — and its recommendation says so.
 */
function sessionFatigue(ctx) {
    // A failure that was both weeks late AND at the end of a session is confounded
    // twice; excluding it keeps this guard from claiming a position effect it can't see.
    const positioned = onSchedule(ctx.reviews)
        .filter(r => r.sessionPos != null && r.sessionLen >= FATIGUE_MIN_SESSION_LEN);
    const failures = positioned.filter(r => !r.pass);
    if (failures.length < 3) return null;

    const lateFailures = failures.filter(r => r.sessionPos > LATE_SESSION_POSITION);
    if (lateFailures.length < failures.length * 0.75) return null;

    // It only counts as a position effect if the card demonstrably works early on.
    const earlyPasses = positioned.filter(r => r.pass && r.sessionPos <= LATE_SESSION_POSITION);
    if (earlyPasses.length < 2) return null;

    return {
        kind: 'session_fatigue',
        confidence: 'moderate',
        score: lateFailures.length / failures.length,
        evidence: {
            failures: failures.length,
            lateFailures: lateFailures.length,
            earlyPasses: earlyPasses.length,
            medianFailurePosition: Math.round(median(failures.map(r => r.sessionPos)) * 100) / 100,
        },
    };
}

// Both signatures share the same gate arithmetic, so it lives here once.
function confidenceFor(ctx) {
    // Badly-overdue reviews are excluded here too: a lapse that only happened because the
    // card surfaced six weeks late must not help push it over the four-lapse threshold.
    const reviews = onSchedule(ctx.reviews);
    const failures = reviews.filter(r => !r.pass);
    if (!reviews.length) return { level: null, failures: failures.length, windowDays: 0 };

    const windowDays = (reviews[reviews.length - 1].atMs - reviews[0].atMs) / DAY_MS;

    // The maturation window: enough lapses AND enough calendar time for a trend to mean
    // anything. Four lapses inside five days is one bad afternoon, not a trajectory.
    if (failures.length >= HIGH_MIN_LAPSES && windowDays >= HIGH_MIN_WINDOW_DAYS) {
        return { level: 'high', failures: failures.length, windowDays };
    }
    if (failures.length >= MODERATE_MIN_FAILURES && ctx.repeatFailure) {
        return { level: 'moderate', failures: failures.length, windowDays };
    }
    return { level: null, failures: failures.length, windowDays };
}

// Leitner and SM-2 carry no difficulty signal, so a verdict reached without one rests on
// peaks plus the structural prior alone. Cap it a step lower and say so in the evidence.
function capConfidence(level, ctx) {
    if (level === 'high' && ctx.trajectory.difficultySlope === null) return 'moderate';
    return level;
}

function signatureEvidence(ctx, gate) {
    return {
        trajectory: ctx.trajectory.shape,
        peaks: ctx.trajectory.peaks.map(p => Math.round(p * 100) / 100),
        peakSlope: Math.round(ctx.trajectory.peakSlope * 1000) / 1000,
        difficultySlope: ctx.trajectory.difficultySlope === null
            ? null : Math.round(ctx.trajectory.difficultySlope * 1000) / 1000,
        // The absence of a difficulty signal is itself worth reporting — it is why the
        // confidence is capped, and the UI should be able to explain that.
        memoryModel: ctx.trajectory.difficultySlope === null ? 'approximated' : 'fsrs',
        prior: ctx.structure.prior,
        answerTokens: ctx.structure.tokens,
        medianAnswerTokens: ctx.structure.medianTokens,
        lengthRatio: ctx.structure.lengthRatio,
        chunks: ctx.structure.chunks,
        lapses: gate.failures,
        windowDays: Math.round(gate.windowDays * 10) / 10,
        repeatFailureInSession: ctx.repeatFailure,
    };
}

/**
 * MOUTHFUL. Oscillates around a floor: every lapse resets to roughly the same short
 * interval and re-lapses at roughly the same retrievability, difficulty ratchets up,
 * the card never exits the learning band. Combined with the structural prior rather
 * than used alone — a long answer that also refuses to converge is the strong case.
 */
function mouthful(ctx) {
    const gate = confidenceFor(ctx);
    const { shape } = ctx.trajectory;

    // Soft case: not enough history for a trajectory yet, but the card has already
    // failed twice in one session AND its answer is overloaded. Corroborated prior,
    // never the prior alone.
    if (shape === 'unclear') {
        if (gate.level === 'moderate' && ctx.structure.prior === 'overloaded') {
            return {
                kind: 'mouthful',
                confidence: 'moderate',
                score: 0.5,
                evidence: { ...signatureEvidence(ctx, gate), basis: 'structural prior + within-session repeat failure' },
            };
        }
        return null;
    }

    if (shape !== 'oscillating') return null;
    if (!gate.level) return null;

    // A compact answer that oscillates is not a mouthful — there is nothing to split.
    // It reads as a probe instead; see below.
    if (ctx.structure.prior === 'compact') return null;

    // A neutral answer is weaker evidence than an overloaded one.
    const level = ctx.structure.prior === 'overloaded'
        ? gate.level
        : (gate.level === 'high' ? 'moderate' : gate.level);

    return {
        kind: 'mouthful',
        confidence: capConfidence(level, ctx),
        score: ctx.structure.prior === 'overloaded' ? 0.9 : 0.6,
        evidence: { ...signatureEvidence(ctx, gate), basis: 'oscillating trajectory + answer load' },
    };
}

/**
 * PROBE. Converges: lapses cluster early, each relearn cycle ends at a longer interval
 * than the last, stability trends upward despite failures, difficulty plateaus or falls.
 * A bumpy climb.
 *
 * Also claims the compact-but-oscillating case — a card that is short, offers nothing to
 * split, and still keeps failing is most likely colliding with a wrong assumption. That
 * combination is the single case this whole feature exists to get right: measured on
 * pass rate alone it is indistinguishable from a mouthful, and the advice is the opposite.
 */
function probe(ctx) {
    const gate = confidenceFor(ctx);
    if (!gate.level) return null;

    const { shape } = ctx.trajectory;
    const compactAndStuck = shape === 'oscillating' && ctx.structure.prior === 'compact';
    if (shape !== 'converging' && !compactAndStuck) return null;

    return {
        kind: 'probe',
        confidence: capConfidence(gate.level, ctx),
        score: shape === 'converging' ? 0.9 : 0.6,
        evidence: {
            ...signatureEvidence(ctx, gate),
            basis: shape === 'converging'
                ? 'converging trajectory — intervals climb across relearn cycles'
                : 'repeated failure on a compact answer — nothing to split',
        },
    };
}

// Guards first: their verdicts survive, and their presence withdraws the signatures.
const DETECTORS = [overdueDrift, sessionFatigue, mouthful, probe];

// --- Service ------------------------------------------------------------------

class CardHealthService {
    constructor() {
        this._sessionCache = null;     // { at, index }
        this._baselineCache = null;    // { at, medianTokens }
    }

    // Test seam: detectors are pure, so a unit test can drive them from a hand-built
    // context without a database.
    runDetectors(ctx) {
        const raised = [];
        for (const detect of DETECTORS) {
            const flag = detect(ctx);
            if (flag) raised.push(flag);
        }
        // Precedence: a guard means the trajectory evidence is contaminated, so the
        // mouthful/probe verdicts computed from it are withdrawn rather than shown
        // alongside. The guard IS the diagnosis.
        const guarded = raised.some(f => GUARD_KINDS.includes(f.kind));
        return guarded ? raised.filter(f => GUARD_KINDS.includes(f.kind)) : raised;
    }

    // --- Context assembly (the only impure part) ---

    _sessionIndex() {
        const now = Date.now();
        if (this._sessionCache && now - this._sessionCache.at < SESSION_CACHE_MS) {
            return this._sessionCache.index;
        }
        const since = new Date(now - SESSION_WINDOW_DAYS * DAY_MS).toISOString();
        const index = segmentSessions(query.getRecentReviewSessionRows(since));
        this._sessionCache = { at: now, index };
        return index;
    }

    _medianAnswerTokens() {
        const now = Date.now();
        if (this._baselineCache && now - this._baselineCache.at < SESSION_CACHE_MS) {
            return this._baselineCache.medianTokens;
        }
        const samples = query.getFlashcardAnswerSamples();
        const counts = samples
            .map(s => analyzeStructure({
                cardType: s.card_type, backText: s.backText, customHtml: s.custom_html,
            }).tokens)
            .filter(n => n > 0);
        const medianTokens = median(counts);
        this._baselineCache = { at: now, medianTokens };
        return medianTokens;
    }

    // Caches are keyed on time, not content, so a write invalidates nothing on its own.
    // Tests and the review path both need a way to force a recompute.
    resetCaches() {
        this._sessionCache = null;
        this._baselineCache = null;
    }

    // Identifies a card's *content*, so an edit is detectable without an edit hook.
    // NUL separates the fields because it cannot occur inside any of them — joining on a
    // printable character would let a back text ending in that character collide with the
    // next field and hide a real edit.
    _fingerprint(content) {
        return crypto.createHash('sha256').update([
            content?.frontText ?? '', content?.backText ?? '',
            content?.custom_html ?? '', content?.card_type ?? '',
        ].join('\u0000')).digest('hex').slice(0, 32);
    }

    /**
     * Assemble everything the detectors read about one card.
     *
     * Resolves the analysis epoch first, because it decides which reviews are even
     * evidence. A changed content fingerprint resets the epoch here rather than relying
     * on an edit hook — that makes it self-healing, catching edits through any path
     * (the PUT route, MCP, a Seal rollback, a Doctor reindex) with no coupling to any
     * of them.
     */
    buildContext(hash) {
        const content = query.getFlashcardContentByHash(hash);
        if (!content) return null;

        const fingerprint = this._fingerprint(content);
        let health = query.getCardHealth(content.id);

        if (health && health.content_fingerprint && health.content_fingerprint !== fingerprint) {
            // The card was edited out from under its flags. Analysis restarts here:
            // history from before the fix is not evidence against what replaced it.
            query.deleteCardFlags(content.id, { includeDismissed: true });
            query.upsertCardHealth(content.id, {
                epochAt: new Date().toISOString(), epochReason: 'edit', contentFingerprint: fingerprint,
            });
            health = query.getCardHealth(content.id);
        } else if (!health) {
            query.upsertCardHealth(content.id, { epochAt: null, epochReason: null, contentFingerprint: fingerprint });
            health = query.getCardHealth(content.id);
        } else if (health.content_fingerprint !== fingerprint) {
            query.setCardHealthFingerprint(content.id, fingerprint);
        }

        const logs = query.getFlashcardReviewHistory(content.id);
        const reviews = buildReviewRecords(logs, {
            epochAt: health?.epoch_at ?? null,
            sessionIndex: this._sessionIndex(),
        });

        const structure = structuralPrior(
            analyzeStructure({
                cardType: content.card_type, backText: content.backText,
                customHtml: content.custom_html, frontText: content.frontText,
            }),
            this._medianAnswerTokens(),
        );

        return {
            cardId: content.id,
            hash,
            content,
            epoch: { at: health?.epoch_at ?? null, reason: health?.epoch_reason ?? null },
            reviews,
            structure,
            trajectory: classifyTrajectory(reviews),
            repeatFailure: hasWithinSessionRepeatFailure(reviews),
            lastReviewId: reviews.length ? reviews[reviews.length - 1].id : null,
            level: query.getFlashcardSrsStateByHash(hash)?.level ?? 0,
        };
    }

    /**
     * Classify one card and persist the result. Called only when a card has just FAILED
     * — there is no reason to guess at why a card is failing when it isn't.
     */
    evaluate(hash) {
        const ctx = this.buildContext(hash);
        if (!ctx) return [];

        const raised = this.runDetectors(ctx);
        const raisedKinds = raised.map(f => f.kind);

        // Withdraw any live flag the current evidence no longer supports (a guard that
        // has taken over, or a verdict that flipped). Dismissed rows are left alone.
        const stale = FLAG_KINDS.filter(k => !raisedKinds.includes(k));
        if (stale.length) query.deleteCardFlags(ctx.cardId, { kinds: stale });

        for (const flag of raised) {
            query.upsertCardFlag({
                flashcardId: ctx.cardId,
                kind: flag.kind,
                confidence: flag.confidence,
                score: flag.score,
                evidence: flag.evidence,
                levelAtDetection: ctx.level,
                reviewLogId: ctx.lastReviewId,
            });
        }

        return this.getFlags(hash);
    }

    /**
     * The review hook. Composed at the route after the review is persisted.
     *
     * Failure  → classify.
     * Pass at RECOVERY_LEVEL or above → the card has recovered: drop its flags and
     *            restart the analysis window from here.
     * Pass below that → nothing. A mouthful passing at a one-day interval has not
     *            recovered, and treating every pass as success is what would make this
     *            feature useless.
     */
    onReview(hash, { outcome = null, rating = null } = {}) {
        const failed = rating != null ? rating <= 1 : outcome === 0;
        if (failed) return this.evaluate(hash);

        const state = query.getFlashcardSrsStateByHash(hash);
        if (!state) return [];
        if ((state.level ?? 0) >= RECOVERY_LEVEL) this._address(state.id, 'recovered');

        // Nothing is ever announced on a pass. Existing flags stay readable in the card
        // detail view; the Trainer only speaks up when a card has just failed.
        return [];
    }

    /**
     * A card's content changed. Its flags describe a card that no longer exists.
     *
     * buildContext's fingerprint check is the correctness mechanism and catches edits
     * through every path; this exists so the flag disappears the moment the user saves
     * rather than at their next failing review.
     */
    onCardEdited(hash) {
        const content = query.getFlashcardContentByHash(hash);
        if (!content) return;
        query.deleteCardFlags(content.id, { includeDismissed: true });
        query.upsertCardHealth(content.id, {
            epochAt: new Date().toISOString(),
            epochReason: 'edit',
            contentFingerprint: this._fingerprint(content),
        });
    }

    /**
     * The user has ruled on this flag. Suppress it so it stops re-announcing itself on
     * every later failure, and reset the analysis window so that if it ever comes back
     * it argues from evidence gathered after the user looked, not before.
     */
    dismiss(hash, kind) {
        if (!FLAG_KINDS.includes(kind)) throw new Error(`Unknown flag kind: ${kind}`);
        const content = query.getFlashcardContentByHash(hash);
        if (!content) throw new Error(`Card not found: ${hash}`);
        const changed = query.dismissCardFlag(content.id, kind);
        // Only the named flag is suppressed — a card can carry both guards at once, and
        // ruling on one says nothing about the other. The watermark still moves, so a
        // re-raise later argues from evidence gathered after the user looked.
        if (changed) this._setEpoch(content.id, 'dismissed');
        return changed > 0;
    }

    // Move the analysis watermark to now, preserving the stored fingerprint.
    _setEpoch(cardId, reason) {
        const existing = query.getCardHealth(cardId);
        query.upsertCardHealth(cardId, {
            epochAt: new Date().toISOString(),
            epochReason: reason,
            contentFingerprint: existing?.content_fingerprint ?? null,
        });
    }

    // "The user addressed this card": clear the live flags and restart the window.
    _address(cardId, reason) {
        query.deleteCardFlags(cardId);
        this._setEpoch(cardId, reason);
    }

    /**
     * The card's live flags, shaped for the UI: a title, the recommended action, and the
     * numbers behind the verdict so the reader can disagree with it. Never an oracle.
     */
    getFlags(hash) {
        const content = query.getFlashcardContentByHash(hash);
        if (!content) return [];
        return query.getCardFlags(content.id).map(row => {
            const evidence = row.evidence_json ? JSON.parse(row.evidence_json) : {};
            return {
                id: `${row.kind}:${row.flashcard_id}`,
                kind: row.kind,
                confidence: row.confidence,
                score: row.score,
                detectedAt: row.detected_at,
                levelAtDetection: row.level_at_detection,
                evidence,
                ...PRESENTATION[row.kind],
            };
        });
    }
}

// Copy lives next to the detectors so a new detector arrives with its own explanation
// rather than an unlabelled kind string. `action` names what the user might do; nothing
// here is ever applied automatically.
const PRESENTATION = {
    mouthful: {
        title: 'Looks overloaded',
        detail: 'This card keeps resetting to the same short interval instead of climbing. Its answer is long relative to the rest of your vault, so the difficulty most likely comes from how much it asks you to hold at once.',
        action: 'Split it into smaller cards',
        actionKind: 'split',
    },
    probe: {
        title: 'Productive difficulty',
        detail: 'This card fails often but recovers to longer intervals each time. It is making you confront something you had wrong. Splitting it would remove the useful part.',
        action: 'Keep it — optionally add a companion card naming the misconception',
        actionKind: 'companion',
    },
    overdue_drift: {
        title: 'Reviewed too late to judge',
        detail: 'This card mostly fails when it comes up well past its due date.',
        action: 'Review it closer to its due date, then look again',
        actionKind: 'schedule',
    },
    session_fatigue: {
        title: 'Fails late in long sessions',
        detail: 'This card passes when it comes up early and fails when it lands near the end of a long session. The pattern belongs to the routine rather than to the card.',
        action: 'Shorten your sessions or do them by theme using the trainer filter',
        actionKind: 'routine',
    },
};

export { PRESENTATION, RECOVERY_LEVEL };
export default new CardHealthService();
