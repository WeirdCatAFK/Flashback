/**
 * The file tree's geometry, as plain numbers: the widths a resize snaps to, where
 * a width steps to from the keyboard, and how wide the zone left of the text is
 * that slides a hidden tree out. No React, no DOM.
 */

export const MIN_WIDTH = 180;
export const MAX_WIDTH = 440;
export const DEFAULT_WIDTH = 236;

/** The widths a drag lands on when it comes within `SNAP_REACH` px of one. */
export const SNAPS = [200, 260, 340];
const SNAP_REACH = 16;

/** Where a dragged width settles: clamped, and caught by a nearby snap. */
export function snapWidth(w) {
  const clamped = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w));
  const near = SNAPS.find((s) => Math.abs(s - clamped) <= SNAP_REACH);
  return Math.round(near ?? clamped);
}

/** The next width the keyboard steps to: the next snap that way, or the end. */
export function stepWidth(w, dir) {
  if (dir < 0) return [...SNAPS].reverse().find((s) => s < w - 1) ?? MIN_WIDTH;
  return SNAPS.find((s) => s > w + 1) ?? MAX_WIDTH;
}

/** A stored width, or the default when it is missing or out of range. */
export function storedWidth(raw) {
  const w = parseInt(raw, 10);
  return w >= MIN_WIDTH && w <= MAX_WIDTH ? w : DEFAULT_WIDTH;
}

/** The inert strip, in px, kept clear beside the text so a selection started at a line's edge never opens the tree. */
export const PEEK_CLEAR = 28;
/** The narrowest the peek zone gets, so a document whose text starts at the edge still has one. */
export const PEEK_MIN = 44;

/**
 * How wide the zone is, from the left of the document area, where hovering slides
 * a hidden tree out: the empty space left of the text, less the clear strip.
 * `textLeft` is null when there is no text to measure against.
 */
export function peekZoneWidth(bodyLeft, textLeft) {
  if (textLeft == null) return PEEK_MIN;
  return Math.max(PEEK_MIN, textLeft - bodyLeft - PEEK_CLEAR);
}
