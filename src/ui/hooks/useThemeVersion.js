/**
 * A counter that bumps whenever `data-theme` changes on <html>, for code that
 * reads colours out of CSS custom properties — a dependency React cannot see.
 */

import { useState, useEffect } from 'react';

export default function useThemeVersion() {
  const [v, setV] = useState(0);
  useEffect(() => {
    const mo = new MutationObserver(() => setV((n) => n + 1));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []);
  return v;
}
