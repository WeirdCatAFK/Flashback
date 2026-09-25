/**
 * Tag names as the whole app treats them: trimmed, without a leading "#", compared
 * exactly. `swapTag` is the one rule a vault-wide rename or removal applies to every
 * list of tags it meets (a document's, a folder's, a card's, a deck's): the name is
 * replaced in place, a duplicate it would create is dropped, and a removal drops it.
 */

/** A tag name as typed: trimmed, without a leading "#". */
export const cleanTagName = (name) => String(name ?? '').trim().replace(/^#+/, '').trim();

/**
 * `tags` with `from` renamed to `to`, or removed when `to` is null. Returns null when
 * `from` is not in the list, so a caller can tell an untouched list from a changed one.
 */
export function swapTag(tags, from, to = null) {
  if (!Array.isArray(tags) || !tags.includes(from)) return null;
  const out = [];
  for (const t of tags) {
    const next = t === from ? to : t;
    if (next && !out.includes(next)) out.push(next);
  }
  return out;
}
