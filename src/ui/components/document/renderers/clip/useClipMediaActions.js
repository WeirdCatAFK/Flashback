/**
 * The hover-to-save affordance over a clip's pictures and sounds: which asset
 * the pointer is on, with a short grace period so the button can be reached,
 * dismissed by scrolling or a zoom change. Tiny images are skipped.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useUiZoomChange } from '../../../../utils/uiZoom';
import { mediaHitFor } from './media.js';

const HIDE_DELAY = 140;
const MIN_IMAGE = 48;

export default function useClipMediaActions(bodyRef, ready) {
  const [mediaHit, setMediaHit] = useState(null);
  const hideTimerRef = useRef(null);

  const cancelHide = useCallback(() => {
    clearTimeout(hideTimerRef.current);
    hideTimerRef.current = null;
  }, []);
  const hideSoon = useCallback(() => {
    cancelHide();
    hideTimerRef.current = setTimeout(() => setMediaHit(null), HIDE_DELAY);
  }, [cancelHide]);
  const dismiss = useCallback(() => { cancelHide(); setMediaHit(null); }, [cancelHide]);

  useEffect(() => {
    const root = bodyRef.current;
    if (!root || !ready) return undefined;
    const onOver = (e) => {
      const el = e.target?.closest?.('img, audio, a[data-href]');
      if (!el || !root.contains(el)) return;
      const hit = mediaHitFor(el);
      if (!hit) return;
      if (hit.kind !== 'audio' && (hit.rect.width < MIN_IMAGE || hit.rect.height < MIN_IMAGE)) return;
      cancelHide();
      setMediaHit(hit);
    };
    const onOut = (e) => { if (e.target?.closest?.('img, audio, a[data-href]')) hideSoon(); };
    root.addEventListener('mouseover', onOver);
    root.addEventListener('mouseout', onOut);
    window.addEventListener('scroll', dismiss, true);
    return () => {
      cancelHide();
      root.removeEventListener('mouseover', onOver);
      root.removeEventListener('mouseout', onOut);
      window.removeEventListener('scroll', dismiss, true);
    };
  }, [bodyRef, ready, cancelHide, hideSoon, dismiss]);

  useUiZoomChange(dismiss);

  return { mediaHit, cancelHide, hideSoon, dismiss };
}
