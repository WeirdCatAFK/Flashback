/**
 * What a card row says about a card, as plain functions: its front on one line,
 * its source's title, when it next comes due, and its health flag's label. Shared
 * by the Flashcards catalogue and the Decks screen. No React; labels take `t`.
 */

const DAY_MS = 86_400_000;

/** A path with forward slashes, whatever the platform stored. */
export const slashed = (p) => (p ? String(p).replace(/\\/g, '/') : p);

/** The last segment of a path. */
export const leafName = (p) => slashed(p).split('/').pop();

/** A document's title: its file name without the extension. */
export const docTitle = (p) => leafName(p).replace(/\.[^.]+$/, '') || leafName(p);

/** A row's front as one plain line: cloze blanks read as ___, a custom card by its name. */
export function frontLine(card) {
  const text = card.card_type === 'custom' ? card.name : (card.frontText || card.name);
  return String(text ?? '').replace(/\{\{([^}]+)\}\}/g, ' ___ ').replace(/\s+/g, ' ').trim();
}

/**
 * When a card next comes due, as a row says it: "new", "due now", "due tomorrow",
 * "due in 8 d". The due date is the last review plus the gap, counted in whole days
 * from `now`.
 */
export function dueLabel(card, now, t) {
  if (card.gap == null) return t('new');
  const last = card.last_recall ? Date.parse(card.last_recall) : NaN;
  if (Number.isNaN(last)) return t('due now');
  const days = Math.ceil((last + card.gap * DAY_MS - now) / DAY_MS);
  if (days <= 0) return t('due now');
  if (days === 1) return t('due tomorrow');
  return t('due in {n} d', { n: days });
}

/** Short label for one kind in a row's `flags` column. */
export function flagLabel(kind, t) {
  switch (kind) {
    case 'mouthful': return t('overloaded');
    case 'probe': return t('productive');
    case 'overdue_drift': return t('reviewed late');
    case 'session_fatigue': return t('late in session');
    default: return kind;
  }
}
