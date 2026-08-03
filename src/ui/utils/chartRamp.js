/**
 * The app's one chart fill: the accent colour mixed into the surface by percentage.
 *
 * Every chart in Flashback is drawn from this single ramp rather than a palette, so
 * a bar, a heatmap cell and a curve's fill all read as the same material and follow
 * whichever theme is active — the accent is a CSS variable, never a literal colour.
 *
 * Lifted out of Stats.jsx when the card detail view became its second consumer.
 */
export const ramp = (pct) =>
  `color-mix(in srgb, var(--color-accent) ${pct}%, var(--color-bg-surface))`;
