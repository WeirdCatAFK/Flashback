export const THEMES = [
  "light-workbench",
  "dark-workbench",
  "dark-workbench-lamp",
  "dark-cherry",
  "dark-cherry-lamp",
  "raven-indigo",
  "raven-indigo-lamp",
  "focus-blue",
  "focus-blue-lamp",
];

export function themeLabel(t, id) {
  switch (id) {
    case "light-workbench": return t("Light workbench");
    case "dark-workbench": return t("Dark workbench · Focus");
    case "dark-workbench-lamp": return t("Dark workbench · Lamp");
    case "dark-cherry": return t("Dark cherry · Focus");
    case "dark-cherry-lamp": return t("Dark cherry · Lamp");
    case "raven-indigo": return t("Raven indigo · Focus");
    case "raven-indigo-lamp": return t("Raven indigo · Lamp");
    case "focus-blue": return t("Calm blue · Focus");
    case "focus-blue-lamp": return t("Calm blue · Lamp");
    default: return id;
  }
}
