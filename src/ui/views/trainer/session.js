/**
 * The session's pure arithmetic: how big a batch is, how the Per session and New
 * cards steppers move, what the grade pop says, and the sentence at the end. No
 * React, so `tests/ui.trainer.test.js` loads it directly; strings come in through
 * `t`/`tp` like every pure module in the renderer.
 */

/** Batch sizes the Per session stepper offers; 0 means All (every due card). */
export const BATCH_SIZES = [0, 5, 10, 20, 30, 50, 100];

/** New cards a day, stepped by five, as the Trainer's stepper moves it. */
export const NEW_STEP = 5;
export const NEW_MAX = 500;

/** The cards one batch takes from the head of the due queue. */
export function batchOf(cards, size) {
  return size ? cards.slice(0, size) : cards;
}

/**
 * The batch size after one step of the Per session stepper.
 *
 * Down from All lands on the largest size that actually splits `due` (stepping to
 * 100 when 12 are due would change nothing). Up to a size that already covers every
 * due card means All, so the + never offers a batch that is secretly the whole pile.
 */
export function stepBatch(size, dir, due) {
  const order = [...BATCH_SIZES.slice(1), 0];
  let pos = order.indexOf(size);
  if (pos === -1) pos = order.length - 1;
  let next = Math.max(0, Math.min(order.length - 1, pos + dir));
  if (size === 0 && dir < 0) {
    const fit = order.slice(0, -1).reverse().find((n) => n < due);
    next = fit ? order.indexOf(fit) : 0;
  }
  if (dir > 0 && order[next] !== 0 && order[next] >= due) next = order.length - 1;
  return order[next];
}

/** Whether the Per session stepper can move `dir` from `size`. */
export function canStepBatch(size, dir, due) {
  if (dir < 0) return size !== BATCH_SIZES[1] && !(size === 0 && due <= BATCH_SIZES[1]);
  return size !== 0;
}

/** New cards a day after one step. */
export function stepNew(n, dir) {
  return Math.max(0, Math.min(NEW_MAX, (Number(n) || 0) + dir * NEW_STEP));
}

/**
 * A gap between reviews as the pop and the grade buttons say it: "new" before a
 * card's first review, days up to a year, then years. Never "0 d": a gap that
 * rounds to nothing is still a day away.
 */
export function formatGap(days, t) {
  if (days == null) return t('new');
  if (days >= 365) {
    const years = Math.round((days / 365) * 10) / 10;
    return t('{n} yr', { n: years });
  }
  return t('{n} d', { n: Math.max(1, Math.round(days)) });
}

/**
 * When a grade would bring the card back, as the grade button says it: "tomorrow",
 * "in 8 days", "in 2 years". Null for no preview.
 */
export function formatWhen(days, t, tp) {
  if (days == null) return null;
  if (days < 1.5) return t('tomorrow');
  if (days >= 365) {
    const years = Math.round(days / 365);
    return tp('in {n} year', 'in {n} years', years);
  }
  return tp('in {n} day', 'in {n} days', Math.round(days));
}

/**
 * What the pop over the card says after a grade: the grade, and the gap before →
 * after. Nothing else — no state words, no praise; a diagnosis, not a verdict.
 * `interval` is null until the server's reply lands.
 */
export function popFor(key, label, interval, t) {
  return {
    key,
    word: label,
    missed: key === 'again',
    from: interval ? formatGap(interval.before, t) : null,
    to: interval ? formatGap(interval.after, t) : null,
    fromDays: interval?.before ?? null,
    toDays: interval?.after ?? null,
  };
}

/**
 * The tally for the end of a batch: cards remembered, reviews it took, misses
 * that brought a card round again, and how many were new.
 */
export function batchTally(stats, batch) {
  const reviews = (stats.again ?? 0) + (stats.hard ?? 0) + (stats.good ?? 0) + (stats.easy ?? 0);
  return {
    remembered: batch.length,
    reviews,
    missed: stats.again ?? 0,
    fresh: batch.filter((c) => c.isNew).length,
  };
}

/** How many cards the next batch would take from `waiting` due cards. */
export function nextBatchSize(size, waiting) {
  return size ? Math.min(size, waiting) : waiting;
}
