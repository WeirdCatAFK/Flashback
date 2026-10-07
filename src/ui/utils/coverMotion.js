/**
 * Whether drawn covers move
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
