/**
 * Global keybindings: a registry of bindable actions with defaults, user
 * overrides in localStorage, and a change event so every consumer stays in sync.
 * Features register their actions here; nothing hardcodes keys at the call site.
 */

const STORAGE_KEY = "fb-keybindings";
export const KB_EVENT = "fb-keybindings-change";

/**
 * Fixed (non-rebindable) shortcuts. Informational only — used by ShortcutsOverlay
 * to build the cheatsheet. Each `keys` entry is an array of key-part strings
 * rendered as [Ctrl]+[K] etc.
 */
export function fixedShortcutGroups(t) {
  return [
    {
      group: t("General"),
      shortcuts: [
        { label: t("Open search"), keys: [["Ctrl", "K"]] },
        { label: t("Keyboard shortcuts"), keys: [["?"]] },
        { label: t("Zoom in"), keys: [["Ctrl", "+"]] },
        { label: t("Zoom out"), keys: [["Ctrl", "−"]] },
        { label: t("Reset zoom"), keys: [["Ctrl", "0"]] },
      ],
    },
    {
      group: t("Editor"),
      shortcuts: [{ label: t("Save document"), keys: [["Ctrl", "S"]] }],
    },
  ];
}

/**
 * The registry. Add a group here and any feature can bind against it; the Config
 * editor renders straight from this list.
 */
export function keybindingActions(t) {
  return [
    {
      group: t("Navigation"),
      actions: [
        { id: "nav.documents", label: t("Open Documents"), default: ["Ctrl+1"] },
        { id: "nav.flashcards", label: t("Open Flashcards"), default: ["Ctrl+2"] },
        { id: "nav.decks", label: t("Open Decks"), default: ["Ctrl+3"] },
        { id: "nav.trainer", label: t("Open the Trainer"), default: ["Ctrl+4"] },
        { id: "nav.stats", label: t("Open Statistics"), default: ["Ctrl+5"] },
        { id: "nav.diary", label: t("Open the Diary"), default: ["Ctrl+6"] },
        { id: "nav.graph", label: t("Open the Graph"), default: ["Ctrl+7"] },
        { id: "nav.seal", label: t("Open Seal"), default: ["Ctrl+8"] },
        { id: "nav.manage", label: t("Open Metadata"), default: ["Ctrl+9"] },
        { id: "nav.server", label: t("Open Server Management"), default: [] },
        { id: "nav.config", label: t("Open Config"), default: ["Ctrl+,"] },
      ],
    },
    {
      group: t("Trainer"),
      actions: [
        {
          id: "trainer.reveal",
          label: t("Reveal answer"),
          default: ["Space", "Enter"],
        },
        { id: "trainer.gradeAgain", label: t("Grade · Again"), default: ["1"] },
        {
          id: "trainer.gradeHard",
          label: t("Grade · Hard (FSRS)"),
          default: ["2"],
        },
        { id: "trainer.gradeGood", label: t("Grade · Good"), default: ["3"] },
        { id: "trainer.gradeEasy", label: t("Grade · Easy"), default: ["4"] },
        {
          id: "trainer.undo",
          label: t("Undo last grade"),
          default: ["Backspace"],
        },
        { id: "trainer.viewSource", label: t("View source"), default: ["S"] },
      ],
    },
  ];
}

/**
 * Defaults are structural, so they are read back out of the same registry with an
 * identity translator — the labels it returns are discarded. One source of truth
 * for ids and default keys, with no second list to keep in step.
 */
const DEFAULTS = Object.fromEntries(
  keybindingActions((s) => s).flatMap((g) =>
    g.actions.map((a) => [a.id, a.default]),
  ),
);

function readStored() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") ?? {};
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

/** Keys that only modify another; recording waits past them for the real key. */
export const MODIFIER_KEYS = ["Control", "Shift", "Alt", "Meta", "AltGraph"];

/**
 * Canonical name for a key event, used both when recording a binding and when
 * matching one at runtime, so the two always agree. Space → 'Space', single
 * characters are upper-cased ('1', 'A'), everything else uses e.key ('Enter',
 * 'ArrowLeft', …). Ctrl (or Cmd) and Alt prefix the name ('Ctrl+1'); Shift does
 * not, because it is already in the character it produces. A plain '1' binding
 * therefore never fires on Ctrl+1.
 */
export function eventKeyName(e) {
  const base = e.key === " " || e.code === "Space" ? "Space" : e.key.length === 1 ? e.key.toUpperCase() : e.key;
  return `${e.ctrlKey || e.metaKey ? "Ctrl+" : ""}${e.altKey ? "Alt+" : ""}${base}`;
}

/** The action a key name is bound to among `ids`, or null. */
export function actionForKey(map, ids, name) {
  return ids.find((id) => (map[id] ?? []).includes(name)) ?? null;
}

/**
 * Short, display-friendly label for a stored key name — keeps long names like
 * 'ArrowUp' from overflowing keycaps.
 */
const KEY_LABELS = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Enter: "⏎",
  Escape: "Esc",
  Backspace: "⌫",
  Delete: "Del",
  Tab: "⇥",
};
export function formatKeyLabel(name) {
  return keyParts(name).join("+");
}

/** A key name split into display parts: 'Ctrl+ArrowUp' → ['Ctrl', '↑']. */
export function keyParts(name) {
  const parts = name.length > 1 && name.includes("+") ? name.split("+").filter(Boolean) : [name];
  if (name.endsWith("++")) parts.push("+");
  return parts.map((p) => KEY_LABELS[p] ?? p);
}
