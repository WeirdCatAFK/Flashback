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

/** The variables on each section's root element: where the column starts, and how wide it is. */
const START_VAR = '--fb-start';
const WIDTH_VAR = '--fb-measure';

/** The column each rendition was last given (`{ start, width }`), for sections laid out later. */
const columns = new WeakMap();

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

/**
 * The room the card margin takes on the right, as a literal because the frame
 * cannot read the app's tokens: `--size-lg` (the column) plus `--space-8` (the gap
 * before it).
 */
const MARGIN_ROOM = '252px';

/**
 * Where the book's column starts. `--measure-start` on the viewport is `auto`
 * (centred) with the file tree docked, and a length that leans it left with the
 * tree hidden; read from the viewport because the frame cannot see it. Centred with
 * the card margin showing, the column moves left by half the margin's room, so the
 * text and the cards are centred together as they are in a note.
 */
export function marginStart(lean, withMargin, width = MEASURE) {
  if (lean && lean !== 'auto') return lean;
  return withMargin ? `max(0px, (100% - ${width} - ${MARGIN_ROOM}) / 2)` : 'auto';
}

/**
 * Puts the book's column where the app's measure is: its start (`marginStart`)
 * and its width (`--measure-width`, wider while the file tree is hidden), both
 * read from the viewport. The document head, which sits above the book in the
 * same scroller, is given the same start (`headHost`), so the two stay aligned
 * when the column moves over for the card margin.
 */
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

/**
 * Gives one section the rendition's column. Called for every section on the page
 * by `leanTo`, and from the content hook for each section laid out after. The
 * highlight layer is drawn from the text's position, so `leanTo` redraws it.
 */
export function applyStart(rendition, contents) {
  const root = contents?.document?.documentElement;
  if (!root) return;
  const { start = 'auto', width = MEASURE } = columns.get(rendition) ?? {};
  root.style.setProperty(START_VAR, start);
  root.style.setProperty(WIDTH_VAR, width);
}

export const clampFont = (pct) => Math.min(FONT_MAX, Math.max(FONT_MIN, pct));
