export const MIN_WIDTH = 180;
export const MAX_WIDTH = 440;
export const DEFAULT_WIDTH = 236;

const SNAPS = [200, 260, 340];
const SNAP_REACH = 16;

export function snapWidth(w) {
  const clamped = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w));
  const near = SNAPS.find((s) => Math.abs(s - clamped) <= SNAP_REACH);
  return Math.round(near ?? clamped);
}

export function stepWidth(w, dir) {
  if (dir < 0) return [...SNAPS].reverse().find((s) => s < w - 1) ?? MIN_WIDTH;
  return SNAPS.find((s) => s > w + 1) ?? MAX_WIDTH;
}

export function storedWidth(raw) {
  const w = parseInt(raw, 10);
  return w >= MIN_WIDTH && w <= MAX_WIDTH ? w : DEFAULT_WIDTH;
}

export const PEEK_CLEAR = 28;
export const PEEK_MIN = 44;

export function peekZoneWidth(bodyLeft, textLeft) {
  if (textLeft == null) return PEEK_MIN;
  return Math.max(PEEK_MIN, textLeft - bodyLeft - PEEK_CLEAR);
}
