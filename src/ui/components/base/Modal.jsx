import { useEffect, useRef, useId } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../translations/index";
import "./Modal.css";

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function Modal({
  title,
  ariaLabel,
  onClose,
  dismissible = true,
  size = "md",
  placement = "center",
  className = "",
  children,
  footer,
}) {
  const dialogRef = useRef(null);
  const titleId = useId();
  const { t } = useT();

  useEffect(() => {
    const previouslyFocused = document.activeElement;

    const node = dialogRef.current;
    const first = node?.querySelector(FOCUSABLE);
    (first ?? node)?.focus();

    const onKeyDown = (e) => {
      if (e.key === "Escape" && dismissible) {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !node) return;
      const items = Array.from(node.querySelectorAll(FOCUSABLE));
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, [onClose, dismissible]);

  return createPortal(
    <div
      className={`modal-backdrop${placement === "top" ? " modal-backdrop--top" : ""}`}
      onMouseDown={(e) => {
        if (dismissible && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={`modal modal--${size}${className ? ` ${className}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : ariaLabel}
        tabIndex={-1}
      >
        {title && (
          <div className="modal__header">
            <h2 id={titleId} className="modal__title">
              {title}
            </h2>
            {dismissible && (
              <button
                type="button"
                className="btn-close"
                onClick={onClose}
                aria-label={t("Close")}
              >
                ×
              </button>
            )}
          </div>
        )}
        <div className="modal__body">{children}</div>
        {footer && <div className="modal__footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
