/**
 * Metadata's arithmetic, pure so it tests under node: the priority levels categories sit
 * on, where a move puts one, and how tags are filtered, ordered and described.
 *
 * A category's `priority` is its level, lower studied first, and several categories can
 * share one. The levels are the distinct priorities in order, shown as Level 1…n whatever
 * numbers they are stored under. A move renumbers them `base`, `base + 1`… with no gaps,
 * `base` being the lowest priority stored now (never below 0), so a vault whose first
 * level is 0, as the defaults are, keeps 0. Only the rows whose number changes are written.
 */

/** The distinct priorities, lowest (studied first) first. */
export const levelsOf = (cats) => [...new Set(cats.map((c) => c.priority))].sort((a, b) => a - b);

/** The levels with their categories, each level's in alphabetical order. */
export const tiersOf = (cats) => levelsOf(cats).map((priority) => ({
  priority,
  members: cats.filter((c) => c.priority === priority).sort((a, b) => a.name.localeCompare(b.name)),
}));

/**
 * The priority writes that put category `id` on `target`: `{ level: priority }` for an
 * existing level, `'top'` or `'bottom'` for a new level of its own above or below the rest.
 * `[{ id, priority }]`, empty when nothing moves.
 */
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

/**
 * Where Raise (`dir` -1) or Lower (+1) takes a category: the next level that way, or a new
 * level of its own when it is at the edge but shares that level. Null when it is already
 * alone at the edge, which is when the button is disabled.
 */
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

/** The priority a new category gets: the last level, studied last. */
export const newCategoryPriority = (cats) => {
  const levels = levelsOf(cats);
  return levels.length ? levels[levels.length - 1] : 0;
};

/** Applies priority writes to the list, for the optimistic redraw while they save. */
export const withPriorities = (cats, changes) => {
  const next = new Map(changes.map((c) => [c.id, c.priority]));
  return cats.map((c) => (next.has(c.id) ? { ...c, priority: next.get(c.id) } : c));
};

/**
 * Where a tag is applied, as `[kind, n]` pairs with n > 0, in the order the sentence reads:
 * folders, documents, decks, then cards tagged themselves.
 */
export const reachOf = (tag) => [
  ['folder', tag.folders],
  ['document', tag.documents],
  ['deck', tag.decks],
  ['card', tag.cardsDirect],
].filter(([, n]) => n > 0);

/** The tags whose name contains `query` (case-insensitive, a leading `#` ignored), in `sort` order: `'use'` by cards reached, `'az'` by name. */
export function shownTags(tags, query, sort) {
  const q = String(query ?? '').trim().replace(/^#/, '').toLowerCase();
  const kept = q ? tags.filter((t) => t.name.toLowerCase().includes(q)) : [...tags];
  const byName = (a, b) => a.name.localeCompare(b.name);
  return kept.sort(sort === 'use' ? (a, b) => b.cards - a.cards || byName(a, b) : byName);
}

/** The cards with no category: every card less those the categories count. */
export const uncategorized = (total, cats) => Math.max(0, total - cats.reduce((n, c) => n + (c.cards ?? 0), 0));
