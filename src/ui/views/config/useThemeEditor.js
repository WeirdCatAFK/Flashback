/**
 * The custom-theme editor's state: the draft (name, colours, which saved theme
 * it edits) persisted to localStorage so it survives leaving the tab, live
 * preview through an injected `[data-theme="__fb_preview__"]` rule, import /
 * export as JSON, and save / delete through customThemes.js.
 */

import { useState } from 'react';
import { THEMES } from '../../themes';
import { useT } from '../../translations/index';
import { THEME_VARS, saveCustomTheme, deleteCustomTheme, loadCustomThemes, resolvedThemeColors, themeRule } from '../../customThemes';
import { DARK_DEFAULTS, PREVIEW_THEME } from './themeDefaults.js';

const KEYS = { name: 'fb-editor-name', colors: 'fb-editor-colors:v1', editing: 'fb-editor-editing' };
const PREVIEW_STYLE_ID = 'fb-preview-style';

/** The preview rule for `colors`, as CSS text: a saved theme's rule under the preview's name. */
export const previewRule = (colors) => themeRule(PREVIEW_THEME, colors);

/** Validate an imported theme JSON; returns the theme or throws with a translated reason. */
export function parseThemeImport(text, t) {
  const parsed = JSON.parse(text);
  if (typeof parsed.name !== 'string' || !parsed.name.trim()) throw new Error(t('Missing or invalid "name" field.'));
  if (typeof parsed.colors !== 'object' || parsed.colors === null) throw new Error(t('Missing or invalid "colors" field.'));
  const missing = THEME_VARS.filter(({ key }) => !(key in parsed.colors));
  if (missing.length > THEME_VARS.length / 2) throw new Error(t('Missing variables: {list}', { list: missing.map((v) => v.key).join(', ') }));
  return { name: parsed.name.trim(), colors: parsed.colors };
}

export default function useThemeEditor({ onSaved, onThemeChange, currentTheme }) {
  const { t } = useT();
  const [name, setName] = useState(() => localStorage.getItem(KEYS.name) ?? '');
  const [colors, setColors] = useState(() => {
    try { return JSON.parse(localStorage.getItem(KEYS.colors)) ?? DARK_DEFAULTS; } catch { return DARK_DEFAULTS; }
  });
  const [editing, setEditing] = useState(() => localStorage.getItem(KEYS.editing) ?? null);
  const [importText, setImportText] = useState('');
  const [importError, setImportError] = useState(null);
  const [previewing, setPreviewing] = useState(() => !!document.getElementById(PREVIEW_STYLE_ID));

  const persistName = (v) => { localStorage.setItem(KEYS.name, v); setName(v); };
  const persistColors = (v) => { localStorage.setItem(KEYS.colors, JSON.stringify(v)); setColors(v); };
  const persistEditing = (v) => {
    if (v) localStorage.setItem(KEYS.editing, v); else localStorage.removeItem(KEYS.editing);
    setEditing(v);
  };

  const applyPreview = (nextColors) => {
    let el = document.getElementById(PREVIEW_STYLE_ID);
    if (!el) {
      el = document.createElement('style');
      el.id = PREVIEW_STYLE_ID;
      document.head.appendChild(el);
    }
    el.textContent = previewRule(nextColors);
    onThemeChange(PREVIEW_THEME);
  };

  const stopPreview = () => {
    document.getElementById(PREVIEW_STYLE_ID)?.remove();
    onThemeChange(currentTheme === PREVIEW_THEME ? 'light-workbench' : currentTheme);
    setPreviewing(false);
  };

  const togglePreview = () => {
    if (previewing) { stopPreview(); return; }
    applyPreview(colors);
    setPreviewing(true);
  };

  const setColor = (key, value) => {
    const next = { ...colors, [key]: value };
    persistColors(next);
    if (previewing) applyPreview(next);
  };

  /** Leaving the editor's page ends a preview, so the app is never left in an unsaved theme. */
  const leave = () => { if (previewing) stopPreview(); };

  const loadExisting = (themeName) => {
    const found = loadCustomThemes().find((entry) => entry.name === themeName);
    if (!found) return;
    persistName(found.name);
    persistColors(found.colors);
    persistEditing(found.name);
  };

  const exportText = JSON.stringify({ name: name.trim() || 'my-theme', colors }, null, 2);

  const importTheme = () => {
    setImportError(null);
    try {
      const theme = parseThemeImport(importText, t);
      persistName(theme.name);
      persistColors(theme.colors);
      if (previewing) applyPreview(theme.colors);
      persistEditing(null);
      setImportText('');
    } catch (err) {
      setImportError(err.message);
    }
  };

  const save = () => {
    const trimmed = name.trim();
    if (!trimmed || THEMES.includes(trimmed)) return;
    saveCustomTheme({ name: trimmed, colors });
    onSaved(trimmed);
    onThemeChange(trimmed);
    persistEditing(trimmed);
  };

  const remove = () => {
    if (!editing) return;
    deleteCustomTheme(editing);
    onSaved(null);
    persistName('');
    persistColors(DARK_DEFAULTS);
    persistEditing(null);
  };

  const isNameTaken = THEMES.includes(name.trim()) && name.trim() !== '';

  return {
    name, colors, editing, importText, importError, previewing, exportText, isNameTaken,
    canSave: !!name.trim() && !isNameTaken,
    setName: persistName, setColor, setImportText, leave, togglePreview, loadExisting, importTheme, save, remove,
    seedFromCurrent: () => persistColors(resolvedThemeColors()),
    copyExport: () => navigator.clipboard.writeText(exportText),
  };
}
