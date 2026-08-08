/**
 * Pure translation lookup — no React, no DOM, no imports.
 *
 *   const { t, tp } = makeTranslators(dict, 'es');
 *
 * Split out of the provider on purpose, the same way sequencing.js is split from
 * sequencer.js: the interesting behaviour here is the fallback ladder, and it should
 * be testable without mounting a component tree. The provider does nothing but bind
 * these to the active locale.
 *
 * `dict` is a parsed pack, or null for English (which has no pack — the source text
 * is the key and therefore its own fallback).
 */

/** 'Level|noun' → 'Level'. Applied only when falling back to the key itself. */
export function stripContext(key) {
  const bar = key.indexOf('|');
  return bar === -1 ? key : key.slice(0, bar);
}

/**
 * Replace {name} placeholders. An unmatched placeholder is left visible rather than
 * blanked — a literal "{count}" on screen is a bug report; an empty space is a
 * mystery.
 */
export function interpolate(str, vars) {
  if (!vars) return str;
  return str.replace(/\{(\w+)\}/g, (whole, name) => (
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole
  ));
}

export function makeTranslators(dict, locale) {
  const plurals = new Intl.PluralRules(locale);

  /** t(key, vars) — plain lookup with interpolation. */
  const t = (key, vars) => {
    const hit = dict?.[key];
    if (typeof hit === 'string') return interpolate(hit, vars);
    // A pack may hold a plural object under a key the source reads with t().
    // Prefer 'other' over rendering nothing.
    if (hit && typeof hit === 'object' && typeof hit.other === 'string') {
      return interpolate(hit.other, vars);
    }
    return interpolate(stripContext(key), vars);
  };

  /**
   * tp(one, other, n, vars) — the plural form is the key. Both English forms are
   * passed so English stays grammatical with zero translations loaded, which is why
   * there is no en.json to keep in sync.
   */
  const tp = (one, other, n, vars) => {
    const all = { n, ...vars };
    const hit = dict?.[other];

    if (hit && typeof hit === 'object') {
      // Intl gives the category this language actually needs for n — 'one'/'other'
      // for Spanish, 'one'/'few'/'many'/'other' for Polish, and so on.
      const form = hit[plurals.select(n)] ?? hit.other;
      if (typeof form === 'string') return interpolate(form, all);
    }
    // A translator may legitimately collapse every form into one string.
    if (typeof hit === 'string') return interpolate(hit, all);

    return interpolate(stripContext(n === 1 ? one : other), all);
  };

  return { t, tp };
}
