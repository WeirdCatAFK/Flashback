const KEY = 'fb-tree-icons';

export function treeIconsOn() {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

export function applyTreeIcons(on = treeIconsOn()) {
  document.documentElement.dataset.treeIcons = on ? 'on' : 'off';
}

export function setTreeIcons(on) {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch { }
  applyTreeIcons(on);
}
