// Card-health classifier tests — the correctness backstop for failure-signature
// detection.
//
// Every assertion here runs against a synthesized review history, never the database:
// the detectors are pure functions of a prepared context, which is the whole reason
// buildContext() does the impure work separately. (Importing the module still opens the
// shared dev connection, because access/database.js connects eagerly — but nothing below
// reads or writes it.) Persistence and lifecycle are covered at the HTTP layer in
// tests/api/api.test.js instead.
//
// Run: node --test tests/cardHealth.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import process from 'process';
import cardHealth, {
    analyzeStructure,
    structuralPrior,
    buildReviewRecords,
    segmentSessions,
    lapseCycles,
    classifyTrajectory,
    onSchedule,
    hasWithinSessionRepeatFailure,
    levelInterval,
    plainText,
    FLAG_KINDS,
    PRESENTATION,
} from '../src/api/access/cardHealth.js';

process.env.USER_DATA_PATH = path.join(process.cwd(), 'data');

const DAY = 86400000;
const T0 = Date.parse('2026-01-01T09:00:00.000Z');
const at = (days, minutes = 0) => new Date(T0 + days * DAY + minutes * 60000).toISOString();

// --- History builders ---------------------------------------------------------
// A log row as ReviewLogs stores it. `stability` present ⇒ the card was graded under
// FSRS (which is also how the classifier decides whether a difficulty signal exists).

let nextId = 1;
const log = ({ day, minute = 0, pass, level = 1, stability = null, difficulty = null }) => ({
    id: nextId++,
    timestamp: at(day, minute),
    outcome: pass ? 1 : 0,
    ease_factor: 2.5,
    level,
    algorithm: stability != null ? 'fsrs' : 'leitner',
    rating: stability != null ? (pass ? 3 : 1) : null,
    fsrs_stability: stability,
    fsrs_difficulty: difficulty,
    fsrs_due: null,
    fsrs_state: null,
});

// Build a ladder of lapse cycles: each entry is the peak interval that cycle climbs to.
// Emits fail → pass → pass … so the peak interval entering each cycle's last pass is
// `peak`.
//
// `spacing` inserts idle days between cycles. It defaults to 0 because reviews here
// arrive ON schedule — padding the calendar to clear the maturation gate would instead
// make every review overdue, and `overdue_drift` would (correctly) suppress the verdict
// under test. Calendar span has to come from the intervals themselves, which is why the
// oscillating fixtures below sit on a 3-day floor rather than a 1-day one.
function ladder(peaks, { fsrs = true, difficultyStart = 5, difficultyStep = 0, spacing = 0 } = {}) {
    const logs = [];
    let day = 0;
    let difficulty = difficultyStart;
    for (const peak of peaks) {
        // The lapse itself: resets to a 1-day interval.
        logs.push(log({ day, pass: false, level: 1, stability: fsrs ? 1 : null, difficulty: fsrs ? difficulty : null }));
        day += 1;
        difficulty += difficultyStep;
        // Climb: 1 → … → peak. Each pass is scheduled at the previous stability, so the
        // interval ENTERING the final pass is `peak`.
        let s = 1;
        while (s < peak) {
            const next = Math.min(peak, s * 3);
            logs.push(log({
                day, pass: true,
                level: Math.round(Math.log2(next) + 1),
                stability: fsrs ? next : null,
                difficulty: fsrs ? difficulty : null,
            }));
            day += next;
            s = next;
        }
        // One more pass so the peak interval is actually observed as an `intervalIn`.
        logs.push(log({
            day, pass: true, level: Math.round(Math.log2(s) + 1),
            stability: fsrs ? s : null, difficulty: fsrs ? difficulty : null,
        }));
        day += 1 + spacing;
    }
    return logs;
}

const records = (logs, opts) => buildReviewRecords(logs, opts);

// A context shaped exactly as buildContext() produces one, but assembled by hand — the
// detectors are pure, so this is all they need.
function ctxFrom(logs, { prior = 'neutral', tokens = 12, medianTokens = 12, level = 1, sessionIndex = null } = {}) {
    const reviews = records(logs, { sessionIndex });
    const structure = {
        prior, tokens, medianTokens,
        lengthRatio: medianTokens ? tokens / medianTokens : null,
        chunks: prior === 'overloaded' ? 5 : 1,
        lines: 1, listItems: 0, clauses: 1, clozeDeletions: 0,
    };
    return {
        cardId: 1, hash: 'h', content: {},
        epoch: { at: null, reason: null },
        reviews,
        structure,
        trajectory: classifyTrajectory(reviews),
        repeatFailure: hasWithinSessionRepeatFailure(reviews),
        lastReviewId: reviews.at(-1)?.id ?? null,
        level,
    };
}

const kinds = (flags) => flags.map(f => f.kind).sort();

// ------------------------------------------------------------------------------

describe('plainText / analyzeStructure', () => {
    it('measures prose, not markup', () => {
        assert.equal(plainText('<p>one <b>two</b></p><br>three'), 'one two\nthree');
        assert.equal(analyzeStructure({ backText: '<p>alpha beta</p>' }).tokens, 2);
    });

    it('counts a cloze card by its deletions, not its prose length', () => {
        const s = analyzeStructure({
            cardType: 'cloze',
            frontText: 'The {{c1::first}}, {{c2::second}}, {{c3::third}}, {{c4::fourth}} items',
            backText: 'x',
        });
        assert.equal(s.clozeDeletions, 4);
        assert.ok(s.chunks >= 4, 'four deletions is four things to hold');
    });

    it('treats list items and clauses as separate chunks', () => {
        const s = analyzeStructure({ backText: '- alpha\n- beta\n- gamma\n- delta' });
        assert.equal(s.listItems, 4);
        assert.equal(s.chunks, 4);
    });
});

describe('structuralPrior', () => {
    it('is relative to the vault, not an absolute character count', () => {
        const long = analyzeStructure({ backText: 'one two three four five six seven eight' });
        // Same card, two different vaults.
        assert.equal(structuralPrior(long, 4).prior, 'overloaded');   // terse vault
        assert.equal(structuralPrior(long, 30).prior, 'compact');     // verbose vault
    });

    it('flags many chunks as overloaded even when short', () => {
        const s = analyzeStructure({ backText: '- a\n- b\n- c\n- d' });
        assert.equal(structuralPrior(s, 20).prior, 'overloaded');
    });
});

describe('levelInterval', () => {
    it('mirrors srs.leitnerInterval, including the level-0 floor', () => {
        assert.equal(levelInterval(0), 0);
        assert.equal(levelInterval(1), 1);
        assert.equal(levelInterval(3), 4);
        assert.equal(levelInterval(6), 32);
    });
});

describe('buildReviewRecords', () => {
    it('drops synthetic rebuild rows (outcome null) — they are not reviews', () => {
        const logs = [
            log({ day: 0, pass: true }),
            { ...log({ day: 1, pass: true }), outcome: null },
            log({ day: 2, pass: false }),
        ];
        assert.equal(records(logs).length, 2);
    });

    it('derives the interval entering each review from the previous log', () => {
        const logs = [
            log({ day: 0, pass: true, level: 3 }),    // level 3 ⇒ a 4-day interval
            log({ day: 8, pass: false, level: 1 }),
        ];
        const r = records(logs)[1];
        assert.equal(r.intervalIn, 4);
        assert.equal(r.elapsedDays, 8);
        assert.equal(r.overdueRatio, 2);
    });

    it('leaves overdueRatio null when there is no schedule to be late against', () => {
        const first = records([log({ day: 0, pass: false })])[0];
        assert.equal(first.intervalIn, 0);
        assert.equal(first.overdueRatio, null, 'a first review cannot be overdue');
    });

    it('excludes reviews at or before the epoch', () => {
        const logs = [log({ day: 0, pass: false }), log({ day: 5, pass: false }), log({ day: 9, pass: false })];
        const kept = records(logs, { epochAt: at(5) });
        assert.equal(kept.length, 1);
        assert.equal(kept[0].at, at(9));
    });
});

describe('segmentSessions', () => {
    it('splits on a gap longer than 30 minutes', () => {
        const rows = [
            { id: 1, timestamp: at(0, 0) },
            { id: 2, timestamp: at(0, 10) },
            { id: 3, timestamp: at(0, 55) },   // 45 min later — new session
            { id: 4, timestamp: at(0, 60) },
        ];
        const idx = segmentSessions(rows);
        assert.equal(idx.get(1).key, idx.get(2).key);
        assert.equal(idx.get(3).key, idx.get(4).key);
        assert.notEqual(idx.get(1).key, idx.get(3).key);
        assert.equal(idx.get(1).len, 2);
    });

    it('gives a lone review position 0 rather than dividing by zero', () => {
        const idx = segmentSessions([{ id: 1, timestamp: at(0) }]);
        assert.equal(idx.get(1).pos, 0);
        assert.ok(Number.isFinite(idx.get(1).pos));
    });
});

describe('lapseCycles', () => {
    it('opens a cycle at each failure and records the interval it climbs back to', () => {
        const cycles = lapseCycles(records(ladder([3, 9])));
        assert.equal(cycles.length, 2);
        assert.ok(cycles[1].peak > cycles[0].peak, 'second cycle should climb higher');
    });

    it('ignores passes before the first failure — they open no cycle', () => {
        const logs = [log({ day: 0, pass: true, level: 2 }), log({ day: 3, pass: true, level: 3 })];
        assert.equal(lapseCycles(records(logs)).length, 0);
    });
});

describe('classifyTrajectory', () => {
    it('reads a climbing ladder as converging', () => {
        const t = classifyTrajectory(records(ladder([2, 6, 18, 40])));
        assert.equal(t.shape, 'converging');
        assert.ok(t.peakSlope > 0);
    });

    it('reads a flat floor as oscillating', () => {
        const t = classifyTrajectory(records(ladder([3, 3, 2, 3])));
        assert.equal(t.shape, 'oscillating');
    });

    it('calls a card stuck in the learning band oscillating even if the slope creeps up', () => {
        const t = classifyTrajectory(records(ladder([1, 1, 2, 3])));
        assert.equal(t.shape, 'oscillating', 'never reached 7 days after four cycles');
    });

    it('is unclear with fewer than two cycles — no trend is not a downward trend', () => {
        assert.equal(classifyTrajectory(records(ladder([3]))).shape, 'unclear');
    });

    it('reports no difficulty signal under Leitner', () => {
        assert.equal(classifyTrajectory(records(ladder([2, 6, 18], { fsrs: false }))).difficultySlope, null);
        assert.notEqual(classifyTrajectory(records(ladder([2, 6, 18]))).difficultySlope, null);
    });
});

describe('detectors — the core discrimination', () => {
    it('classifies a converging card as a probe, not a mouthful', () => {
        const flags = cardHealth.runDetectors(
            ctxFrom(ladder([2, 6, 18, 45], { difficultyStep: -0.3 }), { prior: 'neutral' })
        );
        assert.deepEqual(kinds(flags), ['probe']);
        assert.equal(flags[0].evidence.trajectory, 'converging');
    });

    it('classifies an oscillating card with a long answer as a mouthful', () => {
        const flags = cardHealth.runDetectors(
            ctxFrom(ladder([3, 3, 2, 3], { difficultyStep: 0.5 }), { prior: 'overloaded', tokens: 60 })
        );
        assert.deepEqual(kinds(flags), ['mouthful']);
        assert.equal(flags[0].confidence, 'high');
    });

    it('THE CASE THIS EXISTS FOR: the same oscillating history with a compact answer is a probe', () => {
        // Identical failure history, identical pass rate. Only the card's structure
        // differs — and the advice inverts.
        const history = ladder([3, 3, 2, 3], { difficultyStep: 0.5 });
        const asMouthful = cardHealth.runDetectors(ctxFrom(history, { prior: 'overloaded', tokens: 60 }));
        const asProbe = cardHealth.runDetectors(ctxFrom(history, { prior: 'compact', tokens: 3 }));

        assert.deepEqual(kinds(asMouthful), ['mouthful']);
        assert.deepEqual(kinds(asProbe), ['probe'], 'nothing to split ⇒ not a mouthful');
        assert.match(asProbe[0].evidence.basis, /nothing to split/);
    });

    it('never emits both signatures for one card', () => {
        for (const prior of ['overloaded', 'neutral', 'compact']) {
            for (const peaks of [[1, 1, 2, 1], [2, 6, 18, 45], [3]]) {
                const flags = cardHealth.runDetectors(ctxFrom(ladder(peaks), { prior }));
                const sigs = flags.filter(f => f.kind === 'mouthful' || f.kind === 'probe');
                assert.ok(sigs.length <= 1, `${prior}/${peaks}: got ${kinds(flags)}`);
            }
        }
    });
});

describe('confidence gates', () => {
    it('says nothing below the gates — three lapses is not a trajectory', () => {
        const flags = cardHealth.runDetectors(ctxFrom(ladder([1, 1, 1]), { prior: 'overloaded' }));
        assert.deepEqual(flags, []);
    });

    it('says nothing when four lapses land inside one bad week', () => {
        // Four cycles, but all within a few days — no maturation window.
        const logs = [0, 1, 2, 3].flatMap(d => [
            log({ day: d, pass: false, level: 1, stability: 1, difficulty: 5 }),
            log({ day: d, minute: 30, pass: true, level: 1, stability: 1, difficulty: 5 }),
        ]);
        const flags = cardHealth.runDetectors(ctxFrom(logs, { prior: 'overloaded' }));
        assert.equal(flags.filter(f => f.confidence === 'high').length, 0);
    });

    it('caps confidence one step lower without a difficulty signal (Leitner/SM-2)', () => {
        const opts = { prior: 'overloaded', tokens: 60 };
        const withFsrs = cardHealth.runDetectors(ctxFrom(ladder([3, 3, 2, 3], { difficultyStep: 0.5 }), opts));
        const withoutFsrs = cardHealth.runDetectors(ctxFrom(ladder([3, 3, 2, 3], { fsrs: false }), opts));

        assert.equal(withFsrs[0].confidence, 'high');
        assert.equal(withoutFsrs[0].confidence, 'moderate');
        assert.equal(withoutFsrs[0].evidence.memoryModel, 'approximated');
    });

    it('downgrades a neutral answer below an overloaded one on the same trajectory', () => {
        const history = ladder([3, 3, 2, 3], { difficultyStep: 0.5 });
        const overloaded = cardHealth.runDetectors(ctxFrom(history, { prior: 'overloaded', tokens: 60 }));
        const neutral = cardHealth.runDetectors(ctxFrom(history, { prior: 'neutral' }));
        assert.equal(overloaded[0].confidence, 'high');
        assert.equal(neutral[0].confidence, 'moderate');
    });
});

describe('guards suppress the signatures', () => {
    it('diagnoses overdue drift and withdraws the mouthful verdict', () => {
        // Every failure arrives at 5x its scheduled interval.
        const logs = [];
        let day = 0;
        for (let i = 0; i < 5; i++) {
            logs.push(log({ day, pass: true, level: 3 }));      // schedules 4 days
            day += 20;                                          // ...reviewed 20 days later
            logs.push(log({ day, pass: false, level: 1 }));
            day += 1;
        }
        const flags = cardHealth.runDetectors(ctxFrom(logs, { prior: 'overloaded', tokens: 60 }));
        assert.deepEqual(kinds(flags), ['overdue_drift']);
        assert.ok(flags[0].evidence.worstOverdueRatio >= 2);
    });

    it('diagnoses session fatigue and withdraws the mouthful verdict', () => {
        // 30-card sessions; this card fails at the end and passes near the start.
        const rows = [];
        const mine = [];
        let id = 1000;
        for (let s = 0; s < 6; s++) {
            for (let i = 0; i < 30; i++) {
                const row = { id: id++, timestamp: at(s * 3, i) };
                rows.push(row);
                // Position 2/29 ≈ early (pass), 28/29 ≈ late (fail).
                if (i === 2 || i === 28) {
                    mine.push({
                        ...log({ day: s * 3, minute: i, pass: i === 2, level: i === 2 ? 3 : 1 }),
                        id: row.id,
                    });
                }
            }
        }
        const sessionIndex = segmentSessions(rows);
        const flags = cardHealth.runDetectors(
            ctxFrom(mine, { prior: 'overloaded', tokens: 60, sessionIndex })
        );
        assert.ok(kinds(flags).includes('session_fatigue'));
        assert.ok(!kinds(flags).includes('mouthful'), 'the flag belongs on the routine, not the card');
    });

    it('leaves the signatures alone when neither guard fires', () => {
        const flags = cardHealth.runDetectors(ctxFrom(ladder([2, 6, 18, 45])));
        assert.ok(!flags.some(f => ['overdue_drift', 'session_fatigue'].includes(f.kind)));
    });

    it('excludes badly-overdue reviews from the trajectory even when the guard stays silent', () => {
        // A converging card with ONE review that arrived absurdly late. Too few late
        // failures to trip overdue_drift, but enough to flatten the peak series if it
        // were counted — which would turn a probe into a mouthful.
        const clean = ladder([2, 6, 18, 45], { difficultyStep: -0.3 });
        const lastDay = (Date.parse(clean.at(-1).timestamp) - T0) / DAY;
        const polluted = [
            ...clean,
            // ~200 days after a ~45-day schedule: ratio well past the exclusion threshold.
            log({ day: lastDay + 200, pass: false, level: 1, stability: 1, difficulty: 4 }),
        ];

        const withLate = records(polluted);
        const late = withLate.at(-1);
        assert.ok(late.overdueRatio > 3, `expected a badly-late review, got ${late.overdueRatio}`);
        assert.equal(onSchedule(withLate).length, withLate.length - 1, 'the late review is dropped');

        // The verdict is unchanged by the outlier.
        assert.equal(classifyTrajectory(withLate).shape, 'converging');
        assert.deepEqual(kinds(cardHealth.runDetectors(ctxFrom(polluted, { prior: 'neutral' }))), ['probe']);
    });
});

describe('within-session repeat failure', () => {
    it('detects two failures inside one session', () => {
        const rows = [
            { id: 1, timestamp: at(0, 0) },
            { id: 2, timestamp: at(0, 5) },
        ];
        const idx = segmentSessions(rows);
        const logs = [
            { ...log({ day: 0, minute: 0, pass: false }), id: 1 },
            { ...log({ day: 0, minute: 5, pass: false }), id: 2 },
        ];
        assert.equal(hasWithinSessionRepeatFailure(records(logs, { sessionIndex: idx })), true);
    });

    it('does not fire across two separate sessions', () => {
        const rows = [
            { id: 1, timestamp: at(0, 0) },
            { id: 2, timestamp: at(1, 0) },
        ];
        const idx = segmentSessions(rows);
        const logs = [
            { ...log({ day: 0, pass: false }), id: 1 },
            { ...log({ day: 1, pass: false }), id: 2 },
        ];
        assert.equal(hasWithinSessionRepeatFailure(records(logs, { sessionIndex: idx })), false);
    });

    it('raises a soft mouthful from the prior plus a repeat failure, with no trajectory yet', () => {
        const rows = [{ id: 1, timestamp: at(0, 0) }, { id: 2, timestamp: at(0, 5) }];
        const idx = segmentSessions(rows);
        const logs = [
            { ...log({ day: 0, minute: 0, pass: false }), id: 1 },
            { ...log({ day: 0, minute: 5, pass: false }), id: 2 },
        ];
        const flags = cardHealth.runDetectors(
            ctxFrom(logs, { prior: 'overloaded', tokens: 60, sessionIndex: idx })
        );
        assert.deepEqual(kinds(flags), ['mouthful']);
        assert.equal(flags[0].confidence, 'moderate');
        assert.match(flags[0].evidence.basis, /structural prior/);
    });

    it('stays silent on the same history when the answer is compact', () => {
        const rows = [{ id: 1, timestamp: at(0, 0) }, { id: 2, timestamp: at(0, 5) }];
        const idx = segmentSessions(rows);
        const logs = [
            { ...log({ day: 0, minute: 0, pass: false }), id: 1 },
            { ...log({ day: 0, minute: 5, pass: false }), id: 2 },
        ];
        assert.deepEqual(cardHealth.runDetectors(ctxFrom(logs, { prior: 'compact', sessionIndex: idx })), []);
    });
});

describe('epoch — addressing a card restarts the analysis', () => {
    it('drops a card below the gates once the window moves past its history', () => {
        const logs = ladder([3, 3, 2, 3], { difficultyStep: 0.5 });
        const before = cardHealth.runDetectors(ctxFrom(logs, { prior: 'overloaded', tokens: 60 }));
        assert.deepEqual(kinds(before), ['mouthful']);

        // The user edits the card: everything before now stops being evidence.
        const lastDay = (Date.parse(logs.at(-1).timestamp) - T0) / DAY;
        const after = buildReviewRecords(logs, { epochAt: at(lastDay + 0.001) });
        assert.equal(after.length, 0);
        assert.deepEqual(cardHealth.runDetectors({
            ...ctxFrom(logs, { prior: 'overloaded', tokens: 60 }),
            reviews: after,
            trajectory: classifyTrajectory(after),
            repeatFailure: false,
        }), []);
    });
});

describe('flag presentation', () => {
    it('every flag kind ships a title, an explanation and a named action', () => {
        // A detector that lands in DETECTORS without copy would surface to the user as a
        // bare kind string, so this is a real coupling worth pinning.
        for (const kind of FLAG_KINDS) {
            const p = PRESENTATION[kind];
            assert.ok(p, `${kind} has no presentation entry`);
            for (const field of ['title', 'detail', 'action', 'actionKind']) {
                assert.equal(typeof p[field], 'string', `${kind}.${field}`);
                assert.ok(p[field].length > 0, `${kind}.${field} is empty`);
            }
        }
    });

    it('recommends, never applies — no action is destructive or automatic', () => {
        // The feature's one hard rule: never auto-split, never auto-bury.
        const verbs = Object.values(PRESENTATION).map(p => p.action.toLowerCase());
        assert.ok(verbs.every(v => !/^(splitting|automatically|buried)/.test(v)));
        assert.match(PRESENTATION.mouthful.action, /^Split it/);
        assert.match(PRESENTATION.probe.action, /^Keep it/);
    });

    it('emits every kind it advertises across the fixtures above', () => {
        const seen = new Set();
        const overdue = [];
        let day = 0;
        for (let i = 0; i < 5; i++) {
            overdue.push(log({ day, pass: true, level: 3 }));
            day += 20;
            overdue.push(log({ day, pass: false, level: 1 }));
            day += 1;
        }
        for (const ctx of [
            ctxFrom(ladder([2, 6, 18, 45], { difficultyStep: -0.3 }), { prior: 'neutral' }),
            ctxFrom(ladder([3, 3, 2, 3], { difficultyStep: 0.5 }), { prior: 'overloaded', tokens: 60 }),
            ctxFrom(overdue, { prior: 'overloaded', tokens: 60 }),
        ]) {
            for (const f of cardHealth.runDetectors(ctx)) seen.add(f.kind);
        }
        assert.deepEqual([...seen].sort(), ['mouthful', 'overdue_drift', 'probe']);
    });
});
