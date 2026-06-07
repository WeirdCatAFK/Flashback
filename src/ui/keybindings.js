// Global keybindings, modelled on the theme system: a central registry of
// bindable actions with defaults, user overrides persisted in localStorage, and
// a change event so every consumer stays in sync. Features register their
// actions here and read the resolved map via `useKeybindings()`; nothing
// hardcodes keys at the call site.

const STORAGE_KEY = 'fb-keybindings';
export const KB_EVENT = 'fb-keybindings-change';

// The registry. Add a group here and any feature can bind against it; the Config
// editor renders straight from this list.
export const KEYBINDING_ACTIONS = [
  {
    group: 'Trainer',
    actions: [
      { id: 'trainer.reveal',     label: 'Reveal answer', default: ['Space', 'Enter'] },
      { id: 'trainer.gradeAgain', label: 'Grade · Again', default: ['1'] },
      { id: 'trainer.gradeGood',  label: 'Grade · Good',  default: ['2'] },
      { id: 'trainer.gradeEasy',  label: 'Grade · Easy',  default: ['3'] },
      { id: 'trainer.viewSource', label: 'View source',   default: ['S'] },
    ],
  },
];

const DEFAULTS = Object.fromEntries(
  KEYBINDING_ACTIONS.flatMap((g) => g.actions.map((a) => [a.id, a.default])),
);

function readStored() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') ?? {};
  } catch {
    return {};
  }
}

/** The resolved map: defaults with any user overrides applied. */
export function loadKeybindings() {
  return { ...DEFAULTS, ...readStored() };
}

function commit(stored) {
  if (Object.keys(stored).length === 0) localStorage.removeItem(STORAGE_KEY);
  else localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  window.dispatchEvent(new Event(KB_EVENT));
}

/** Override an action's keys (an array of normalised key names). */
export function saveKeybinding(actionId, keys) {
  const stored = readStored();
  stored[actionId] = keys;
  commit(stored);
}

/** Drop the override for one action (revert to its default). */
export function resetKeybinding(actionId) {
  const stored = readStored();
  delete stored[actionId];
  commit(stored);
}

/** Clear every override. */
export function resetAllKeybindings() {
  commit({});
}

/**
 * Canonical name for a key event, used both when recording a binding and when
 * matching one at runtime, so the two always agree. Space → 'Space', single
 * characters are upper-cased ('1', 'A'), everything else uses e.key ('Enter',
 * 'ArrowLeft', …).
 */
export function eventKeyName(e) {
  if (e.key === ' ' || e.code === 'Space') return 'Space';
  if (e.key.length === 1) return e.key.toUpperCase();
  return e.key;
}

// Short, display-friendly label for a stored key name — keeps long names like
// 'ArrowUp' from overflowing keycaps.
const KEY_LABELS = {
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Enter: '⏎', Escape: 'Esc', Backspace: '⌫', Delete: 'Del', Tab: '⇥',
};
export function formatKeyLabel(name) {
  return KEY_LABELS[name] ?? name;
}
