export const levelsOf = (cats) => [...new Set(cats.map((c) => c.priority))].sort((a, b) => a - b);

export const tiersOf = (cats) => levelsOf(cats).map((priority) => ({
  priority,
  members: cats.filter((c) => c.priority === priority).sort((a, b) => a.name.localeCompare(b.name)),
}));

export function placeCategory(cats, id, target) {
  const levels = levelsOf(cats);
  const base = levels.length ? Math.max(0, levels[0]) : 0;
  const groups = levels.map((p) => cats.filter((c) => c.priority === p && c.id !== id).map((c) => c.id));
  if (target === 'top') groups.unshift([id]);
  else if (target === 'bottom') groups.push([id]);
  else {
    const k = levels.indexOf(target?.level);
    if (k < 0) return [];
    groups[k].push(id);
  }
  const next = new Map();
  groups.filter((g) => g.length).forEach((g, k) => g.forEach((cid) => next.set(cid, base + k)));
  return cats.filter((c) => next.get(c.id) !== c.priority).map((c) => ({ id: c.id, priority: next.get(c.id) }));
}

export function shiftTarget(cats, id, dir) {
  const levels = levelsOf(cats);
  const c = cats.find((x) => x.id === id);
  if (!c) return null;
  const j = levels.indexOf(c.priority) + dir;
  if (j >= 0 && j < levels.length) return { level: levels[j] };
  const alone = cats.filter((x) => x.priority === c.priority).length === 1;
  if (alone) return null;
  return dir < 0 ? 'top' : 'bottom';
}

export const newCategoryPriority = (cats) => {
  const levels = levelsOf(cats);
  return levels.length ? levels[levels.length - 1] : 0;
};

export const withPriorities = (cats, changes) => {
  const next = new Map(changes.map((c) => [c.id, c.priority]));
  return cats.map((c) => (next.has(c.id) ? { ...c, priority: next.get(c.id) } : c));
};

export const reachOf = (tag) => [
  ['folder', tag.folders],
  ['document', tag.documents],
  ['deck', tag.decks],
  ['card', tag.cardsDirect],
].filter(([, n]) => n > 0);

export function shownTags(tags, query, sort) {
  const q = String(query ?? '').trim().replace(/^#/, '').toLowerCase();
  const kept = q ? tags.filter((t) => t.name.toLowerCase().includes(q)) : [...tags];
  const byName = (a, b) => a.name.localeCompare(b.name);
  return kept.sort(sort === 'use' ? (a, b) => b.cards - a.cards || byName(a, b) : byName);
}

export const uncategorized = (total, cats) => Math.max(0, total - cats.reduce((n, c) => n + (c.cards ?? 0), 0));
