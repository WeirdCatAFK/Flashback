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
 * IMPORTANT: never call t() at module scope. A string baked into a module-level
 * constant is evaluated once at import time and will not re-render on a language
 * switch. Keep the English literal in the constant and translate where it renders.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { makeFormatters } from './format.js';
import { makeTranslators } from './translate.js';

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

const TranslationContext = createContext(null);

export function useT() {
  const ctx = useContext(TranslationContext);
  if (!ctx) throw new Error('useT must be used within <TranslationProvider>');
  return ctx;
}

function readStoredLocale() {
  const saved = localStorage.getItem('fb-locale');
  // A pack can disappear between sessions (removed from the build). Fall back to
  // English rather than rendering raw keys against a dictionary that isn't there.
  return saved && LOCALES[saved] ? saved : 'en';
}

export function TranslationProvider({ children }) {
  const [locale, setLocale] = useState(readStoredLocale);

  useEffect(() => {
    localStorage.setItem('fb-locale', locale);
    document.documentElement.setAttribute('lang', locale);
  }, [locale]);

  const value = useMemo(() => ({
    ...makeTranslators(LOCALES[locale]?.dict ?? null, locale),
    ...makeFormatters(locale),
    locale,
    setLocale,
  }), [locale]);

  return <TranslationContext.Provider value={value}>{children}</TranslationContext.Provider>;
}

/**
 * Language picker. Rendered in Config beside the theme selector and on the first
 * Setup step, which is where a non-English user needs it most.
 */
export function LanguagePicker({ id, className }) {
  const { locale, setLocale } = useT();
  const onChange = useCallback((e) => setLocale(e.target.value), [setLocale]);

  return (
    <select id={id} className={className} value={locale} onChange={onChange}>
      {LOCALE_OPTIONS.map(({ code, name }) => (
        <option key={code} value={code}>{name}</option>
      ))}
    </select>
  );
}
