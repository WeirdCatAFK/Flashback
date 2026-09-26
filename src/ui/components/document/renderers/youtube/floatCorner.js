/**
 * Where the small player sits, as plain numbers: which corner of the document area a
 * point is nearest, and the top-left of a player of a given size in a corner. The top
 * corners sit below the video's own bar so it never covers play or the moments. No
 * React, no DOM; rectangles are `{ left, top, width, height }` in layout pixels.
 */

export const CORNERS = ['tl', 'tr', 'bl', 'br'];
export const DEFAULT_CORNER = 'bl';

/** A stored corner, or the default when it is missing or not a corner. */
export const storedCorner = (raw) => (CORNERS.includes(raw) ? raw : DEFAULT_CORNER);

/** The corner of `area` nearest a point. */
export function nearestCorner(x, y, area) {
  const v = y < area.top + area.height / 2 ? 't' : 'b';
  const h = x < area.left + area.width / 2 ? 'l' : 'r';
  return `${v}${h}`;
}

/**
 * The top-left of a `width` × `height` player in `corner` of `area`, `edge` in from the
 * sides and bottom and `top` down from the top. Kept inside the area when it is small.
 */
export function cornerPosition(corner, area, width, height, { edge = 16, top = 56 } = {}) {
  const left = corner[1] === 'l' ? area.left + edge : area.left + area.width - edge - width;
  const y = corner[0] === 't' ? area.top + top : area.top + area.height - edge - height;
  return {
    left: Math.max(area.left, left),
    top: Math.max(area.top, y),
  };
}
