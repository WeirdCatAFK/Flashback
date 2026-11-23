export function sm2Interval(reps, ef) {
  if (reps <= 1) return 1;
  if (reps === 2) return 6;
  return Math.min(365, Math.round(6 * Math.pow(ef, reps - 2)));
}

export const GAP_BANDS = [
  { id: 'new', max: null },
  { id: 'd1', max: 1 },
  { id: 'wk', max: 7 },
  { id: 'w3', max: 21 },
  { id: 'm2', max: 60 },
  { id: 'long', max: Infinity },
];

export const LONG_TERM_DAYS = 21;

export function gapBand(days) {
  if (days == null) return 'new';
  return GAP_BANDS.find((b) => b.max != null && days <= b.max).id;
}

export function leitnerInterval(level) {
  if (level <= 0) return 0;
  return Math.min(365, Math.pow(2, level - 1));
}
