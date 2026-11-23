export const cleanTagName = (name) => String(name ?? '').trim().replace(/^#+/, '').trim();

export function swapTag(tags, from, to = null) {
  if (!Array.isArray(tags) || !tags.includes(from)) return null;
  const out = [];
  for (const t of tags) {
    const next = t === from ? to : t;
    if (next && !out.includes(next)) out.push(next);
  }
  return out;
}
