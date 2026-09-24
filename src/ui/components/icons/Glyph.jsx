/**
 * Glyph — the frame every icon is drawn in: a solid silhouette in `currentColor`,
 * on a 16 grid (the tree's glyphs) or a 24 grid (the activity bar's).
 *
 * Silhouettes, not outlines: an outline draws every edge twice, and a column of
 * them is a lot of contour to read past. A filled shape has one edge, is told
 * apart by its outer shape, and reads as quieter at the same colour. Each icon is
 * one shape with at most one cut-out for its cue; a second layer, where one is
 * needed (the card behind a card, the back of an open folder), is the same colour
 * at 45%. The colour is the caller's, and the callers keep it muted — see
 * INTERFACE.md § Icons.
 */

export default function Glyph({ size = 15, grid = 16, className = "", children }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${grid} ${grid}`}
      fill="currentColor"
      aria-hidden="true"
      className={className || undefined}
      style={{ flexShrink: 0 }}
    >
      {children}
    </svg>
  );
}
