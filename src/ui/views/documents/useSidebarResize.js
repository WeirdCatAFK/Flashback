/**
 * The file tree's width: dragged (snapping to set widths, so a rough drag lands
 * somewhere sensible — free resizing felt too precise), stepped with the arrow
 * keys, reset with a double-click, and remembered globally in `fb-sidebar-width`
 * — a cosmetic preference that belongs to the person, not the vault.
 */

import { useState, useRef, useCallback } from 'react';
import { MIN_WIDTH, MAX_WIDTH, DEFAULT_WIDTH, snapWidth, stepWidth, storedWidth } from './treeLayout.js';

const KEY = 'fb-sidebar-width';

const read = () => {
  try { return storedWidth(localStorage.getItem(KEY)); } catch { return DEFAULT_WIDTH; }
};
const write = (w) => {
  try { localStorage.setItem(KEY, String(w)); } catch { }
};

export default function useSidebarResize() {
  const [width, setWidth] = useState(read);
  const [resizing, setResizing] = useState(false);
  const start = useRef(null);

  const commit = useCallback((w) => { setWidth(w); write(w); }, []);

  const onPointerDown = useCallback((e) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { x: e.clientX, w: width };
    setResizing(true);
  }, [width]);

  const onPointerMove = useCallback((e) => {
    if (!start.current) return;
    setWidth(snapWidth(start.current.w + e.clientX - start.current.x));
  }, []);

  const onPointerUp = useCallback(() => {
    if (!start.current) return;
    start.current = null;
    setResizing(false);
    setWidth((w) => { write(w); return w; });
  }, []);

  const onKeyDown = useCallback((e) => {
    let next = null;
    if (e.key === 'ArrowLeft') next = stepWidth(width, -1);
    else if (e.key === 'ArrowRight') next = stepWidth(width, 1);
    else if (e.key === 'Home') next = MIN_WIDTH;
    else if (e.key === 'End') next = MAX_WIDTH;
    if (next == null) return;
    e.preventDefault();
    commit(next);
  }, [width, commit]);

  return {
    width,
    resizing,
    handleProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
      onKeyDown,
      onDoubleClick: () => commit(DEFAULT_WIDTH),
      'aria-valuenow': width,
      'aria-valuemin': MIN_WIDTH,
      'aria-valuemax': MAX_WIDTH,
    },
  };
}
