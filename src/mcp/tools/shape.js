const PATH_KEY = /(^path$|_path$|Path$)/;

export function slashPaths(value) {
  if (Array.isArray(value)) return value.map(slashPaths);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = typeof v === 'string' && PATH_KEY.test(key) ? v.replace(/\\/g, '/') : slashPaths(v);
  }
  return out;
}

export const asText = (data) => ({ content: [{ type: 'text', text: JSON.stringify(slashPaths(data), null, 2) }] });

export const clip = (text, max = 160) =>
  (typeof text === 'string' && text.length > max ? `${text.slice(0, max - 1)}…` : text ?? null);
