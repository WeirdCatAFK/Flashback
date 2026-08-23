/**
 * Translations — interface text with the English source string as the key.
 *
 *   const { t, tp } = useT();
 *
 *   t('No subfolders')                            // plain
 *   t('Delete "{name}"?', { name: deck.name })    // interpolation
 *   tp('Import {n} card', 'Import {n} cards', n)  // plural — key is the plural form
 *
 * There is no en.json: English lives in the source and is its own fallback, so a
 * half-finished pack still renders a usable app. A key may carry a `|context`
 * suffix to split a homograph ( t('Level|noun') ); the suffix is stripped when
 * falling back to English and is never shown to the user.
 *
 * Mount <TranslationProvider> at the render root; useT() works anywhere below. Switching
 * language is a setState — every consumer re-renders, no reload.
 *
 * This module holds the non-component half — the context, the hook and the pack registry —
 * and `components.jsx` beside it holds <TranslationProvider>, <Rich> and <LanguagePicker>.
 * The split is eslint-plugin-react-refresh's rule, and it fell this way round on purpose:
 * `useT` has ~50 import sites and the components have five, so moving the components is the
 * change nothing else has to notice. Importers still write `from '.../translations'` — the
 * directory resolves to this file either way.
 *
 * IMPORTANT: never call t() at module scope. A string baked into a module-level
 * constant is evaluated once at import time and will not re-render on a language
 * switch. Keep the English literal in the constant and translate where it renders.
 */

import { createContext, useContext } from 'react';

/**
 * Vite statically bundles every JSON under languages/ at build time. Dropping a new
 * pack into that folder is the whole "add a language" story: it gets bundled and
 * appears in the picker with no loader, no registration and no filesystem access.
 */
const PACKS = import.meta.glob('./languages/*.json', { eager: true, import: 'default' });

const EN = { code: 'en', name: 'English', dict: null };

/** code → { code, name, dict }. English first, then packs alphabetically by name. */
export const LOCALES = (() => {
  const packs = [];
  for (const [path, dict] of Object.entries(PACKS)) {
    const code = dict?._meta?.code;
    if (!code) {
      console.warn(`[translations] ${path} has no _meta.code — ignoring it.`);
      continue;
    }
    packs.push({ code, name: dict._meta.name ?? code, dict });
  }
  packs.sort((a, b) => a.name.localeCompare(b.name));

  const out = { en: EN };
  for (const p of packs) out[p.code] = p;
  return out;
})();

/** Shape the language pickers iterate over. */
export const LOCALE_OPTIONS = Object.values(LOCALES).map(({ code, name }) => ({ code, name }));

export const TranslationContext = createContext(null);

export function useT() {
  const ctx = useContext(TranslationContext);
  if (!ctx) throw new Error('useT must be used within <TranslationProvider>');
  return ctx;
}
