/**
 * The card browser's filter vocabulary: sort orders, the card-health pills, and
 * the flag labels. Each is a function of `t` rather than a module constant so
 * a language switch re-renders it; `value` / `key` are stored, never translated.
 */

export const PAGE_SIZE = 50;

export const sortOptions = (t) => [
  { value: 'level:desc', label: t('Level ↓') },
  { value: 'level:asc', label: t('Level ↑') },
  { value: 'name:asc', label: t('Name A–Z') },
  { value: 'name:desc', label: t('Name Z–A') },
  { value: 'last_recall:desc', label: t('Recently reviewed') },
  { value: 'last_recall:asc', label: t('Least recently reviewed') },
  { value: 'difficulty:desc', label: t('Hardest first') },
  { value: 'difficulty:asc', label: t('Easiest first') },
];

/**
 * The two guards share one pill: from the browser's side both say "the failures
 * here are about your routine, not this card", and nothing can be done differently.
 */
export const flagFilters = (t) => [
  { value: 'any', label: t('flagged'), title: t('Cards the review classifier has flagged') },
  { value: 'mouthful', label: t('overloaded'), title: t('Cards that keep resetting to a short interval and look like too much at once') },
  { value: 'probe', label: t('productive'), title: t('Hard cards that are converging — worth keeping as they are') },
];

/** Short label for one kind in the `flags` column. */
export const flagLabel = (kind, t) => {
  switch (kind) {
    case 'mouthful': return t('overloaded');
    case 'probe': return t('productive');
    case 'overdue_drift': return t('reviewed late');
    case 'session_fatigue': return t('late in session');
    default: return kind;
  }
};

/** The search request for the current filters. */
export function searchArgsFor({ query, level, cardType, flagFilter, sort }) {
  const [sortBy, sortDir] = sort.split(':');
  return {
    search: query || null,
    level,
    cardType,
    flagged: flagFilter !== null,
    flagKind: flagFilter === 'any' ? null : flagFilter,
    sortBy,
    sortDir,
  };
}

/** Whether any filter narrows the list. */
export const hasFilters = ({ query, level, cardType, flagFilter }) => !!(query || level !== null || cardType || flagFilter !== null);

/** The badges a card row shows, in display order. */
export function cardBadges(card, t) {
  const badges = [];
  for (const kind of card.flags ? card.flags.split(',') : []) {
    badges.push({ key: `flag:${kind}`, label: flagLabel(kind, t), tone: kind === 'mouthful' ? 'hard' : kind === 'probe' ? 'accent' : 'muted', title: t('Open the card to see what this rests on') });
  }
  if (card.difficulty != null) {
    const value = card.difficulty.toFixed(1);
    badges.push({ key: 'difficulty', label: t('D {value}', { value }), title: t('FSRS difficulty {value} of 10 — how much effort this card costs to keep remembered', { value }) });
  }
  if (card.category) badges.push({ key: 'category', label: card.category, tone: 'accent' });
  if (card.card_type && card.card_type !== 'basic') badges.push({ key: 'type', label: card.typeLabel });
  if (card.document_name) badges.push({ key: 'doc', label: card.document_name, title: card.document_path, tone: 'outline' });
  else badges.push({ key: 'standalone', label: t('standalone'), title: t('Standalone card'), tone: 'accent' });
  return badges;
}
