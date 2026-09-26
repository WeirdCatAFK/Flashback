/**
 * The gap between reviews, in days, for the two schedulers whose maths is simple
 * enough to share: Leitner (doubles with each level) and SM-2 (1, 6, then × ease).
 *
 * Shared because two places must give the same number: the server computes the gap
 * a grade produced (the Trainer's pop, `POST /api/srs/review`) and the renderer
 * previews the gap each grade would produce (under the grade buttons). If the two
 * formulas drifted, the button would promise one gap and the pop report another.
 * FSRS is not here — its schedule depends on fitted weights and latent state only
 * the server holds, so its preview comes from `/api/srs/due`.
 *
 * No imports, so both the API (Node) and the renderer (Vite) load it as is.
 */

/** Days until the next SM-2 review after `reps` successful reviews at ease `ef`. */
export function sm2Interval(reps, ef) {
  if (reps <= 1) return 1;
  if (reps === 2) return 6;
  return Math.min(365, Math.round(6 * Math.pow(ef, reps - 2)));
}

/**
 * The gap between reviews, bucketed the way the Flashcards and Statistics screens
 * show it — a scheduler-agnostic stand-in for Leitner's levels. `max` is inclusive,
 * in days; `new` is a card this person has never reviewed. 21 days is the app's
 * long-term line (Statistics' old "mature").
 */
export const GAP_BANDS = [
  { id: 'new', max: null },
  { id: 'd1', max: 1 },
  { id: 'wk', max: 7 },
  { id: 'w3', max: 21 },
  { id: 'm2', max: 60 },
  { id: 'long', max: Infinity },
];

/** Days at or past which a card counts as held long-term. */
export const LONG_TERM_DAYS = 21;

/** The band a gap falls in; null means never reviewed. */
export function gapBand(days) {
  if (days == null) return 'new';
  return GAP_BANDS.find((b) => b.max != null && days <= b.max).id;
}

/** Days until the next Leitner review at `level` (0 is a card never reviewed). */
export function leitnerInterval(level) {
  if (level <= 0) return 0;
  return Math.min(365, Math.pow(2, level - 1));
}
