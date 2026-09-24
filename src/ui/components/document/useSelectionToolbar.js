/**
 * What the floating toolbar sits on: a text selection, captured on mouse-up (or
 * handed over by an iframe renderer), or a highlight that was clicked (`picked`,
 * `{ id, rect }`) — found in the DOM for inline marks and PDF boxes, or handed
 * over through `pick` by a renderer that draws in a frame (EPUB). Positioned in
 * shell-layout space; dismissed by a new selection, a scroll, typing, a zoom
 * change or the view going inactive.
 */

import { useState, useEffect, useCallback } from "react";
import { toLayoutRect, useUiZoomChange } from "../../utils/uiZoom";

/**
 * The highlight a click landed on: an inline mark (Markdown, text, clips), or — for
 * PDF, whose boxes ignore the pointer so text under them stays selectable — a box
 * on the clicked page whose rectangle holds the point. Marks inside the card
 * margin are cards, not passages.
 */
function highlightAt(e) {
  const target = e.target;
  if (!target?.closest || target.closest(".doc-margin")) return null;
  const mark = target.closest("mark[data-hl]");
  if (mark) return mark;
  const page = target.closest("[data-page]");
  if (!page) return null;
  const { clientX: x, clientY: y } = e;
  return [...page.querySelectorAll("[data-hl]")].find((el) => {
    const r = el.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }) ?? null;
}

export default function useSelectionToolbar({ isActive, rendererRef }) {
  const [selection, setSelection] = useState(null);
  const [rect, setRect] = useState(null);
  const [picked, setPicked] = useState(null);

  const clear = useCallback(() => {
    setSelection(null);
    setRect(null);
    setPicked(null);
  }, []);

  const pick = useCallback((hit) => {
    setSelection(null);
    setRect(null);
    setPicked(hit?.id && hit.rect ? hit : null);
  }, []);

  const [prevIsActive, setPrevIsActive] = useState(isActive);
  if (prevIsActive !== isActive) {
    setPrevIsActive(isActive);
    if (!isActive) {
      setSelection(null);
      setRect(null);
      setPicked(null);
    }
  }

  const onMouseUp = useCallback((e) => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) {
      const el = e && e.button === 0 ? highlightAt(e) : null;
      if (el) pick({ id: el.getAttribute("data-hl"), rect: toLayoutRect(el.getBoundingClientRect()) });
      else clear();
      return;
    }
    setPicked(null);
    const range = sel.getRangeAt(0);
    setSelection({
      text: sel.toString().trim(),
      startOffset: range.startOffset,
      endOffset: range.endOffset,
    });
    setRect(toLayoutRect(range.getBoundingClientRect()));
  }, [clear, pick]);

  const onExternalSelection = useCallback(
    (payload) => {
      if (!payload || !payload.text || !payload.rect) {
        setSelection(null);
        setRect(null);
        return;
      }
      setPicked(null);
      setSelection({ text: payload.text, startOffset: 0, endOffset: 0 });
      setRect(payload.rect);
    },
    [],
  );

  useEffect(() => {
    const onChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) {
        setSelection(null);
        setRect(null);
      }
    };
    document.addEventListener("selectionchange", onChange);
    return () => document.removeEventListener("selectionchange", onChange);
  }, []);

  useEffect(() => {
    if (!picked) return undefined;
    const onKey = (e) => { if (!e.ctrlKey && !e.metaKey && !e.altKey) setPicked(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [picked]);

  useEffect(() => {
    if (!rect && !picked) return undefined;
    const el = rendererRef.current;
    el?.addEventListener("scroll", clear, true);
    window.addEventListener("scroll", clear, true);
    return () => {
      el?.removeEventListener("scroll", clear, true);
      window.removeEventListener("scroll", clear, true);
    };
  }, [rect, picked, clear, rendererRef]);

  useUiZoomChange(clear);

  return { selection, rect, picked, pick, clear, onMouseUp, onExternalSelection };
}
