/**
 * Finds the element that actually scrolls, starting from anything inside it.
 *
 * Every renderer puts the scrollbar somewhere different — TipTap's wrapper, CodeMirror's
 * own scroller, a plain div, or (for PDF and clips) the editor's `.doc-editor-renderer`
 * ancestor rather than anything the renderer owns at all. None of them exposes it, and
 * `scroll` does not bubble from an ancestor to a descendant, so guessing wrong means the
 * listener simply never fires.
 *
 * The `scrollHeight > clientHeight` guard matters as much as the overflow rule: a
 * container that *could* scroll but has nothing to scroll yet is not the answer, and
 * returning it would pin the reader to a position that never moves.
 *
 * @param {Element|null|undefined} from - anything inside the scrolling region.
 * @returns {Element|null} the scroller, or null if nothing above `from` scrolls yet.
 */
export function findScroller(from) {
  let el = from;
  while (el && el !== document.body) {
    const style = window.getComputedStyle(el);
    const scrolls = /(auto|scroll)/.test(style.overflowY);
    if (scrolls && el.scrollHeight > el.clientHeight + 1) return el;
    el = el.parentElement;
  }
  return null;
}
