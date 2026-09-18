/**
 * Coordinates across the iframe boundary. A rect measured inside a section
 * iframe is already in layout pixels (the iframe's document lays out unzoomed);
 * only the iframe element's own offset comes back in viewport pixels, so that is
 * the one part the zoom is taken out of. The ratio is measured rather than read
 * from --ui-zoom so it also absorbs Chromium's per-origin zoom.
 */

const ACTION_HEIGHT = 44;
const ACTION_ABOVE = 34;
const ACTION_GAP = 6;

/** `rect` (measured in `contents`' document) in shell-layout space, or null. */
export function toShellRect(contents, rect) {
  const iframe = contents.document?.defaultView?.frameElement;
  const io = iframe?.getBoundingClientRect();
  if (!rect || !io) return null;
  const z = iframe.offsetWidth ? io.width / iframe.offsetWidth : 1;
  return { top: io.top / z + rect.top, left: io.left / z + rect.left, width: rect.width, height: rect.height };
}

/** Where the "make a card" button goes for a figure: below it, or above when it would run off the bottom. */
export function imageActionPosition(rect, viewportHeight) {
  return rect.top + rect.height + ACTION_HEIGHT > viewportHeight
    ? { top: rect.top - ACTION_ABOVE, left: rect.left }
    : { top: rect.top + rect.height + ACTION_GAP, left: rect.left };
}

/**
 * The manifest href behind a rendered image. epub.js rewrites srcs to blob:
 * URLs; `book.resources` holds the only mapping back, and drops failed
 * replacements from one array but not the other, so a length mismatch means
 * the pairing cannot be trusted and the answer is null.
 */
export function hrefFromRenderedSrc(book, src) {
  const res = book?.resources;
  if (!src || !res?.urls || !res?.replacementUrls) return null;
  if (res.urls.length !== res.replacementUrls.length) return null;
  const i = res.replacementUrls.indexOf(src);
  return i === -1 ? null : res.urls[i];
}
