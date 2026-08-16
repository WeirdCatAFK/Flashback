/**
 * graphMetrics.js — the graph's sizing math, kept pure.
 *
 * No React, no CSS, no imports: `tests/graph.test.js` loads this directly to pin
 * the halo curve and the aggregation rules without a canvas or a DOM. Same split,
 * and the same reason, as `sequencing.js` from `sequencer.js` in the access layer.
 *
 * The graph draws knowledge on two independent channels:
 *
 *   halo radius  ← `mass`     how much knowledge a node stands for
 *   halo opacity ← `learned`  how well that knowledge is held (a rate)
 *
 * Before this split, radius and opacity were both driven by `learned`. Since that
 * is a mean, it is scale-free: a document with two mastered cards scored 1.0 and
 * out-glowed a document with eighty cards at level 3, which scored 0.5. The graph
 * was reporting mastery rate and calling it knowledge.
 */

// Matches NODE_R + 4 in GraphView — the halo an unstudied node would have if it
// were drawn at all. Nothing shrinks below it.
export const HALO_BASE = 11;
// Pixels of radius per √(mastered card). Tuned so one mastered card is a visible
// bump and a few hundred fill a neighbourhood without leaving the screen.
export const HALO_K = 4;
// Past this the exact size has stopped carrying information. Bites above mass ~390.
export const HALO_MAX = 90;

/**
 * Halo radius for a node holding `mass` mastered-card-equivalents.
 *
 * √ rather than linear because the halo is a disc and area = πr². Radius ∝ √mass
 * makes *lit area* proportional to knowledge held, which is the thing the viewer
 * actually judges when comparing two glowing regions.
 */
export function haloRadius(mass) {
  const m = Number(mass);
  if (!isFinite(m) || m <= 0) return HALO_BASE;
  return Math.min(HALO_MAX, HALO_BASE + HALO_K * Math.sqrt(m));
}

/**
 * Hard spacing a node claims in the force layout.
 *
 * Only a fraction of the halo, deliberately. Reserving the full radius would push
 * a large folder's neighbours 80px away and shred the layout — and halos are
 * *meant* to overlap: the additive blend in paintHalos exists so that adjacent
 * learned nodes merge into one lit region rather than stacking as separate discs.
 * So a big node claims enough room to stay legible and lets its light spill.
 */
export function collideRadius(node, nodeR = 7) {
  return nodeR + 5 + 0.35 * (haloRadius(node?.mass) - HALO_BASE);
}

const idOf = (v) => (typeof v === 'object' && v !== null ? v.id : v);

/**
 * Fills in `mass` and `cardCount` for Tag and Deck nodes, which the API leaves at
 * zero. Mutates nothing — returns a Map of id → { mass, cardCount } for the caller
 * to apply.
 *
 * Tags and Decks aggregate nodes that are *themselves* already aggregates, so the
 * only real problem here is counting the same cards twice.
 *
 * Decks are easy: `deck` edges only ever reach flashcards, which are leaves, so
 * summing every Flashcard endpoint is exact.
 *
 * Tags are not. A tag on a folder is inherited by every document beneath it, so a
 * tag's endpoint set can contain a folder, its documents, and (via deck membership)
 * some of their cards — the same knowledge three times over. The partition:
 *
 *   1. count every Document endpoint;
 *   2. count a Flashcard endpoint only if it is standalone, or its parent document
 *      is not itself tagged (a card tagged individually inside an untagged document);
 *   3. skip Folder endpoints entirely — their documents are already counted in (1).
 *
 * Step 3 rests on folder tags reaching descendant documents, which
 * `tests/graph.test.js` pins rather than assumes.
 *
 * Edge direction is not trusted: both the direct-tag and inherited-tag arms of
 * getGraphData emit entity → tag today, but matching on "whichever endpoint is the
 * Tag/Deck" costs nothing and survives that changing.
 *
 * Accepts either shape of edge — the API's `{fromId, toId}` or the graph's
 * `{source, target}` — so callers can pass whichever list they already hold.
 */
export function aggregateMass(nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map();

  // Group each aggregator's member nodes first, so the tag guard can see a tag's
  // whole endpoint set before deciding which flashcards are redundant.
  const membersOf = new Map(); // aggregator id → member nodes
  for (const e of edges) {
    if (e.relation !== 'tag' && e.relation !== 'deck') continue;
    const a = byId.get(idOf(e.fromId ?? e.source));
    const b = byId.get(idOf(e.toId ?? e.target));
    if (!a || !b) continue;

    const wanted = e.relation === 'tag' ? 'Tag' : 'Deck';
    let host, member;
    if (a.type === wanted) { host = a; member = b; }
    else if (b.type === wanted) { host = b; member = a; }
    else continue;
    if (member.type === wanted) continue; // tag-of-a-tag: nothing to sum

    if (!membersOf.has(host.id)) membersOf.set(host.id, []);
    membersOf.get(host.id).push(member);
  }

  for (const [hostId, members] of membersOf) {
    const taggedDocs = new Set(
      members.filter((m) => m.type === 'Document' && m.documentPath).map((m) => m.documentPath),
    );

    let mass = 0;
    let cardCount = 0;
    const seen = new Set();
    for (const m of members) {
      if (seen.has(m.id)) continue;
      if (m.type === 'Document') {
        seen.add(m.id);
      } else if (m.type === 'Flashcard') {
        // Redundant only when the card's own document is in this same set.
        if (m.flashcardDocPath && taggedDocs.has(m.flashcardDocPath)) continue;
        seen.add(m.id);
      } else {
        continue; // Folder, and anything else that aggregates documents
      }
      mass += Number(m.mass) || 0;
      cardCount += Number(m.cardCount) || 0;
    }

    out.set(hostId, { mass, cardCount });
  }

  return out;
}
