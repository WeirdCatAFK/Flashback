import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { LOCALES, LOCALE_OPTIONS, TranslationContext, useT } from './index.js';
import { makeFormatters } from './format.js';
import { makeTranslators } from './translate.js';

function readStoredLocale() {
  const saved = localStorage.getItem('fb-locale');
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

export function Rich({ text, values }) {
  return text.split(/(\{\w+\})/g).map((part, i) => {
    const name = /^\{(\w+)\}$/.exec(part)?.[1];
    const hit = name && Object.prototype.hasOwnProperty.call(values ?? {}, name);
    return <Fragment key={i}>{hit ? values[name] : part}</Fragment>;
  });
}

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
