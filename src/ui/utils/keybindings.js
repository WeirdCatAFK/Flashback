const STORAGE_KEY = "fb-keybindings";
export const KB_EVENT = "fb-keybindings-change";

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

export function loadKeybindings() {
  return { ...DEFAULTS, ...readStored() };
}

function commit(stored) {
  if (Object.keys(stored).length === 0) localStorage.removeItem(STORAGE_KEY);
  else localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  window.dispatchEvent(new Event(KB_EVENT));
}

export function saveKeybinding(actionId, keys) {
  const stored = readStored();
  stored[actionId] = keys;
  commit(stored);
}

export function resetKeybinding(actionId) {
  const stored = readStored();
  delete stored[actionId];
  commit(stored);
}

export function resetAllKeybindings() {
  commit({});
}

export const MODIFIER_KEYS = ["Control", "Shift", "Alt", "Meta", "AltGraph"];

export function eventKeyName(e) {
  const base = e.key === " " || e.code === "Space" ? "Space" : e.key.length === 1 ? e.key.toUpperCase() : e.key;
  return `${e.ctrlKey || e.metaKey ? "Ctrl+" : ""}${e.altKey ? "Alt+" : ""}${base}`;
}

export function actionForKey(map, ids, name) {
  return ids.find((id) => (map[id] ?? []).includes(name)) ?? null;
}

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

export function keyParts(name) {
  const parts = name.length > 1 && name.includes("+") ? name.split("+").filter(Boolean) : [name];
  if (name.endsWith("++")) parts.push("+");
  return parts.map((p) => KEY_LABELS[p] ?? p);
}
