/**
 * A cover — the banner at the head of a deck's page or a document — and the rules
 * both share. It is stored as `{ kind: 'image', file, y }` (an image file of its
 * own, positioned vertically by `y` in 0..1) or `{ kind: 'pattern', pattern }` (a
 * drawing the renderer paints in the owner's colour, no file). Where the file
 * lives differs: a deck's under `_decks/covers/`, a document's in its folder's
 * `media/`.
 *
 * Shared because the API validates against it and the renderer offers the same
 * choices. No imports, so both load it as is.
 */

/** The image types a cover may be, and the extension each is stored under. */
export const COVER_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' };

/** The drawn covers, which need no file. */
export const COVER_PATTERNS = ['cards', 'arcs'];

/** The largest cover image accepted, in bytes. */
export const MAX_COVER_BYTES = 10 * 1024 * 1024;

/** A stored cover file name — checked on every read, since the canonical files can be edited by hand. */
const COVER_NAME = /^[A-Za-z0-9-]+\.(png|jpg|webp|gif|avif)$/;

/** The media type a stored cover file is served as. */
export function coverMime(file) {
  const ext = String(file).split('.').pop();
  return Object.entries(COVER_TYPES).find(([, e]) => e === ext)?.[0] ?? null;
}

/**
 * A stored cover as the API returns it, or null. Anything malformed — an unknown
 * pattern, a file name that is not a plain name — reads as no cover.
 */
export function cleanCover(cover) {
  if (cover?.kind === 'pattern' && COVER_PATTERNS.includes(cover.pattern)) return { kind: 'pattern', pattern: cover.pattern };
  if (cover?.kind === 'image' && COVER_NAME.test(cover.file ?? '')) {
    const y = Number.isFinite(cover.y) ? Math.min(1, Math.max(0, cover.y)) : 0.5;
    return { kind: 'image', file: cover.file, y };
  }
  return null;
}

/** A position from a request, clamped to 0..1. */
export const clampCoverY = (y) => Math.min(1, Math.max(0, Number(y) || 0));
