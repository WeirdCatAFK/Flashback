import { DECK_COLORS } from '../../../shared/deckColors.js';

export { DECK_COLORS, deckColor } from '../../../shared/deckColors.js';

export const sortDecks = (list) => [...list].sort((a, b) => (b.is_system ? 1 : 0) - (a.is_system ? 1 : 0));

export function deckStatus(standing, t, tp) {
  const s = standing ?? { due: 0, fresh: 0 };
  if (s.due > 0) return { text: tp('{n} due', '{n} due', s.due), strong: true };
  if (s.fresh > 0) return { text: tp('{n} new', '{n} new', s.fresh), strong: false };
  return { text: t('nothing due'), strong: false };
}

export const longTermShare = (standing, count) => (count > 0 ? Math.min(1, (standing?.longTerm ?? 0) / count) : 0);

export function newDeckName(decks, t) {
  const names = new Set(decks.map((d) => d.name));
  const base = t('New deck');
  if (!names.has(base)) return base;
  for (let k = 2; ; k += 1) {
    const name = t('New deck {n}', { n: k });
    if (!names.has(name)) return name;
  }
}

export function colorName(id, t) {
  switch (id) {
    case 'slate': return t('Slate');
    case 'sage': return t('Sage');
    case 'ochre': return t('Ochre');
    case 'brick': return t('Brick');
    case 'plum': return t('Plum');
    case 'ink': return t('Ink');
    case 'kraft': return t('Kraft');
    default: return id;
  }
}

export const colorOptions = (t) => DECK_COLORS.map((id) => ({ id, label: colorName(id, t) }));
