export function boundaryOffset(segs, node, offsetInNode) {
  for (const s of segs) {
    if (s.node === node) return s.start + offsetInNode;
  }
  return null;
}

export function normalizeSpan(start, end) {
  if (start == null || end == null) return null;
  if (start > end) [start, end] = [end, start];
  return end > start ? { start, end } : null;
}

export function spanOps(segs, start, end) {
  const ops = [];
  for (const s of segs) {
    const from = Math.max(start, s.start) - s.start;
    const to = Math.min(end, s.end) - s.start;
    if (from < to) ops.push({ node: s.node, from, to });
  }
  return ops;
}

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
