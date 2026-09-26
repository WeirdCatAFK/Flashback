/**
 * ContextMenu — a right-click menu at a point: items, separators, and a danger
 * item that asks once before acting. Dismisses on outside click and Escape.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../translations/index";
import "./ContextMenu.css";

/**
 * `item.label` arrives already translated from the caller — this component never
 * translates it, which is why it stays a plain value and not a key.
 */
export default function ContextMenu({ x, y, items, onClose }) {
  const ref = useRef();
  const { t } = useT();
  const [pos, setPos] = useState({ x, y });
  const [confirmIdx, setConfirmIdx] = useState(null);

  useLayoutEffect(() => {
    if (!ref.current) return;
    const { offsetWidth: w, offsetHeight: h } = ref.current;
    setPos({
      x: x + w > window.innerWidth ? x - w : x,
      y: y + h > window.innerHeight ? y - h : y,
    });
  }, [x, y]);

  useEffect(() => {
    const onDown = (e) => {
      if (!ref.current?.contains(e.target)) onClose();
    };
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const handleItem = (item, idx) => {
    if (item.danger && confirmIdx !== idx) {
      setConfirmIdx(idx);
      return;
    }
    item.action();
    onClose();
  };

  return createPortal(
    <div ref={ref} className="ctx-menu" style={{ top: pos.y, left: pos.x }}>
      {items.map((item, idx) =>
        item.separator ? (
          <div key={`sep-${idx}`} className="ctx-sep" />
        ) : confirmIdx === idx ? (
          <div key={item.label} className="ctx-confirm">
            <span>{t("Delete?")}</span>
            <button
              type="button"
              className="btn btn--danger-quiet btn--sm"
              onClick={() => {
                item.action();
                onClose();
              }}
            >
              {t("Yes")}
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setConfirmIdx(null)}
            >
              {t("No")}
            </button>
          </div>
        ) : (
          <button
            type="button"
            key={item.label}
            className={`ctx-item${item.danger ? " ctx-danger" : ""}${item.muted ? " ctx-muted" : ""}`}
            onClick={() => handleItem(item, idx)}
          >
            {item.label}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
