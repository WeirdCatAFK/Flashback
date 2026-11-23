import { useCallback, useEffect, useRef } from 'react';
import { findScroller } from './scroller';

export function useScrollProgress({
  elementRef, path, length, ready, initialProgress, onProgress, progressRef,
}) {
  const resumedRef = useRef(false);
  const lastPctRef = useRef(null);

  useEffect(() => { resumedRef.current = false; }, [path]);

  const scroller = useCallback(() => findScroller(elementRef?.current), [elementRef]);

  useEffect(() => {
    if (resumedRef.current || !ready || initialProgress === undefined) return;
    const pct = initialProgress?.percent;
    if (pct == null || pct <= 0) { resumedRef.current = true; return; }

    const id = requestAnimationFrame(() => {
      const el = scroller();
      if (!el) return;
      resumedRef.current = true;
      el.scrollTop = pct * (el.scrollHeight - el.clientHeight);
    });
    return () => cancelAnimationFrame(id);
  }, [ready, initialProgress, scroller]);

  useEffect(() => {
    if (!ready || !onProgress) return;
    const el = scroller();
    if (!el) return;

    const report = () => {
      const span = el.scrollHeight - el.clientHeight;
      if (span <= 0) return;
      const pct = Math.min(1, Math.max(0, el.scrollTop / span));
      if (lastPctRef.current != null && Math.abs(pct - lastPctRef.current) < 0.01) return;
      lastPctRef.current = pct;
      onProgress(path, {
        unit: 'chars',
        position: { offset: length ? Math.round(pct * length) : 0 },
        percent: pct,
        total: length || null,
      });
    };

    el.addEventListener('scroll', report, { passive: true });
    return () => el.removeEventListener('scroll', report);
  }, [ready, path, length, onProgress, scroller]);

  useEffect(() => {
    if (!progressRef) return;
    progressRef.current = {
      goToStart: () => { const el = scroller(); if (el) el.scrollTop = 0; },
      currentPosition: () => {
        const el = scroller();
        if (!el) return null;
        const span = el.scrollHeight - el.clientHeight;
        const pct = span > 0 ? Math.min(1, Math.max(0, el.scrollTop / span)) : 0;
        return {
          unit: 'chars',
          position: { offset: length ? Math.round(pct * length) : 0 },
          percent: pct,
          total: length || null,
        };
      },
    };
    return () => { if (progressRef) progressRef.current = null; };
  }, [progressRef, length, scroller]);
}
