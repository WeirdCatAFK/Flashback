export const SCALE_MIN = 0.5;
export const SCALE_MAX = 3.0;
export const SCALE_STEP = 0.25;
export const SCALE_DEFAULT = 1.2;
const FIT_MARGIN = 48;
const MIN_BOX = 5;
const WHEEL_RATE = 0.002;

const round2 = (n) => parseFloat(n.toFixed(2));

export const clampScale = (s) => round2(Math.min(SCALE_MAX, Math.max(SCALE_MIN, s)));
export const zoomedOut = (s) => Math.max(SCALE_MIN, round2(s - SCALE_STEP));
export const zoomedIn = (s) => Math.min(SCALE_MAX, round2(s + SCALE_STEP));

/** Chromium reports a trackpad pinch as Ctrl+wheel. The scale stays unrounded so that small pinch steps add up. */
export const wheelScale = (s, deltaY) => Math.min(SCALE_MAX, Math.max(SCALE_MIN, s * Math.exp(-deltaY * WHEEL_RATE)));

export function scaleFromPercent(text) {
  const n = parseFloat(String(text).replace('%', ''));
  return Number.isFinite(n) && n > 0 ? clampScale(n / 100) : null;
}

export const fitScale = (containerWidth, nativeWidth) => clampScale((containerWidth - FIT_MARGIN) / nativeWidth);

export const viewportToPdf = (scale, uiZoom) => scale * uiZoom;

export function bboxFromViewport(rect, pageRect, divisor) {
  return {
    x: (rect.left - pageRect.left) / divisor,
    y: (rect.top - pageRect.top) / divisor,
    width: rect.width / divisor,
    height: rect.height / divisor,
  };
}

export function dragRect(start, end) {
  const width = Math.abs(end.x - start.x);
  const height = Math.abs(end.y - start.y);
  if (width < MIN_BOX || height < MIN_BOX) return null;
  return { left: Math.min(start.x, end.x), top: Math.min(start.y, end.y), width, height };
}

export function centerInPdf(rect, pageRect, divisor) {
  return {
    x: ((rect.left + rect.right) / 2 - pageRect.left) / divisor,
    y: ((rect.top + rect.bottom) / 2 - pageRect.top) / divisor,
  };
}

export function highlightAt(highlights, page, { x, y }) {
  return highlights.find((h) =>
    h.page === page && h.bbox &&
    x >= h.bbox.x && x <= h.bbox.x + h.bbox.width &&
    y >= h.bbox.y && y <= h.bbox.y + h.bbox.height
  )?.id ?? null;
}

export function pageAtTop(pageBottoms, top) {
  for (const { page, bottom } of pageBottoms) {
    if (bottom > top) return page;
  }
  return 1;
}
