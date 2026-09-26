/**
 * The hidden file tree's approach: resting the pointer in the empty space left of
 * the text slides the tree out, and leaving it slides it back. A strip beside the
 * text stays inert (see treeLayout.js) so a selection started at a line's edge never
 * opens it, and a pointer held down (a drag, a selection) never does. The tab bar
 * and the reading strip are outside the zone — the tree toggle lives in the first.
 */

import { useEffect, useRef, useState } from 'react';
import { peekZoneWidth } from './treeLayout.js';

const OPEN_DELAY = 180;
const CLOSE_DELAY = 260;
const AFTER_OPEN_DELAY = 120;

/**
 * Whether `target` is inside `el`. A pointer can leave toward an element in the EPUB's
 * section iframe, which belongs to another document — `contains` throws on it, and it
 * is never inside the tree anyway.
 */
function within(el, target) {
  try {
    return !!el && !!target && el.contains(target);
  } catch {
    return false;
  }
}

export default function useTreePeek({ hidden, treeRef }) {
  const [peek, setPeek] = useState(false);
  const [hint, setHint] = useState(false);
  const timer = useRef(0);

  const cancel = () => { clearTimeout(timer.current); timer.current = 0; };
  const later = (on, ms) => {
    cancel();
    timer.current = setTimeout(() => { timer.current = 0; setPeek(on); setHint(false); }, ms);
  };

  useEffect(() => () => clearTimeout(timer.current), []);

  const [wasHidden, setWasHidden] = useState(hidden);
  if (wasHidden !== hidden) {
    setWasHidden(hidden);
    setPeek(false);
    setHint(false);
  }

  const bodyProps = {
    onPointerMove: (e) => {
      if (!hidden || peek || e.buttons) return;
      if (e.target.closest('.tab-bar, .doc-reading-bar, .finder')) { setHint(false); cancel(); return; }
      const body = e.currentTarget.getBoundingClientRect();
      const text = e.currentTarget.querySelector('[data-measure]')?.getBoundingClientRect();
      const inside = e.clientX - body.left <= peekZoneWidth(body.left, text ? text.left : null);
      setHint(inside);
      if (inside) { if (!timer.current) later(true, OPEN_DELAY); } else cancel();
    },
    onPointerLeave: (e) => {
      setHint(false);
      if (!within(treeRef.current, e.relatedTarget)) cancel();
    },
  };

  const treeProps = {
    onPointerEnter: cancel,
    onPointerLeave: () => { if (peek) later(false, CLOSE_DELAY); },
  };

  /** A document chosen from the slid-out tree puts it away again. */
  const afterOpen = () => { if (hidden) later(false, AFTER_OPEN_DELAY); };

  return { peek, hint, bodyProps, treeProps, afterOpen };
}
