import { createContext, useContext } from 'react';

const PACKS = import.meta.glob('./languages/*.json', { eager: true, import: 'default' });

const EN = { code: 'en', name: 'English', dict: null };

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

export const LOCALE_OPTIONS = Object.values(LOCALES).map(({ code, name }) => ({ code, name }));

export const TranslationContext = createContext(null);

export function useT() {
  const ctx = useContext(TranslationContext);
  if (!ctx) throw new Error('useT must be used within <TranslationProvider>');
  return ctx;
}
