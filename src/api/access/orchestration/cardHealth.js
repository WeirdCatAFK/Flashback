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
import query from '../resources/query.js';
import { currentScope, OWNER_SCOPE } from '../../requestContext.js';
import * as fsrs from './fsrs.js';

const DAY_MS = 86400000;

const RECOVERY_LEVEL = 3;

const OVERDUE_EXCLUDE_RATIO = 3.0;
const OVERDUE_SUSPECT_RATIO = 2.0;

const SESSION_GAP_MS = 30 * 60 * 1000;
const SESSION_WINDOW_DAYS = 90;
const SESSION_CACHE_MS = 60000;

const LATE_SESSION_POSITION = 0.66;
const FATIGUE_MIN_SESSION_LEN = 20;

const HIGH_MIN_LAPSES = 4;
const HIGH_MIN_WINDOW_DAYS = 14;
const MODERATE_MIN_FAILURES = 2;

const LEARNING_BAND_DAYS = 7;

const OVERLOADED_LENGTH_RATIO = 2.0;
const OVERLOADED_CHUNKS = 4;
const OVERLOADED_TOKENS = 40;
const COMPACT_LENGTH_RATIO = 1.0;
const COMPACT_CHUNKS = 2;

const GUARD_KINDS = ['overdue_drift', 'session_fatigue'];
const SIGNATURE_KINDS = ['mouthful', 'probe'];
export const FLAG_KINDS = [...GUARD_KINDS, ...SIGNATURE_KINDS];

function median(nums) {
    if (!nums.length) return null;
    const s = [...nums].sort((a, b) => a - b);
    const mid = s.length / 2;
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[mid - 1] + s[mid]) / 2;
}

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

/** Strips markup from card content so the classifier tokenizes what a reviewer actually reads. */
export function plainText(html) {
    if (!html) return '';
    return String(html)
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&[a-z]+;/gi, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/[ \t]*\n[ \t\n]*/g, '\n')
        .trim();
}

/** The text a card actually asks the reviewer to produce, given a content row. */
export function answerBody(row = {}) {
    const type = row.card_type ?? row.cardType;
    if (type === 'type_answer') return row.answerText ?? row.backText ?? null;
    return row.backText ?? null;
}

/** The load a card's answer puts on the reviewer, as far as it can be measured from static text. */
export function analyzeStructure({ cardType, backText, customHtml, frontText } = {}) {
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

    const chunks = Math.max(lines.length, listItems, clauses, clozeDeletions);

    return { tokens, lines: lines.length, listItems, clauses, clozeDeletions, chunks };
}

/** Classify structure against the vault's own baseline. */
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

/** The scheduled interval (days) a card was sitting on when a given review arrived, derived from the PREVIOUS log's post-review snapshot. */
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

/** Turn a raw ReviewLogs ledger into the per-review records the detectors read. */
export function buildReviewRecords(logs, { epochAt = null, sessionIndex = null } = {}) {
    const real = logs.filter(l => l.outcome !== null && l.outcome !== undefined);
    const epochMs = epochAt ? Date.parse(epochAt) : null;
    const out = [];

    for (let i = 0; i < real.length; i++) {
        const log = real[i];
        const at = Date.parse(log.timestamp);
        if (epochMs !== null && !(at > epochMs)) continue;

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

/** Segment a vault-wide review stream into sessions on inter-review gaps, then index each log id to its normalized position within its session. */
export function segmentSessions(rows, gapMs = SESSION_GAP_MS) {
    const index = new Map();
    let session = [];
    let key = 0;
    let lastMs = null;

    const flush = () => {
        if (!session.length) return;
        const len = session.length;
        session.forEach((row, i) => {
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

/** Segment reviews into LAPSE CYCLES and take the peak interval each one reached. */
export function lapseCycles(reviews) {
    const cycles = [];
    let current = null;

    for (const r of reviews) {
        if (!r.pass) {
            if (current) cycles.push(current);
            current = { startedAt: r.at, peak: 0, reviews: 0 };
            continue;
        }
        if (!current) continue;
        current.peak = Math.max(current.peak, r.intervalIn);
        current.reviews += 1;
    }
    if (current) cycles.push(current);
    return cycles;
}

/** Does this card's trajectory climb or sit on a floor? */
/** Drop reviews that arrived so far past their due date that the grade measures the delay rather than the card. */
export function onSchedule(reviews) {
    return reviews.filter(r => r.overdueRatio == null || r.overdueRatio <= OVERDUE_EXCLUDE_RATIO);
}

/** Reads a card's interval trajectory as growing, flat or collapsing. */
export function classifyTrajectory(allReviews) {
    const reviews = onSchedule(allReviews);
    const cycles = lapseCycles(reviews).filter(c => c.reviews > 0);
    const peaks = cycles.map(c => c.peak);

    const difficulties = reviews.map(r => r.difficultyAfter).filter(d => d != null);
    const difficultySlope = difficulties.length >= 3 ? slope(difficulties) : null;

    if (peaks.length < 2) {
        return { shape: 'unclear', peaks, peakSlope: 0, difficultySlope, cycles: peaks.length };
    }

    const peakSlope = slope(peaks.map(p => Math.log1p(p)));
    const climbed = peaks[peaks.length - 1] > peaks[0];
    const stuckInLearningBand = peaks.length >= HIGH_MIN_LAPSES
        && Math.max(...peaks) < LEARNING_BAND_DAYS;

    let shape;
    if (stuckInLearningBand) {
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

/** True when the card failed more than once inside a single session. */
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

/** OVERDUE DRIFT (guard). */
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

/** SESSION-POSITION FATIGUE (guard). */
function sessionFatigue(ctx) {
    const positioned = onSchedule(ctx.reviews)
        .filter(r => r.sessionPos != null && r.sessionLen >= FATIGUE_MIN_SESSION_LEN);
    const failures = positioned.filter(r => !r.pass);
    if (failures.length < 3) return null;

    const lateFailures = failures.filter(r => r.sessionPos > LATE_SESSION_POSITION);
    if (lateFailures.length < failures.length * 0.75) return null;

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

function confidenceFor(ctx) {
    const reviews = onSchedule(ctx.reviews);
    const failures = reviews.filter(r => !r.pass);
    if (!reviews.length) return { level: null, failures: failures.length, windowDays: 0 };

    const windowDays = (reviews[reviews.length - 1].atMs - reviews[0].atMs) / DAY_MS;

    if (failures.length >= HIGH_MIN_LAPSES && windowDays >= HIGH_MIN_WINDOW_DAYS) {
        return { level: 'high', failures: failures.length, windowDays };
    }
    if (failures.length >= MODERATE_MIN_FAILURES && ctx.repeatFailure) {
        return { level: 'moderate', failures: failures.length, windowDays };
    }
    return { level: null, failures: failures.length, windowDays };
}

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

/** MOUTHFUL. */
function mouthful(ctx) {
    const gate = confidenceFor(ctx);
    const { shape } = ctx.trajectory;

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

    if (ctx.structure.prior === 'compact') return null;

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

/** PROBE. */
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

const DETECTORS = [overdueDrift, sessionFatigue, mouthful, probe];

class CardHealthService {
    constructor() {
        this._sessionCache = new Map();
        this._baselineCache = null;
    }

    /** Drops both caches. */
    onVaultOpened() {
        this._sessionCache.clear();
        this._baselineCache = null;
    }

    /** Whose analysis this is. Resolved once per public entry point, like srs.js. */
    _scope(explicit) {
        return explicit ?? currentScope();
    }

    /** Runs every detector over one card's evidence and returns the flags they raise. */
    runDetectors(ctx) {
        const raised = [];
        for (const detect of DETECTORS) {
            const flag = detect(ctx);
            if (flag) raised.push(flag);
        }
        const guarded = raised.some(f => GUARD_KINDS.includes(f.kind));
        return guarded ? raised.filter(f => GUARD_KINDS.includes(f.kind)) : raised;
    }

    async _sessionIndex(scope) {
        const now = Date.now();
        const cached = this._sessionCache.get(scope);
        if (cached && now - cached.at < SESSION_CACHE_MS) return cached.index;

        const since = new Date(now - SESSION_WINDOW_DAYS * DAY_MS).toISOString();
        const index = segmentSessions(await query.getRecentReviewSessionRows(since, scope));
        this._sessionCache.set(scope, { at: now, index });
        return index;
    }

    async _medianAnswerTokens() {
        const now = Date.now();
        if (this._baselineCache && now - this._baselineCache.at < SESSION_CACHE_MS) {
            return this._baselineCache.medianTokens;
        }
        const samples = await query.getFlashcardAnswerSamples();
        const counts = samples
            .map(s => analyzeStructure({
                cardType: s.card_type, backText: answerBody(s), customHtml: s.custom_html,
            }).tokens)
            .filter(n => n > 0);
        const medianTokens = median(counts);
        this._baselineCache = { at: now, medianTokens };
        return medianTokens;
    }

    /** Drops the session and baseline caches on a vault switch. */
    resetCaches() {
        this._sessionCache.clear();
        this._baselineCache = null;
    }

    _fingerprint(content) {
        return crypto.createHash('sha256').update([
            content?.frontText ?? '', content?.backText ?? '', content?.answerText ?? '',
            content?.custom_html ?? '', content?.card_type ?? '',
        ].join('\u0000')).digest('hex').slice(0, 32);
    }

    /** Assemble everything the detectors read about one card. */
    async buildContext(hash, scopeArg) {
        const scope = this._scope(scopeArg);
        const content = await query.getFlashcardContentByHash(hash, scope);
        if (!content) return null;

        const fingerprint = this._fingerprint(content);
        let health = await query.getCardHealth(content.id, scope);

        if (health && health.content_fingerprint && health.content_fingerprint !== fingerprint) {
            await query.deleteCardFlags(content.id, { includeDismissed: true }, scope);
            await query.upsertCardHealth(content.id, {
                epochAt: new Date().toISOString(), epochReason: 'edit', contentFingerprint: fingerprint,
            }, scope);
            health = await query.getCardHealth(content.id, scope);
        } else if (!health) {
            await query.upsertCardHealth(content.id, { epochAt: null, epochReason: null, contentFingerprint: fingerprint }, scope);
            health = await query.getCardHealth(content.id, scope);
        } else if (health.content_fingerprint !== fingerprint) {
            await query.setCardHealthFingerprint(content.id, fingerprint, scope);
        }

        const logs = await query.getFlashcardReviewHistory(content.id, scope);
        const reviews = buildReviewRecords(logs, {
            epochAt: health?.epoch_at ?? null,
            sessionIndex: await this._sessionIndex(scope),
        });

        const structure = structuralPrior(
            analyzeStructure({
                cardType: content.card_type, backText: answerBody(content),
                customHtml: content.custom_html, frontText: content.frontText,
            }),
            await this._medianAnswerTokens(),
        );

        return {
            cardId: content.id,
            hash,
            scope,
            content,
            epoch: { at: health?.epoch_at ?? null, reason: health?.epoch_reason ?? null },
            reviews,
            structure,
            trajectory: classifyTrajectory(reviews),
            repeatFailure: hasWithinSessionRepeatFailure(reviews),
            lastReviewId: reviews.length ? reviews[reviews.length - 1].id : null,
            level: (await query.getFlashcardSrsStateByHash(hash, scope))?.level ?? 0,
        };
    }

    /** Classify one card and persist the result. */
    async evaluate(hash, scopeArg) {
        const ctx = await this.buildContext(hash, scopeArg);
        if (!ctx) return [];

        const raised = this.runDetectors(ctx);
        const raisedKinds = raised.map(f => f.kind);

        const stale = FLAG_KINDS.filter(k => !raisedKinds.includes(k));
        if (stale.length) await query.deleteCardFlags(ctx.cardId, { kinds: stale }, ctx.scope);

        for (const flag of raised) {
            await query.upsertCardFlag({
                flashcardId: ctx.cardId,
                kind: flag.kind,
                confidence: flag.confidence,
                score: flag.score,
                evidence: flag.evidence,
                levelAtDetection: ctx.level,
                reviewLogId: ctx.lastReviewId,
            }, ctx.scope);
        }

        return await this.getFlags(hash, ctx.scope);
    }

    /** The review hook. */
    async onReview(hash, { outcome = null, rating = null } = {}, scopeArg) {
        const scope = this._scope(scopeArg);
        const failed = rating != null ? rating <= 1 : outcome === 0;
        if (failed) return await this.evaluate(hash, scope);

        const state = await query.getFlashcardSrsStateByHash(hash, scope);
        if (!state) return [];
        if ((state.level ?? 0) >= RECOVERY_LEVEL) await this._address(state.id, 'recovered', scope);

        return [];
    }

    /** A card's content changed. */
    async onCardEdited(hash) {
        const content = await query.getFlashcardContentByHash(hash, OWNER_SCOPE);
        if (!content) return;
        await query.deleteAllCardFlags(content.id);
        await query.resetAllCardHealth(content.id, {
            epochAt: new Date().toISOString(),
            epochReason: 'edit',
            contentFingerprint: this._fingerprint(content),
        });
    }

    /** The user has ruled on this flag. */
    async dismiss(hash, kind, scopeArg) {
        if (!FLAG_KINDS.includes(kind)) throw new Error(`Unknown flag kind: ${kind}`);
        const scope = this._scope(scopeArg);
        const content = await query.getFlashcardContentByHash(hash, scope);
        if (!content) throw new Error(`Card not found: ${hash}`);
        const changed = await query.dismissCardFlag(content.id, kind, scope);
        if (changed) await this._setEpoch(content.id, 'dismissed', scope);
        return changed > 0;
    }

    async _setEpoch(cardId, reason, scope) {
        const existing = await query.getCardHealth(cardId, scope);
        await query.upsertCardHealth(cardId, {
            epochAt: new Date().toISOString(),
            epochReason: reason,
            contentFingerprint: existing?.content_fingerprint ?? null,
        }, scope);
    }

    async _address(cardId, reason, scope) {
        await query.deleteCardFlags(cardId, {}, scope);
        await this._setEpoch(cardId, reason, scope);
    }

    /** The card's live flags, shaped for the UI: a title, the recommended action, and the numbers behind the verdict so the reader can disagree with it. */
    async getFlags(hash, scopeArg) {
        const scope = this._scope(scopeArg);
        const content = await query.getFlashcardContentByHash(hash, scope);
        if (!content) return [];
        return (await query.getCardFlags(content.id, {}, scope)).map(row => {
            const evidence = row.evidence_json ? JSON.parse(row.evidence_json) : {};
            return {
                id: `${row.kind}:${row.card_hash}`,
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
