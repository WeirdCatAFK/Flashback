/**
 * Hover and selection over the graph: a hover that lingers becomes a selection,
 * leaving a hover-made selection clears it, a click toggles it outright.
 */

import { useState, useRef, useEffect, useCallback } from 'react';

const HOVER_SELECT_DELAY = 700;

export default function useGraphSelection() {
  const [selected, setSelected] = useState(null);
  const [hovered, setHovered] = useState(null);
  const timerRef = useRef(null);
  const byHoverRef = useRef(false);

  const cancelTimer = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  };

  useEffect(() => cancelTimer, []);

  const onHover = useCallback((node) => {
    setHovered(node ?? null);
    cancelTimer();
    if (node) {
      timerRef.current = setTimeout(() => {
        setSelected(node);
        byHoverRef.current = true;
        timerRef.current = null;
      }, HOVER_SELECT_DELAY);
    } else if (byHoverRef.current) {
      setSelected(null);
      byHoverRef.current = false;
    }
  }, []);

  const onClick = useCallback((node) => {
    cancelTimer();
    byHoverRef.current = false;
    setSelected((prev) => (prev?.id === node.id ? null : node));
  }, []);

  const clear = useCallback(() => {
    byHoverRef.current = false;
    setSelected(null);
  }, []);

  return { selected, hovered, onHover, onClick, clear };
}
