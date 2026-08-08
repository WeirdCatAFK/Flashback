# Graph-Aware Interleaved Sequencing

**Date:** 2026-08-07
**Status:** Implemented (classifier follow-on deferred)

A design strategy for ordering questions in sessions and tests. The scheduler decides *when*
a card is due; this layer decides *in what order* due cards are presented. The two concerns
stay separate.

## Verdict

Default to interleaving, guided by the knowledge graph. Blocking (grouping by tag or
hierarchy cluster) is retained only as a temporary scaffold for weak or newly introduced
nodes. **The graph is not used to group items — it is used to control the distance and lag
between them.**

This is consistent with the strongest findings in the learning-science literature:
interleaved practice reliably outperforms blocked practice on delayed tests of retention,
discrimination, and transfer (Rohrer & Taylor on math problem types; category-induction
studies; the broader "desirable difficulties" framework from Bjork). Blocking produces better
performance *during* practice, which creates a fluency illusion, but the knowledge it builds
tends to be context-bound: it depends on the thematic cue that a real, shuffled test will not
provide. Since Flashback's purpose is durable, cue-independent retrieval, the training
distribution should match that target.

It is also a return to Flashback's original conception: a graph scheduler that schedules by
proximity. Proximity is simply used as a spacing signal rather than a grouping signal.

## Principles

**Selection belongs to the spaced-repetition model.** Which cards appear today is decided
entirely by the retention model and due dates. Topology never pulls a card forward or pushes
it back across days. Mixing scheduling and sequencing would corrupt the retention estimates,
which are already hard to read through new-card noise.

**Sequencing belongs to the graph.** Within the due set, order is chosen so that consecutive
items sit at medium-to-high semantic distance, while confusable items (same tag, sibling
nodes, parent–child pairs) still co-occur in the same session — separated by a minimum lag of
unrelated items. The learner must fully release one concept from working memory before
retrieving its neighbour again. This produces contextual interference where it is productive
and avoids it where it is just noise.

**Difficulty is staged per node, not per calendar.** There is no phase schedule keyed to an
exam date; the vault is a continuous system. Each node's strength estimate sets how
aggressively it is interleaved. A new or lapsing node may appear in a short same-cluster run
(two or three items) so the learner can extract the pattern; a mature node gets full mixing.
The blocked-to-interleaved progression happens locally and automatically, driven by the same
signals that drive spacing.

**Lag and distance are tunable heuristics, not laws.** A minimum lag of roughly 3–5
intervening items is a reasonable starting point, but no study establishes it as optimal.
Treat both the lag and the distance weighting as parameters to tune against logged outcomes,
not as fixed constants.

## Algorithm

Session construction runs in two passes.

**Pass 1 — selection:** query the spaced-repetition scheduler for the due set, exactly as
today. No changes.

**Pass 2 — sequencing:** order the due set under two soft constraints and one hard constraint.

```
given: due_set, graph distance d(a, b), strength s(n), params (min_lag, w_dist)

hard:  any two items with d <= CONFUSABLE_THRESHOLD
       (shared tag, sibling, or direct hierarchical edge)
       must be separated by at least min_lag items

soft:  maximize sum of d(item_i, item_{i+1}) weighted by w_dist,
       i.e. prefer medium-to-high distance between neighbors

soft:  for nodes with s(n) below a weakness threshold, relax both
       constraints locally — allow a short run (2–3 items) from the
       same cluster before switching
```

A greedy insert with a small lookahead is sufficient; this does not need to be an exact
optimization. **Pure random shuffle is the fallback and is already better than blocking, so
any failure mode of the sequencer should degrade to shuffle, never to clusters.**

For hierarchical material, occasionally vary the level at which items interleave — siblings,
cousins, parent–child — so the relational structure itself gets retrieval practice, not only
the leaves.

### Implementation notes

Two findings from building it that the sketch above does not anticipate:

**Feasibility must be computed, not assumed.** Spacing *k* cluster-mates *g* apart inside *n*
slots requires `(k-1)(g+1)+1 ≤ n`. When the due set contains a cluster too large for the
session, a greedy told to honour `min_lag` anyway spends its unrelated buffer early and piles
the remainder into a block at the *end* of the session — reintroducing precisely the blocking
this design exists to prevent. The achievable lag is therefore derived per tier and the
constraint lowered to fit, which is what makes "degrade to shuffle, never to clusters" true
rather than aspirational.

**Greedy needs scheduling pressure.** Picking the furthest legal card at each step has the
same stranding failure. Emitting preferentially from the cluster with the most members still
outstanding spends the buffer evenly.

## Discrimination as a card-health signal

Co-scheduling confusable siblings enables a third signature for the card-health classifier,
alongside "mouthful" and "challenging/interesting": **discrimination failure**. Despite the
`ReviewLog` storing only grades, the pattern is detectable from grades plus session-ordering
metadata — a card that passes in isolation but lapses whenever its sibling appeared within the
lag window is failing at discrimination, not recall. The proposed action for that signature is
to *sharpen the cue* (per the manifesto's activator-neuron framing: ambiguous cues get split,
not branched).

**Deferred.** This cannot calibrate until sessions have logged ordering metadata, so it ships
after real data exists rather than on guessed thresholds.

## Telemetry

Log session-ordering metadata from day one: for each review, record the graph distance to the
preceding item and the position of the nearest confusable sibling in the session. Without
this, a retention dip after shipping cannot be distinguished from a regression.

**Expect that dip.** Interleaving trades immediate accuracy for delayed retention, so measured
pass rates will fall when it turns on — the same way retention already drops when new decks
are added. Judge the feature by delayed outcomes and discrimination performance across related
nodes, not by within-session accuracy. Surface the rationale to the user as well ("this will
feel harder now but stick better"), because the subjective experience of interleaving is that
it is going worse than it is.

## What not to do

- Do not let topology override due dates — no pulling tomorrow's tag-siblings into today or
  deferring easy cards to engineer comparisons across days.
- Do not build a phase calendar around a test date; staging is per-node.
- Do not run "theme of the day" sessions once basic familiarity exists.
- Do not push interleaving density so hard that sessions feel demoralizing; start moderate and
  tune from the logs.

## Where this landed

| Concern | Location |
| --- | --- |
| Pure ordering engine | `src/api/access/orchestration/sequencing.js` |
| DB-facing wrapper + telemetry | `src/api/access/orchestration/sequencer.js` |
| Composition (selection × sequencing) | `src/api/routes/srs.js` `GET /due` |
| Telemetry columns | `src/api/config/migrations/009_session_ordering.js` |
| Tests | `tests/sequencing.test.js` |
| Data model | `DATAMODEL.md` § Session Sequencing |
