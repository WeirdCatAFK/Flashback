import { useState, useEffect } from 'react';

export default function useContainerSize(ref, initial = { width: 800, height: 600 }) {
  const [size, setSize] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ width, height });
    });
    ro.observe(el);
    const rect = el.getBoundingClientRect();
    setSize({ width: rect.width, height: rect.height });
    return () => ro.disconnect();
  }, [ref]);
  return size;
}
