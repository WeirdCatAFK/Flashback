/**
 * A study session's scope — what is in, what is left out — as plain data.
 *
 * The shape is what `fb-trainer-scope` persists and what the Documents view hands
 * over as a `studySession`; every reader goes through `normalizeScope()` so a blob
 * saved by an older build never throws on a key it did not have yet.
 */

/** The scope in one shape, defaulted field by field. */
export function normalizeScope(raw) {
  return {
    folder: raw?.folder ?? null,
    document: raw?.document ?? null,
    deck: raw?.deck ?? null,
    deckName: raw?.deckName ?? null,
    tags: raw?.tags ?? null,
    exclude: {
      folders: raw?.exclude?.folders ?? [],
      documents: raw?.exclude?.documents ?? [],
      decks: raw?.exclude?.decks ?? [],
      tags: raw?.exclude?.tags ?? [],
    },
  };
}

/** Whether anything at all is excluded. */
export const hasExclusions = (ex) =>
  (ex?.folders?.length ?? 0) + (ex?.documents?.length ?? 0) +
  (ex?.decks?.length ?? 0) + (ex?.tags?.length ?? 0) > 0;

const leafOf = (path) => path.split('/').pop();

/** How many rules the scope applies, counting each inclusion and each exclusion once. */
export function scopeRuleCount(scope) {
  const ex = scope.exclude;
  return (scope.folder ? 1 : 0) + (scope.document ? 1 : 0) + (scope.deck ? 1 : 0) + (scope.tags?.length ?? 0)
    + ex.folders.length + ex.documents.length + ex.decks.length + ex.tags.length;
}

/**
 * The scope summed up in the line the filter button shows: what is studied, then
 * how much is left out. "Everything" when nothing narrows it.
 * @returns {{ study: string, leftOut: string|null }}
 */
export function scopeSummary(scope, t, tp) {
  const parts = [];
  if (scope.deck) parts.push(scope.deckName ?? scope.deck);
  if (scope.folder) parts.push(leafOf(scope.folder));
  if (scope.document) parts.push(leafOf(scope.document));
  if (scope.tags?.length) parts.push(scope.tags.map((tag) => `#${tag}`).join(' '));
  const ex = scope.exclude;
  const out = ex.folders.length + ex.documents.length + ex.decks.length + ex.tags.length;
  return {
    study: parts.length ? parts.join(' · ') : t('Everything'),
    leftOut: out ? tp('{n} left out', '{n} left out', out) : null,
  };
}

/** The scope a session starts from: the handed-over one, else the saved one, else empty. */
export function initialScope(studySession, savedJson) {
  if (studySession) return normalizeScope(studySession);
  try {
    if (savedJson) return normalizeScope(JSON.parse(savedJson));
  } catch { }
  return normalizeScope(null);
}

/** The identity of an exclusion entry: decks are `{hash, name}`, everything else a string. */
const exclusionKey = (kind) => (kind === 'decks' ? (v) => v.hash : (v) => v);

/** `scope` with `value` added to its `kind` exclusion list, unchanged if already there. */
export function withExclusion(scope, kind, value) {
  const list = scope.exclude[kind];
  const key = exclusionKey(kind);
  if (list.some((v) => key(v) === key(value))) return scope;
  return { ...scope, exclude: { ...scope.exclude, [kind]: [...list, value] } };
}

/** `scope` with the `kind` exclusion identified by `id` removed. */
export function withoutExclusion(scope, kind, id) {
  const key = exclusionKey(kind);
  return { ...scope, exclude: { ...scope.exclude, [kind]: scope.exclude[kind].filter((v) => key(v) !== id) } };
}

/**
 * The scope a handed-over `studySession` asks for. An exclusion-only request
 * widens the current exclusions; anything else replaces the scope outright.
 */
export function mergeStudySession(current, studySession) {
  if (!studySession.exclude) return normalizeScope(studySession);
  return normalizeScope({
    ...current,
    exclude: {
      folders: [...new Set([...current.exclude.folders, ...(studySession.exclude.folders ?? [])])],
      documents: [...new Set([...current.exclude.documents, ...(studySession.exclude.documents ?? [])])],
      decks: current.exclude.decks,
      tags: current.exclude.tags,
    },
  });
}

/** Whether `studySession` names the scope already applied, so nothing needs to restart. */
export function sameScope(current, studySession) {
  return !studySession.exclude &&
    (studySession.folder ?? null) === current.folder &&
    (studySession.document ?? null) === current.document &&
    (studySession.deck ?? null) === current.deck;
}
