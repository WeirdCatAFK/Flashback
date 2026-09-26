/**
 * How busy a day was, on the four levels the Statistics heatmap and the Diary's
 * calendar share: 0 for none, then quarters of the busiest day shown. One scale, so
 * a dark amber day means the same on both screens.
 */

/** A day's level, 0 (none) to 4, from its reviews and the most reviews on any day shown. */
export function heatLevel(n, max) {
  if (!n || n <= 0 || !max) return 0;
  const r = n / max;
  return r <= 0.25 ? 1 : r <= 0.5 ? 2 : r <= 0.75 ? 3 : 4;
}
