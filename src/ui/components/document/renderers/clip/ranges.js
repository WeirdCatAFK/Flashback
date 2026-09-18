/**
 * Character-offset arithmetic over a clip's text. A clip highlight anchors by
 * offset into the container's `textContent`, mirroring the .txt strategy over
 * raw HTML. Everything here takes plain `{ node, start, end }` segments so it
 * is testable without a DOM; the DOM walk that produces them is in
 * clipHighlights.js.
 */

/** Char offset of a (textNode, offsetInNode) boundary, or null if the node is unknown. */
export function boundaryOffset(segs, node, offsetInNode) {
  for (const s of segs) {
    if (s.node === node) return s.start + offsetInNode;
  }
  return null;
}

/** A start/end pair normalised to ascending order, or null when it is empty. */
export function normalizeSpan(start, end) {
  if (start == null || end == null) return null;
  if (start > end) [start, end] = [end, start];
  return end > start ? { start, end } : null;
}

/**
 * The per-text-node slices covering [start, end), so a span crossing element
 * boundaries can be wrapped one physical mark per node.
 * @returns {{ node, from, to }[]}
 */
export function spanOps(segs, start, end) {
  const ops = [];
  for (const s of segs) {
    const from = Math.max(start, s.start) - s.start;
    const to = Math.min(end, s.end) - s.start;
    if (from < to) ops.push({ node: s.node, from, to });
  }
  return ops;
}

/**
 * Where a stored highlight lives in `fullText` today: its own offsets if the
 * quote still sits there, else the first occurrence of the quote, else null.
 */
export function reanchor(fullText, { start, end, text }) {
  const quote = text || '';
  if (typeof start === 'number' && typeof end === 'number' && fullText.slice(start, end) === quote) {
    return end > start ? { start, end } : null;
  }
  if (!quote) return null;
  const idx = fullText.indexOf(quote);
  if (idx === -1) return null;
  return { start: idx, end: idx + quote.length };
}
