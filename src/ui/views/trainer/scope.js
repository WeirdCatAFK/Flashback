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

export const hasExclusions = (ex) =>
  (ex?.folders?.length ?? 0) + (ex?.documents?.length ?? 0) +
  (ex?.decks?.length ?? 0) + (ex?.tags?.length ?? 0) > 0;

const leafOf = (path) => path.split('/').pop();

export function scopeRuleCount(scope) {
  const ex = scope.exclude;
  return (scope.folder ? 1 : 0) + (scope.document ? 1 : 0) + (scope.deck ? 1 : 0) + (scope.tags?.length ?? 0)
    + ex.folders.length + ex.documents.length + ex.decks.length + ex.tags.length;
}

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

export function initialScope(studySession, savedJson) {
  if (studySession) return normalizeScope(studySession);
  try {
    if (savedJson) return normalizeScope(JSON.parse(savedJson));
  } catch { }
  return normalizeScope(null);
}

const exclusionKey = (kind) => (kind === 'decks' ? (v) => v.hash : (v) => v);

export function withExclusion(scope, kind, value) {
  const list = scope.exclude[kind];
  const key = exclusionKey(kind);
  if (list.some((v) => key(v) === key(value))) return scope;
  return { ...scope, exclude: { ...scope.exclude, [kind]: [...list, value] } };
}

export function withoutExclusion(scope, kind, id) {
  const key = exclusionKey(kind);
  return { ...scope, exclude: { ...scope.exclude, [kind]: scope.exclude[kind].filter((v) => key(v) !== id) } };
}

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

export function sameScope(current, studySession) {
  return !studySession.exclude &&
    (studySession.folder ?? null) === current.folder &&
    (studySession.document ?? null) === current.document &&
    (studySession.deck ?? null) === current.deck;
}
