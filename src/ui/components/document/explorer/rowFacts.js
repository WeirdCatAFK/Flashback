export function docStem(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

export function docKind(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function readFacts({ progress = null, rollup = null }, t) {
  if (rollup) {
    if (!rollup.total || rollup.finished + rollup.inProgress === 0) return { value: null, finished: false, label: null };
    const label = rollup.subscription
      ? t('{done} of {total} issues read', { done: rollup.finished, total: rollup.total })
      : t('{done} of {total} read', { done: rollup.finished, total: rollup.total });
    return { value: Math.min(1, Math.max(0, rollup.percent ?? 0)), finished: rollup.finished === rollup.total, label };
  }
  if (!progress) return { value: null, finished: false, label: t('not started') };
  if (progress.finished) return { value: 1, finished: true, label: t('Finished') };
  const pct = progress.furthestPercent;
  if (pct == null) return { value: 0.04, finished: false, label: t('Started') };
  return { value: Math.min(1, Math.max(0, pct)), finished: false, label: t('{percent}% read', { percent: Math.round(pct * 100) }) };
}
