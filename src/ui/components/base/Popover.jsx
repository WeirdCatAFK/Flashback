/**
 * Popover — the one anchored, portaled overlay. Dropdown menus, pickers and
 * suggestion lists render their content inside it and stop owning position math
 * and dismissal. Portaled to document.body and positioned in shell-layout space
 * (see utils/uiZoom.js), so it scales with the app zoom like SelectionToolbar.
 *
 *   <Popover anchorRef={btnRef} open={open} onClose={close} align="end">…</Popover>
 */

import { useLayoutEffect, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  toLayoutRect,
  layoutViewport,
  useUiZoomChange,
} from "../../utils/uiZoom";

const GAP = 4;

export default function Popover({
  anchorRef,
  open,
  onClose,
  align = "start",
  matchWidth = false,
  className = "",
  role = "menu",
  ariaLabel,
  children,
}) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);

  useLayoutEffect(() => {
    if (!open || !anchorRef?.current || !ref.current) return;
    const anchor = toLayoutRect(anchorRef.current.getBoundingClientRect());
    const view = layoutViewport();
    const { offsetWidth: w, offsetHeight: h } = ref.current;
    const width = matchWidth ? anchor.width : w;
    let left = align === "end" ? anchor.right - width : anchor.left;
    left = Math.max(GAP, Math.min(left, view.width - width - GAP));
    let top = anchor.bottom + GAP;
    if (top + h > view.height - GAP && anchor.top - h - GAP > 0)
      top = anchor.top - h - GAP;
    setPos({ top, left, width: matchWidth ? anchor.width : undefined });
  }, [open, anchorRef, align, matchWidth]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (
        ref.current?.contains(e.target) ||
        anchorRef?.current?.contains(e.target)
      )
        return;
      onClose();
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    const onScroll = (e) => {
      if (!ref.current?.contains(e.target)) onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onClose);
    };
  }, [open, onClose, anchorRef]);

  useUiZoomChange(() => {
    if (open) onClose();
  });

  if (!open) return null;

  return createPortal(
    <div
      ref={ref}
      className={`popover${className ? ` ${className}` : ""}`}
      role={role}
      aria-label={ariaLabel}
      style={
        pos
          ? { top: pos.top, left: pos.left, width: pos.width }
          : { visibility: "hidden" }
      }
    >
      {children}
    </div>,
    document.body,
  );
}
