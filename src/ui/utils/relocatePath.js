// Remap a single path when its file/folder — or one of its ancestor folders —
// is moved or renamed. `oldPrefix` becomes `newPrefix`; anything nested under
// `oldPrefix` keeps its tail. Returns the path unchanged when it isn't affected.
//
// Used to keep open tabs, the active selection, expanded folders, and unsaved
// drafts pointing at the right file after a move/rename, so a later save writes
// to the new location instead of silently failing against the old one.
//
// Comparison is separator-agnostic (workspace paths use '/', but a stray '\'
// shouldn't break the match); the returned tail is sliced from the original so
// its separators are preserved.
export function relocatePath(path, oldPrefix, newPrefix) {
  if (!path) return path;
  const norm = (s) => s.replace(/\\/g, '/');
  const p = norm(path);
  const o = norm(oldPrefix);
  if (p === o) return newPrefix;
  if (p.startsWith(o + '/')) return newPrefix + path.slice(oldPrefix.length);
  return path;
}
