import { useState, useRef, useEffect, useCallback } from 'react';

export default function useGraphAnimation() {
  const rafRef = useRef(null);
  const untilRef = useRef(0);
  const [animating, setAnimating] = useState(false);

  const nudge = useCallback((durationMs = 900) => {
    untilRef.current = Math.max(untilRef.current, performance.now() + durationMs);
    setAnimating(true);
    if (rafRef.current != null) return;
    const step = () => {
      if (performance.now() < untilRef.current) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        rafRef.current = null;
        setAnimating(false);
      }
    };
    rafRef.current = requestAnimationFrame(step);
  }, []);

  useEffect(() => () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current); }, []);

  return { animating, nudge };
}
