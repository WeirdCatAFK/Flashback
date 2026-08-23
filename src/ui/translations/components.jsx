/**
 * The React surface of the translations module: the provider that fills the context, and
 * the two components that render translated text which `t()` alone cannot produce.
 *
 * Separate from `index.js` so that file exports no component and Fast Refresh keeps working
 * for the ~50 modules that import `useT` from it. Nothing else distinguishes the two —
 * conceptually this is one module.
 */

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { LOCALES, LOCALE_OPTIONS, TranslationContext, useT } from './index.js';
import { makeFormatters } from './format.js';
import { makeTranslators } from './translate.js';

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
 * Render a translated sentence whose {placeholders} stand for React nodes rather
 * than plain values — a <code> path, a <strong> emphasis, a link.
 *
 *   <Rich text={t('Save this as {file}, then run {cmd}.')}
 *         values={{ file: <code>.mcp.json</code>, cmd: <code>/mcp</code> }} />
 *
 * The point is that the sentence stays one key. Splitting a string around its
 * markup — 'Save this as' + <code/> + ', then run' — hands the translator
 * fragments and hard-codes English word order, which is exactly what a language
 * with different ordering cannot work with. Interpolation that t() can do
 * itself should still go through t(); this is only for nodes.
 */
export function Rich({ text, values }) {
  return text.split(/(\{\w+\})/g).map((part, i) => {
    const name = /^\{(\w+)\}$/.exec(part)?.[1];
    const hit = name && Object.prototype.hasOwnProperty.call(values ?? {}, name);
    // An unmatched placeholder is left visible, same as interpolate() — a
    // literal "{file}" on screen is a bug report; a blank is a mystery.
    return <Fragment key={i}>{hit ? values[name] : part}</Fragment>;
  });
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
