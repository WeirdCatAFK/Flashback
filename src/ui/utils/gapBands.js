import { GAP_BANDS } from '../../shared/intervals.js';

export const bandOptions = (t) => GAP_BANDS.map((b) => ({ id: b.id, label: bandLabel(b.id, t) }));

export function bandLabel(id, t) {
  switch (id) {
    case 'new': return t('New|interval band');
    case 'd1': return t('1 day');
    case 'wk': return t('Up to a week');
    case 'w3': return t('Up to 3 weeks');
    case 'm2': return t('Up to 2 months');
    case 'long': return t('Longer');
    default: return id;
  }
}
