/**
 * The text selection the floating toolbar sits on: captured on mouse-up (or
 * handed over by an iframe renderer), positioned in shell-layout space, and
 * dismissed by a collapse, a scroll, a zoom change or the view going inactive.
 */

import { useState, useEffect, useCallback } from "react";
import { toLayoutRect, useUiZoomChange } from "../../utils/uiZoom";

export default function useSelectionToolbar({ isActive, rendererRef }) {
  const [selection, setSelection] = useState(null);
  const [rect, setRect] = useState(null);

  const clear = useCallback(() => {
    setSelection(null);
    setRect(null);
  }, []);

  const [prevIsActive, setPrevIsActive] = useState(isActive);
  if (prevIsActive !== isActive) {
    setPrevIsActive(isActive);
    if (!isActive) {
      setSelection(null);
      setRect(null);
    }
  }

  const onMouseUp = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) {
      clear();
      return;
    }
    const range = sel.getRangeAt(0);
    setSelection({
      text: sel.toString().trim(),
      startOffset: range.startOffset,
      endOffset: range.endOffset,
    });
    setRect(toLayoutRect(range.getBoundingClientRect()));
  }, [clear]);

  const onExternalSelection = useCallback(
    (payload) => {
      if (!payload || !payload.text || !payload.rect) {
        clear();
        return;
      }
      setSelection({ text: payload.text, startOffset: 0, endOffset: 0 });
      setRect(payload.rect);
    },
    [clear],
  );

  useEffect(() => {
    const onChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) clear();
    };
    document.addEventListener("selectionchange", onChange);
    return () => document.removeEventListener("selectionchange", onChange);
  }, [clear]);

  useEffect(() => {
    if (!rect) return undefined;
    const el = rendererRef.current;
    el?.addEventListener("scroll", clear, true);
    window.addEventListener("scroll", clear, true);
    return () => {
      el?.removeEventListener("scroll", clear, true);
      window.removeEventListener("scroll", clear, true);
    };
  }, [rect, clear, rendererRef]);

  useUiZoomChange(clear);

  return { selection, rect, clear, onMouseUp, onExternalSelection };
}
