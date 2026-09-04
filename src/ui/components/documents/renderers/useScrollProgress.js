import { useCallback, useEffect, useRef } from 'react';

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
 * The scroll container is found by walking up from the element, because each of the three
 * renderers puts the scrollbar somewhere different (TipTap's wrapper, CodeMirror's own
 * scroller, a plain div) and none of them exposes it.
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

  const scroller = useCallback(() => {
    let el = elementRef?.current;
    while (el && el !== document.body) {
      const style = window.getComputedStyle(el);
      const scrolls = /(auto|scroll)/.test(style.overflowY);
      if (scrolls && el.scrollHeight > el.clientHeight + 1) return el;
      el = el.parentElement;
    }
    return null;
  }, [elementRef]);

  // Resume once both the body and the saved position are available; either can arrive first.
  useEffect(() => {
    if (resumedRef.current || !ready || initialProgress === undefined) return;
    const pct = initialProgress?.percent;
    if (pct == null || pct <= 0) { resumedRef.current = true; return; }

    // One frame, so the body has been laid out and scrollHeight is real.
    const id = requestAnimationFrame(() => {
      const el = scroller();
      if (!el) return;                       // nothing scrollable yet; try again next paint
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
      if (span <= 0) return;                 // nothing to scroll: not a reading position
      const pct = Math.min(1, Math.max(0, el.scrollTop / span));
      // A pixel of drift is not a new position; without this every wheel tick queues a write.
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
