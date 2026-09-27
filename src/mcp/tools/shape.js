/**
 * How tool results are shaped before they reach a model: small by default, since a model reads
 * every character it is sent and a vault's raw payloads run to hundreds of thousands of them.
 * Tools return counts, names and clipped text first and take an explicit opt-in for the rest.
 *
 * Paths come back with forward slashes whatever the host OS. The API answers with the
 * platform's separator (backslashes on Windows) while every tool takes forward slashes, and a
 * model that copies a returned path into the next call should not have to know the difference.
 */

const PATH_KEY = /(^path$|_path$|Path$)/;

/** Deep copy of `value` with every path-named string field in forward-slash form. */
export function slashPaths(value) {
  if (Array.isArray(value)) return value.map(slashPaths);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = typeof v === 'string' && PATH_KEY.test(key) ? v.replace(/\\/g, '/') : slashPaths(v);
  }
  return out;
}

/** Wraps a value as an MCP text content block, paths in forward-slash form. */
export const asText = (data) => ({ content: [{ type: 'text', text: JSON.stringify(slashPaths(data), null, 2) }] });

/** A string cut to `max` characters, marked with an ellipsis when cut; null stays null. */
export const clip = (text, max = 160) =>
  (typeof text === 'string' && text.length > max ? `${text.slice(0, max - 1)}…` : text ?? null);
