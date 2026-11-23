import { relocatePath } from "../../utils/relocatePath.js";

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

export function pruneSet(set, openPaths) {
  const next = new Set([...set].filter((p) => openPaths.has(p)));
  return next.size !== set.size ? next : set;
}

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

export function toggleIn(set, path, on) {
  const next = new Set(set);
  if (on) next.add(path);
  else next.delete(path);
  return next;
}

export function setOrDelete(map, path, value) {
  const next = new Map(map);
  if (value === undefined) next.delete(path);
  else next.set(path, value);
  return next;
}

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

export const cardsForHighlight = (flashcards, id) =>
  flashcards.filter((c) => anchoredTo(c, id)).length;

export const withoutHighlightCards = (meta, id) => ({
  ...meta,
  flashcards: (meta.flashcards ?? []).filter((c) => !anchoredTo(c, id)),
});
