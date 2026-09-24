/**
 * The Decks screen's pure pieces: the grid order, what a box's caption says, the
 * long-term share its thin line draws, the next free "New deck" name, and the box
 * colours' names. No React; labels take `t`.
 */

import { DECK_COLORS } from '../../../shared/deckColors.js';

export { DECK_COLORS, deckColor } from '../../../shared/deckColors.js';

/** The default deck first, then the API's order (most recently changed first). */
export const sortDecks = (list) => [...list].sort((a, b) => (b.is_system ? 1 : 0) - (a.is_system ? 1 : 0));

/**
 * A box's caption: how many cards are due now, else how many are new, else that
 * nothing is. `strong` is whether it deserves weight.
 */
export function deckStatus(standing, t, tp) {
  const s = standing ?? { due: 0, fresh: 0 };
  if (s.due > 0) return { text: tp('{n} due', '{n} due', s.due), strong: true };
  if (s.fresh > 0) return { text: tp('{n} new', '{n} new', s.fresh), strong: false };
  return { text: t('nothing due'), strong: false };
}

/** The share of a deck's cards held long-term, 0..1. */
export const longTermShare = (standing, count) => (count > 0 ? Math.min(1, (standing?.longTerm ?? 0) / count) : 0);

/** "New deck", or "New deck 2", "New deck 3"… — the first name no deck has. */
export function newDeckName(decks, t) {
  const names = new Set(decks.map((d) => d.name));
  const base = t('New deck');
  if (!names.has(base)) return base;
  for (let k = 2; ; k += 1) {
    const name = t('New deck {n}', { n: k });
    if (!names.has(name)) return name;
  }
}

/** A box colour's name, for its swatch. */
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

/** Every palette colour with its name, in swatch order. */
export const colorOptions = (t) => DECK_COLORS.map((id) => ({ id, label: colorName(id, t) }));
