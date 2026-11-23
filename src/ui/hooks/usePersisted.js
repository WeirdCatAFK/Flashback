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
