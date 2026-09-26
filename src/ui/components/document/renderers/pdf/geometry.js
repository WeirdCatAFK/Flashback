/**
 * PDF viewer geometry: zoom steps, and the conversion between viewport space
 * (what getBoundingClientRect and mouse events report) and PDF units (how a
 * bbox is stored so it survives a zoom change). `scale` is layout px per PDF
 * unit and the app zoom multiplies layout px into viewport px on top of that,
 * so both factors come out on the way in; rendering `bbox * scale` inside the
 * layout-sized page needs no correction.
 */

export const SCALE_MIN = 0.5;
export const SCALE_MAX = 3.0;
export const SCALE_STEP = 0.25;
export const SCALE_DEFAULT = 1.2;
const FIT_MARGIN = 48;
const MIN_BOX = 5;

const round2 = (n) => parseFloat(n.toFixed(2));

export const clampScale = (s) => round2(Math.min(SCALE_MAX, Math.max(SCALE_MIN, s)));
export const zoomedOut = (s) => Math.max(SCALE_MIN, round2(s - SCALE_STEP));
export const zoomedIn = (s) => Math.min(SCALE_MAX, round2(s + SCALE_STEP));

/** The scale at which a page of `nativeWidth` fills `containerWidth`. */
export const fitScale = (containerWidth, nativeWidth) => clampScale((containerWidth - FIT_MARGIN) / nativeWidth);

/** The divisor from viewport px to PDF units. */
export const viewportToPdf = (scale, uiZoom) => scale * uiZoom;

/** A viewport-space rect inside `pageRect`, as a PDF-unit bbox. */
export function bboxFromViewport(rect, pageRect, divisor) {
  return {
    x: (rect.left - pageRect.left) / divisor,
    y: (rect.top - pageRect.top) / divisor,
    width: rect.width / divisor,
    height: rect.height / divisor,
  };
}

/** The rect a drag from `start` to `end` describes, or null if it is too small to mean anything. */
export function dragRect(start, end) {
  const width = Math.abs(end.x - start.x);
  const height = Math.abs(end.y - start.y);
  if (width < MIN_BOX || height < MIN_BOX) return null;
  return { left: Math.min(start.x, end.x), top: Math.min(start.y, end.y), width, height };
}

/** The centre of a viewport rect in PDF units relative to `pageRect`. */
export function centerInPdf(rect, pageRect, divisor) {
  return {
    x: ((rect.left + rect.right) / 2 - pageRect.left) / divisor,
    y: ((rect.top + rect.bottom) / 2 - pageRect.top) / divisor,
  };
}

/** The id of the highlight on `page` whose bbox contains the point, or null. */
export function highlightAt(highlights, page, { x, y }) {
  return highlights.find((h) =>
    h.page === page && h.bbox &&
    x >= h.bbox.x && x <= h.bbox.x + h.bbox.width &&
    y >= h.bbox.y && y <= h.bbox.y + h.bbox.height
  )?.id ?? null;
}

/** The first page whose bottom edge is below `top`, given `[{ page, bottom }]` in order. */
export function pageAtTop(pageBottoms, top) {
  for (const { page, bottom } of pageBottoms) {
    if (bottom > top) return page;
  }
  return 1;
}
