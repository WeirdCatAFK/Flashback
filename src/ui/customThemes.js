const STORAGE_KEY = 'fb-custom-themes';
const STYLE_ID    = 'fb-custom-theme-styles';

export const THEME_VARS = [
  { key: '--color-bg-base',        label: 'Window background' },
  { key: '--color-bg-sidebar',     label: 'Activity bar background' },
  { key: '--color-bg-surface',     label: 'Panels & cards' },
  { key: '--color-bg-hover',       label: 'Hover state' },
  { key: '--color-fg-primary',     label: 'Primary text' },
  { key: '--color-fg-secondary',   label: 'Secondary text' },
  { key: '--color-fg-icon',        label: 'Inactive icons' },
  { key: '--color-accent',         label: 'Accent / active' },
  { key: '--color-border',         label: 'Borders & dividers' },
  { key: '--color-title-bar',      label: 'Title bar' },
  { key: '--color-accent-subtle',  label: 'Accent tint (selected bg)' },
  { key: '--color-tree-indent',    label: 'Tree indent line' },
  { key: '--color-sidebar-header', label: 'Sidebar header bar' },
];

export function loadCustomThemes() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
  } catch {
    return [];
  }
}

export function saveCustomTheme(theme) {
  const themes = loadCustomThemes().filter(t => t.name !== theme.name);
  themes.push(theme);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(themes));
  injectCustomThemeCSS(themes);
}

export function deleteCustomTheme(name) {
  const themes = loadCustomThemes().filter(t => t.name !== name);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(themes));
  injectCustomThemeCSS(themes);
}

export function injectCustomThemeCSS(themes) {
  let el = document.getElementById(STYLE_ID);
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  el.textContent = themes.map(t =>
    `[data-theme="${CSS.escape(t.name)}"] {\n` +
    Object.entries(t.colors).map(([k, v]) => `  ${k}: ${v};`).join('\n') +
    '\n}'
  ).join('\n\n');
}

export function resolvedThemeColors() {
  const style = getComputedStyle(document.documentElement);
  return Object.fromEntries(
    THEME_VARS.map(({ key }) => [key, style.getPropertyValue(key).trim()])
  );
}
