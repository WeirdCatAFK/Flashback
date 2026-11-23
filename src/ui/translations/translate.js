export function stripContext(key) {
  const bar = key.indexOf('|');
  return bar === -1 ? key : key.slice(0, bar);
}

export function interpolate(str, vars) {
  if (!vars) return str;
  return str.replace(/\{(\w+)\}/g, (whole, name) => (
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole
  ));
}

export function makeTranslators(dict, locale) {
  const plurals = new Intl.PluralRules(locale);

  const t = (key, vars) => {
    const hit = dict?.[key];
    if (typeof hit === 'string') return interpolate(hit, vars);
    if (hit && typeof hit === 'object' && typeof hit.other === 'string') {
      return interpolate(hit.other, vars);
    }
    return interpolate(stripContext(key), vars);
  };

  const tp = (one, other, n, vars) => {
    const all = { n, ...vars };
    const hit = dict?.[other];

    if (hit && typeof hit === 'object') {
      const form = hit[plurals.select(n)] ?? hit.other;
      if (typeof form === 'string') return interpolate(form, all);
    }
    if (typeof hit === 'string') return interpolate(hit, all);

    return interpolate(stripContext(n === 1 ? one : other), all);
  };

  return { t, tp };
}
