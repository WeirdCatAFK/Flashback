const STORAGE_KEY = 'fb-custom-themes';
const STYLE_ID    = 'fb-custom-theme-styles';

export const THEME_VARS = [
  // Chrome
  { key: '--color-bg-base',        label: 'Window background' },
  { key: '--color-bg-sidebar',     label: 'Activity bar' },
  { key: '--color-bg-surface',     label: 'Panels & cards' },
  { key: '--color-bg-hover',       label: 'Hover state' },
  { key: '--color-title-bar',      label: 'Title bar' },
  { key: '--color-sidebar-header', label: 'Sidebar header' },
  // Reader & editor
  { key: '--color-bg-reader',      label: 'Reader background' },
  { key: '--color-bg-editor',      label: 'Editor theme' },
  // Text & icons
  { key: '--color-fg-primary',     label: 'Primary text' },
  { key: '--color-fg-secondary',   label: 'Secondary text' },
  { key: '--color-fg-icon',        label: 'Inactive icons' },
  // Accent
  { key: '--color-accent',         label: 'Accent / active' },
  { key: '--color-accent-subtle',  label: 'Accent tint' },
  // Borders
  { key: '--color-border',         label: 'Borders' },
  { key: '--color-tree-indent',    label: 'Tree indent line' },
  // Highlight swatches
  { key: '--color-hl-amber',       label: 'Highlight 1' },
  { key: '--color-hl-green',       label: 'Highlight 2' },
  { key: '--color-hl-blue',        label: 'Highlight 3' },
  { key: '--color-hl-pink',        label: 'Highlight 4' },
  // Review grade swatches
  { key: '--color-review-again',   label: 'Review · Again' },
  { key: '--color-review-good',    label: 'Review · Good' },
  { key: '--color-review-easy',    label: 'Review · Easy' },
  // Graph node & link colors
  { key: '--color-graph-document',  label: 'Graph · Document' },
  { key: '--color-graph-folder',    label: 'Graph · Folder' },
  { key: '--color-graph-flashcard', label: 'Graph · Flashcard' },
  { key: '--color-graph-tag',       label: 'Graph · Tag' },
  { key: '--color-graph-disconnect',label: 'Graph · Disconnect' },
  { key: '--color-graph-inherit',   label: 'Graph · Inherit' },
  // Semantic UI colors
  { key: '--color-danger',          label: 'Danger / error' },
  { key: '--color-danger-bg',       label: 'Danger background', type: 'text' },
  // Elevation
  { key: '--shadow-float',          label: 'Float shadow',      type: 'text' },
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

// Converts any CSS color string to #rrggbb for use with <input type="color">
function toHex(color) {
  if (!color) return '#000000';
  // Already a plain 6-digit hex
  if (/^#[0-9a-fA-F]{6}$/.test(color)) return color.toLowerCase();
  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
  } catch {
    return '#000000';
  }
}

export function resolvedThemeColors() {
  const style = getComputedStyle(document.documentElement);
  return Object.fromEntries(
    THEME_VARS.map(({ key, type }) => {
      const raw = style.getPropertyValue(key).trim();
      if (key === '--color-bg-editor') return [key, raw || 'dark'];
      if (type === 'text') return [key, raw || ''];
      return [key, toHex(raw)];
    })
  );
}
