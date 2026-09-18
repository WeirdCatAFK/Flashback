/**
 * Rewriting a document path after the file or a folder above it moved.
 */

export function relocatePath(path, oldPrefix, newPrefix) {
  if (!path) return path;
  const norm = (s) => s.replace(/\\/g, '/');
  const p = norm(path);
  const o = norm(oldPrefix);
  if (p === o) return newPrefix;
  if (p.startsWith(o + '/')) return newPrefix + path.slice(oldPrefix.length);
  return path;
}
