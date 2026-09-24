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

/**
 * The reading measure inside a section's iframe, which cannot read `--size-7xl`:
 * the same 760px the document head and a Markdown note use, as a literal.
 */
const MEASURE = '47.5rem';

/** The variable on each section's root element that says where the column starts. */
const START_VAR = '--fb-start';

/** The column start each rendition was last given, for sections laid out later. */
const starts = new WeakMap();

/**
 * The epub.js theme for the active app theme: body colour and background, link
 * colour, and the reading measure — the book flows down a column the width of the
 * head above it, with the side padding the head has. Where the column starts is a
 * variable on the section's root element (`--fb-start`, see `leanTo`), not a
 * value here: epub.js writes `margin: 0` onto the body inline each time it lays
 * a section out, which would wipe any margin set there, so the rule is the
 * stylesheet's own, `!important`, and only the variable moves.
 */
export function renditionTheme(read = readVar) {
  const v = (name, fallback) => read(name) || fallback;
  return {
    body: {
      color: v('--color-fg-primary', '#1c1a17'),
      background: v('--color-bg-reader', '#faf8f4'),
      'max-width': MEASURE,
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

/**
 * The room the card margin takes on the right, as a literal for the same reason as
 * MEASURE: `--size-lg` (the column) plus `--space-8` (the gap before it).
 */
const MARGIN_ROOM = '252px';

/**
 * Where the book's column starts. `--measure-start` on the viewport is `auto`
 * (centred) with the file tree docked, and a length that leans it left with the
 * tree hidden; read from the viewport because the frame cannot see it. Centred with
 * the card margin showing, the column moves left by half the margin's room, so the
 * text and the cards are centred together as they are in a note.
 */
export function marginStart(lean, withMargin) {
  if (lean && lean !== 'auto') return lean;
  return withMargin ? `max(0px, (100% - ${MEASURE} - ${MARGIN_ROOM}) / 2)` : 'auto';
}

export function leanTo(rendition, viewport, withMargin = false) {
  if (!rendition || !viewport) return;
  const lean = getComputedStyle(viewport).getPropertyValue('--measure-start').trim();
  const start = marginStart(lean, withMargin);
  if (starts.get(rendition) === start) return;
  starts.set(rendition, start);
  for (const contents of rendition.getContents?.() ?? []) applyStart(rendition, contents);
  requestAnimationFrame(() => {
    for (const view of rendition.manager?.views?.all?.() ?? []) {
      try { view.pane?.render(); } catch { }
    }
  });
}

/**
 * Gives one section the rendition's column start. Called for every section on
 * the page by `leanTo`, and from the content hook for each section laid out after.
 * The highlight layer is drawn from the text's position, so `leanTo` redraws it.
 */
export function applyStart(rendition, contents) {
  const root = contents?.document?.documentElement;
  if (root) root.style.setProperty(START_VAR, starts.get(rendition) ?? 'auto');
}

export const clampFont = (pct) => Math.min(FONT_MAX, Math.max(FONT_MIN, pct));
