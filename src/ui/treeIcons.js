/**
 * Whether the file tree draws its icons — a cosmetic preference that belongs to the
 * person, not the vault, so it is a plain global localStorage key (`fb-tree-icons`).
 * It is applied as `data-tree-icons` on the document root, like the theme, so the
 * Config switch takes effect in an already-open tree without any shared state; a
 * tree without icons names each document's type in small mono instead.
 */

const KEY = 'fb-tree-icons';

/** The stored preference; icons are on unless someone turned them off. */
export function treeIconsOn() {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

/** Reflects a preference onto the document root, where the explorer's CSS reads it. */
export function applyTreeIcons(on = treeIconsOn()) {
  document.documentElement.dataset.treeIcons = on ? 'on' : 'off';
}

/** Stores and applies a new preference. */
export function setTreeIcons(on) {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch { }
  applyTreeIcons(on);
}
