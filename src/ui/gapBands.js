/**
 * The gap between reviews, as the screens name it: the bands Flashcards groups and
 * filters by and Statistics counts, with their labels. The bands themselves (and the
 * interval each covers) are `shared/intervals.js GAP_BANDS`, so the server and every
 * screen cut them the same way. Labels are functions of `t`; ids are what is stored.
 */

import { GAP_BANDS } from '../shared/intervals.js';

/** The bands in order, with their labels. */
export const bandOptions = (t) => GAP_BANDS.map((b) => ({ id: b.id, label: bandLabel(b.id, t) }));

/** One band's label. */
export function bandLabel(id, t) {
  switch (id) {
    case 'new': return t('New');
    case 'd1': return t('1 day');
    case 'wk': return t('Up to a week');
    case 'w3': return t('Up to 3 weeks');
    case 'm2': return t('Up to 2 months');
    case 'long': return t('Longer');
    default: return id;
  }
}
