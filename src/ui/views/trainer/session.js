export const BATCH_SIZES = [0, 5, 10, 20, 30, 50, 100];

export const NEW_STEP = 5;
export const NEW_MAX = 500;

export function batchOf(cards, size) {
  return size ? cards.slice(0, size) : cards;
}

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

export function canStepBatch(size, dir, due) {
  if (dir < 0) return size !== BATCH_SIZES[1] && !(size === 0 && due <= BATCH_SIZES[1]);
  return size !== 0;
}

export function stepNew(n, dir) {
  return Math.max(0, Math.min(NEW_MAX, (Number(n) || 0) + dir * NEW_STEP));
}

export function formatGap(days, t) {
  if (days == null) return t('new');
  if (days >= 365) {
    const years = Math.round((days / 365) * 10) / 10;
    return t('{n} yr', { n: years });
  }
  return t('{n} d', { n: Math.max(1, Math.round(days)) });
}

export function formatWhen(days, t, tp) {
  if (days == null) return null;
  if (days < 1.5) return t('tomorrow');
  if (days >= 365) {
    const years = Math.round(days / 365);
    return tp('in {n} year', 'in {n} years', years);
  }
  return tp('in {n} day', 'in {n} days', Math.round(days));
}

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

export function batchTally(stats, batch) {
  const reviews = (stats.again ?? 0) + (stats.hard ?? 0) + (stats.good ?? 0) + (stats.easy ?? 0);
  return {
    remembered: batch.length,
    reviews,
    missed: stats.again ?? 0,
    fresh: batch.filter((c) => c.isNew).length,
  };
}

export function nextBatchSize(size, waiting) {
  return size ? Math.min(size, waiting) : waiting;
}
