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

/** Days until the next Leitner review at `level` (0 is a card never reviewed). */
export function leitnerInterval(level) {
  if (level <= 0) return 0;
  return Math.min(365, Math.pow(2, level - 1));
}
