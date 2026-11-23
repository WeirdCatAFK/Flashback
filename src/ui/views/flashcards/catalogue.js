import { gapBand } from '../../../shared/intervals.js';
import { slashed, leafName, docTitle } from '../../components/flashcard/cardLineText.js';
import { bandLabel } from '../../utils/gapBands.js';

export { slashed, leafName, docTitle, frontLine, dueLabel, flagLabel } from '../../components/flashcard/cardLineText.js';

export const PAGE_SIZE = 50;

export const MAX_SHOWN = 500;

export { bandOptions, bandLabel } from '../../utils/gapBands.js';

export const healthOptions = (t) => [
  { id: 'any', label: t('Flagged'), title: t('Cards the review classifier has flagged') },
  { id: 'mouthful', label: t('Overloaded'), title: t('Cards that keep resetting to a short interval and look like too much at once') },
  { id: 'probe', label: t('Productive'), title: t('Hard cards that are converging — worth keeping as they are') },
];

export const sortOptions = (t) => [
  { value: 'due', label: t('Next review') },
  { value: 'source', label: t('Source') },
  { value: 'front', label: t('A to Z') },
  { value: 'created', label: t('Newest') },
];

export const groupOptions = (t) => [
  { value: 'gap', label: t('Gap between reviews') },
  { value: 'source', label: t('Source') },
  { value: 'none', label: t('Nothing') },
];

const SORT_DIR = { due: 'asc', source: 'asc', front: 'asc', created: 'desc' };

export const EMPTY_VIEW = { query: '', source: null, band: null, health: null, cardType: '', tag: null, category: null, sort: 'due', group: 'gap' };

export const NO_NARROWING = { query: '', source: null, band: null, health: null, cardType: '', tag: null, category: null };

export const isNarrowed = (v) => !!(v.query || v.source || v.band || v.health || v.cardType || v.tag || v.category);

export function searchArgsFor(v, algorithm) {
  return {
    search: v.query.trim() || null,
    cardType: v.cardType || null,
    flagged: v.health !== null,
    flagKind: v.health && v.health !== 'any' ? v.health : null,
    band: v.band,
    tag: v.tag ?? null,
    category: v.category?.id ?? null,
    source: v.source?.kind ?? null,
    sourcePath: v.source?.path ?? null,
    groupBy: v.group === 'none' ? null : v.group,
    sortBy: v.sort,
    sortDir: SORT_DIR[v.sort] ?? 'asc',
    algorithm,
  };
}

export function buildSourceTree(documents) {
  const root = { children: new Map(), docs: [] };
  for (const d of documents) {
    const parts = slashed(d.path).split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const path = parts.slice(0, i + 1).join('/');
      if (!node.children.has(path)) node.children.set(path, { path, name: parts[i], children: new Map(), docs: [] });
      node = node.children.get(path);
    }
    node.docs.push({ kind: 'document', path: slashed(d.path), name: docTitle(d.path), cards: d.cards, longTerm: d.longTerm });
  }
  const byName = (a, b) => a.name.localeCompare(b.name);
  const finish = (node) => {
    const folders = [...node.children.values()].map((f) => {
      const children = finish(f);
      const sum = (key) => children.reduce((n, c) => n + c[key], 0);
      return { kind: 'folder', path: f.path, name: f.name, cards: sum('cards'), longTerm: sum('longTerm'), children };
    });
    return [...folders.sort(byName), ...node.docs.sort(byName)];
  };
  return finish(root);
}

export function ancestorsOf(path) {
  const parts = slashed(path).split('/');
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
}

export function scopeParts(v, t, typeLabel) {
  const parts = [];
  if (v.source?.kind === 'standalone') parts.push(t('Cards (default deck)'));
  else if (v.source?.kind === 'document') parts.push(docTitle(v.source.path));
  else if (v.source?.kind === 'folder') parts.push(leafName(v.source.path));
  if (v.tag) parts.push(`#${v.tag}`);
  if (v.category) parts.push(v.category.name);
  if (v.band) parts.push(bandLabel(v.band, t).toLowerCase());
  if (v.health) parts.push(healthOptions(t).find((h) => h.id === v.health)?.label.toLowerCase());
  if (v.cardType) parts.push(typeLabel(v.cardType).toLowerCase());
  return parts.filter(Boolean);
}

export function groupKeyOf(card, group) {
  if (group === 'gap') return gapBand(card.gap ?? null);
  if (group === 'source') return slashed(card.document_path) || null;
  return undefined;
}

export function groupLabel(group, key, t) {
  if (group === 'gap') return bandLabel(key, t);
  return key ? docTitle(key) : t('Cards (default deck)');
}

export function withGroupHeaders(cards, group, groups) {
  if (group === 'none' || !groups) return cards.map((card) => ({ header: false, card }));
  const counts = new Map(groups.map((g) => [g.key, g.count]));
  const out = [];
  let prev;
  cards.forEach((card, i) => {
    const key = groupKeyOf(card, group);
    if (i === 0 || key !== prev) out.push({ header: true, key, count: counts.get(key) ?? 0 });
    out.push({ header: false, card });
    prev = key;
  });
  return out;
}

export const share = (part, whole) => (whole > 0 ? Math.min(1, part / whole) : 0);
