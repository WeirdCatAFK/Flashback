export const HL_VARS = { amber: '--color-hl-1', green: '--color-hl-2', blue: '--color-hl-3', pink: '--color-hl-4' };
export const FONT_MIN = 80;
export const FONT_MAX = 200;
export const FONT_STEP = 10;
export const FONT_DEFAULT = 100;

const readVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function resolveColor(key, read = readVar) {
  return read(HL_VARS[key] ?? HL_VARS.amber) || '#f5c542';
}

const MEASURE = '47.5rem';

const START_VAR = '--fb-start';
const WIDTH_VAR = '--fb-measure';

const columns = new WeakMap();

export function renditionTheme(read = readVar) {
  const v = (name, fallback) => read(name) || fallback;
  return {
    body: {
      color: v('--color-fg-primary', '#1c1a17'),
      background: v('--color-bg-reader', '#faf8f4'),
      'max-width': `var(${WIDTH_VAR}, ${MEASURE})`,
      'margin-top': '0 !important',
      'margin-bottom': '0 !important',
      'margin-right': 'auto !important',
      'margin-left': `var(${START_VAR}, auto) !important`,
      padding: '0 2rem !important',
      'box-sizing': 'border-box',
    },
    a: { color: v('--color-accent', '#b06d12') },
  };
}

const MARGIN_ROOM = '252px';

export function marginStart(lean, withMargin, width = MEASURE) {
  if (lean && lean !== 'auto') return lean;
  return withMargin ? `max(0px, (100% - ${width} - ${MARGIN_ROOM}) / 2)` : 'auto';
}

export function leanTo(rendition, viewport, withMargin = false, headHost = null) {
  if (!rendition || !viewport) return;
  const style = getComputedStyle(viewport);
  const width = style.getPropertyValue('--measure-width').trim() || MEASURE;
  const start = marginStart(style.getPropertyValue('--measure-start').trim(), withMargin, width);
  if (headHost) headHost.style.setProperty('--measure-start', start);
  const last = columns.get(rendition);
  if (last && last.start === start && last.width === width) return;
  columns.set(rendition, { start, width });
  for (const contents of rendition.getContents?.() ?? []) applyStart(rendition, contents);
  requestAnimationFrame(() => {
    for (const view of rendition.manager?.views?.all?.() ?? []) {
      try { view.pane?.render(); } catch { }
    }
  });
}

export function applyStart(rendition, contents) {
  const root = contents?.document?.documentElement;
  if (!root) return;
  const { start = 'auto', width = MEASURE } = columns.get(rendition) ?? {};
  root.style.setProperty(START_VAR, start);
  root.style.setProperty(WIDTH_VAR, width);
}

export const clampFont = (pct) => Math.min(FONT_MAX, Math.max(FONT_MIN, pct));
