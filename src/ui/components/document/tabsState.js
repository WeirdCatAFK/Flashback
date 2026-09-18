/**
 * Pure helpers for the editor's per-tab state: relocating dirty flags and drafts
 * when a file moves, pruning them when a tab closes, merging the live reading
 * position over the stored record, and the highlight ↔ card bookkeeping a
 * removal needs. Every function returns its input unchanged when nothing changed,
 * so React sees a stable reference and skips the render.
 */

import { relocatePath } from "../../utils/relocatePath.js";

/** `set` of paths with every path under `from` moved under `to`. */
export function relocateSet(set, from, to) {
  let changed = false;
  const next = new Set();
  for (const p of set) {
    const np = relocatePath(p, from, to);
    if (np !== p) changed = true;
    next.add(np);
  }
  return changed ? next : set;
}

/** `map` keyed by path with every key under `from` moved under `to`. */
export function relocateMap(map, from, to) {
  let changed = false;
  const next = new Map();
  for (const [p, v] of map) {
    const np = relocatePath(p, from, to);
    if (np !== p) changed = true;
    next.set(np, v);
  }
  return changed ? next : map;
}

/** `set` restricted to paths still open. */
export function pruneSet(set, openPaths) {
  const next = new Set([...set].filter((p) => openPaths.has(p)));
  return next.size !== set.size ? next : set;
}

/** `map` restricted to keys still open. */
export function pruneMap(map, openPaths) {
  let changed = false;
  const next = new Map(map);
  for (const key of next.keys()) {
    if (!openPaths.has(key)) {
      next.delete(key);
      changed = true;
    }
  }
  return changed ? next : map;
}

/** `set` with `path` added or removed. */
export function toggleIn(set, path, on) {
  const next = new Set(set);
  if (on) next.add(path);
  else next.delete(path);
  return next;
}

/** `map` with `path` set to `value`, or removed when `value` is undefined. */
export function setOrDelete(map, path, value) {
  const next = new Map(map);
  if (value === undefined) next.delete(path);
  else next.set(path, value);
  return next;
}

/**
 * The record the reading bar shows: the live position overlays only
 * `position`/`percent`; `furthest` and `finished` stay the server's to advance.
 */
export function barProgressFor(shown, live) {
  if (!live) return shown;
  return {
    ...(shown ?? { furthest: null, furthestPercent: null, finished: false }),
    unit: live.unit,
    position: live.position,
    percent: live.percent,
    total: live.total ?? shown?.total ?? null,
  };
}

const anchoredTo = (card, id) =>
  card?.vanillaData?.location?.type === "highlight" &&
  card?.vanillaData?.location?.id === id;

/** How many cards are anchored to highlight `id`. */
export const cardsForHighlight = (flashcards, id) =>
  flashcards.filter((c) => anchoredTo(c, id)).length;

/** `meta` with the cards anchored to highlight `id` removed. */
export const withoutHighlightCards = (meta, id) => ({
  ...meta,
  flashcards: (meta.flashcards ?? []).filter((c) => !anchoredTo(c, id)),
});
