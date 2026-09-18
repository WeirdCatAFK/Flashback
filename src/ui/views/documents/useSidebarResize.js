/**
 * The draggable (and keyboard-resizable) sidebar width, remembered globally in
 * `fb-sidebar-width` — a cosmetic preference that belongs to the person, not
 * the vault.
 */

import { useState, useEffect, useRef, useCallback } from 'react';

export const MIN_WIDTH = 150;
export const MAX_WIDTH = 500;
const DEFAULT_WIDTH = 240;
const KEY = 'fb-sidebar-width';
const STEP = 16;

const clamp = (w) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w));

export default function useSidebarResize() {
  const [width, setWidth] = useState(() => parseInt(localStorage.getItem(KEY) ?? DEFAULT_WIDTH, 10));
  const dragging = useRef(false);
  const startX = useRef(0);
  const startW = useRef(0);

  const onMouseDown = useCallback((e) => {
    dragging.current = true;
    startX.current = e.clientX;
    startW.current = width;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [width]);

  const onKeyDown = useCallback((e) => {
    let next = null;
    if (e.key === 'ArrowLeft') next = width - STEP;
    else if (e.key === 'ArrowRight') next = width + STEP;
    else if (e.key === 'Home') next = MIN_WIDTH;
    else if (e.key === 'End') next = MAX_WIDTH;
    if (next == null) return;
    e.preventDefault();
    next = clamp(next);
    setWidth(next);
    localStorage.setItem(KEY, next);
  }, [width]);

  useEffect(() => {
    const onMouseMove = (e) => {
      if (!dragging.current) return;
      setWidth(clamp(startW.current + (e.clientX - startX.current)));
    };
    const onMouseUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setWidth((w) => { localStorage.setItem(KEY, w); return w; });
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  return { width, handleProps: { onMouseDown, onKeyDown, 'aria-valuenow': width, 'aria-valuemin': MIN_WIDTH, 'aria-valuemax': MAX_WIDTH } };
}
