const DAY_MS = 86_400_000;

export const slashed = (p) => (p ? String(p).replace(/\\/g, '/') : p);

export const leafName = (p) => slashed(p).split('/').pop();

export const docTitle = (p) => leafName(p).replace(/\.[^.]+$/, '') || leafName(p);

export function frontLine(card) {
  const text = card.card_type === 'custom' ? card.name : (card.frontText || card.name);
  return String(text ?? '').replace(/\{\{([^}]+)\}\}/g, ' ___ ').replace(/\s+/g, ' ').trim();
}

export function dueLabel(card, now, t) {
  if (card.gap == null) return t('new');
  const last = card.last_recall ? Date.parse(card.last_recall) : NaN;
  if (Number.isNaN(last)) return t('due now');
  const days = Math.ceil((last + card.gap * DAY_MS - now) / DAY_MS);
  if (days <= 0) return t('due now');
  if (days === 1) return t('due tomorrow');
  return t('due in {n} d', { n: days });
}

export function flagLabel(kind, t) {
  switch (kind) {
    case 'mouthful': return t('overloaded');
    case 'probe': return t('productive');
    case 'overdue_drift': return t('reviewed late');
    case 'session_fatigue': return t('late in session');
    default: return kind;
  }
}
