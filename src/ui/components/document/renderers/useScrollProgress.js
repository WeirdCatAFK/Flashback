/**
 * Reading position for a scrolling renderer: the scroll fraction reported as
 * progress, and the saved position restored once the content is ready.
 */

import { useCallback, useEffect, useRef } from 'react';
import { findScroller } from './scroller';

/**
 * Reading position for the formats whose renderers have no native unit — Markdown, plain
 * text, and saved clips.
 *
 * These are all `chars` documents to `/api/reader`, but no renderer here keeps a character
 * offset (Markdown keeps no offset state at all), so the position is measured as a
 * **scroll fraction** and the offset is derived from it. That approximation is deliberate
 * and documented: it is a sound bound for "do not read past where I am", not a precise
 * cursor. PDF pages and EPUB CFIs are exact; these are not, and pretending otherwise would
 * be the worse error.
 *
 * The scroll container is found by walking up from the element (`findScroller`), because
 * each of the three renderers puts the scrollbar somewhere different and none of them
 * exposes it.
 *
 * @param {object} opts
 * @param {React.RefObject} opts.elementRef - anything inside the scrolling region.
 * @param {string} opts.path
 * @param {number} opts.length - the body's character count, the denominator.
 * @param {boolean} opts.ready - whether the body is on screen and measurable.
 * @param {object|null|undefined} opts.initialProgress - undefined while still loading.
 * @param {Function} [opts.onProgress]
 * @param {React.RefObject} [opts.progressRef]
 */
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
