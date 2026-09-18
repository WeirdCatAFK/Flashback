/**
 * useState that survives a reload, backed by localStorage. `sanitize` runs over
 * the stored value only: a bad or hand-edited entry falls back to the default
 * rather than wedging the view.
 */

import { useState, useEffect } from 'react';

export default function usePersisted(key, initial, sanitize) {
  const [value, setValue] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw == null) return initial;
      const parsed = JSON.parse(raw);
      if (typeof parsed !== typeof initial) return initial;
      return sanitize ? sanitize(parsed) : parsed;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { }
  }, [key, value]);
  return [value, setValue];
}
