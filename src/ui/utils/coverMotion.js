const KEY = 'fb-cover-motion';
const listeners = new Set();

export function coverMotionOn() {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

export function applyCoverMotion(on = coverMotionOn()) {
  document.documentElement.dataset.coverMotion = on ? 'on' : 'off';
}

export function setCoverMotion(on) {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch { }
  applyCoverMotion(on);
  listeners.forEach((fn) => fn(on));
}

export function onCoverMotionChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
