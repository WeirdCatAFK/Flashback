/**
 * What the book iframe needs from the app theme. A section renders in its own
 * document and cannot inherit CSS variables, so the values are read out and
 * handed to epub.js as literals — which is also why highlight fills are colours
 * here rather than classes.
 */

export const HL_VARS = { amber: '--color-hl-1', green: '--color-hl-2', blue: '--color-hl-3', pink: '--color-hl-4' };
export const FONT_MIN = 80;
export const FONT_MAX = 200;
export const FONT_STEP = 10;
export const FONT_DEFAULT = 100;

const readVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** A highlight colour key as a concrete colour string. */
export function resolveColor(key, read = readVar) {
  return read(HL_VARS[key] ?? HL_VARS.amber) || '#f5c542';
}

/** The epub.js theme for the active app theme: body colour and background, link colour. */
export function renditionTheme(read = readVar) {
  const v = (name, fallback) => read(name) || fallback;
  return {
    body: { color: v('--color-fg-primary', '#1c1a17'), background: v('--color-bg-reader', '#faf8f4') },
    a: { color: v('--color-accent', '#b06d12') },
  };
}

export const clampFont = (pct) => Math.min(FONT_MAX, Math.max(FONT_MIN, pct));
