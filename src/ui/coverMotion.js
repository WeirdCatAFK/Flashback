/**
 * Whether drawn covers move — a cosmetic preference that belongs to the person, like
 * the tree's icons, so it is a plain global localStorage key (`fb-cover-motion`). It is
 * applied as `data-cover-motion` on the document root, where CoverArt.css reads it, so
 * the Config switch stills an open cover at once; a cover moved from script (the stella
 * octangula) listens through `onCoverMotionChange` and stops its loop instead of
 * spinning idle. Reduced motion, when the system asks for it, stills them regardless.
 */

const KEY = 'fb-cover-motion';
const listeners = new Set();

/** The stored preference; covers move unless someone turned it off. */
export function coverMotionOn() {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

/** Reflects a preference onto the document root. */
export function applyCoverMotion(on = coverMotionOn()) {
  document.documentElement.dataset.coverMotion = on ? 'on' : 'off';
}

/** Stores and applies a new preference, and tells the covers moved from script. */
export function setCoverMotion(on) {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch { }
  applyCoverMotion(on);
  listeners.forEach((fn) => fn(on));
}

/** Calls `fn(on)` whenever the preference changes; returns the unsubscribe. */
export function onCoverMotionChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
