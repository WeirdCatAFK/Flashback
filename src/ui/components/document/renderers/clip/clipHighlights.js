/**
 * The DOM half of clip highlighting: walking the container's text nodes,
 * reading the live selection as offsets, wrapping and unwrapping <mark>s. The
 * arithmetic is in ranges.js.
 */

import { boundaryOffset, normalizeSpan, spanOps, reanchor } from './ranges.js';

/** Every text node under `root` with its char range in document order. */
export function textSegments(root) {
  const segs = [];
  let offset = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  let n;
  while ((n = walker.nextNode())) {
    const len = n.nodeValue.length;
    segs.push({ node: n, start: offset, end: offset + len });
    offset += len;
  }
  return segs;
}

/** The current selection inside `root` as char offsets plus its text, or null. */
export function selectionOffsets(root) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;
  const segs = textSegments(root);
  const span = normalizeSpan(
    boundaryOffset(segs, range.startContainer, range.startOffset),
    boundaryOffset(segs, range.endContainer, range.endOffset)
  );
  return span ? { ...span, text: sel.toString() } : null;
}

/** Wrap [start, end) in <mark>s carrying the highlight id, one per text node. */
export function wrapOffsets(root, start, end, id, color) {
  for (const op of spanOps(textSegments(root), start, end)) {
    const range = document.createRange();
    range.setStart(op.node, op.from);
    range.setEnd(op.node, op.to);
    const mark = document.createElement('mark');
    mark.setAttribute('data-hl', id);
    mark.setAttribute('data-color', color || 'amber');
    try { range.surroundContents(mark); } catch { }
  }
}

/** Re-apply one stored highlight to a freshly rendered container; false if its text is gone. */
export function applyHighlight(root, h) {
  const span = reanchor(root.textContent || '', h);
  if (!span) return false;
  wrapOffsets(root, span.start, span.end, h.id, h.color);
  return true;
}

/** Remove every <mark> of highlight `id`, merging the text back together. */
export function unwrap(root, id) {
  root.querySelectorAll(`mark[data-hl="${id}"]`).forEach((m) => {
    const parent = m.parentNode;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
    parent.normalize();
  });
}

/** The id of the highlight the selection starts inside, or null. */
export function highlightIdAtSelection(root) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  let node = sel.getRangeAt(0).startContainer;
  if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
  if (!node || !root.contains(node)) return null;
  return node.closest?.('mark[data-hl]')?.getAttribute('data-hl') ?? null;
}

/** Recolour every <mark> of highlight `id`. */
export function recolor(root, id, color) {
  root.querySelectorAll(`mark[data-hl="${id}"]`).forEach((m) => m.setAttribute('data-color', color));
}
