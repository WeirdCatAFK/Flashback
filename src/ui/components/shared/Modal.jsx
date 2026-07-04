/**
 * Modal — the base dialog primitive. Before this, every modal except the search
 * bar hand-rolled its own backdrop and skipped a11y (no Escape, no focus trap, no
 * role="dialog"). Build dialogs on this so they all behave the same:
 *
 *   - rendered in a portal above the app
 *   - role="dialog" + aria-modal, labelled by `title` or `ariaLabel`
 *   - Escape closes, backdrop click closes (unless dismissible={false})
 *   - focus moves in on open and is restored to the trigger on close
 *   - Tab/Shift+Tab are trapped inside the dialog
 *
 *   <Modal title="Rename deck" onClose={close}>…</Modal>
 */

import { useEffect, useRef, useId } from 'react';
import { createPortal } from 'react-dom';
import './Modal.css';

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function Modal({
  title,
  ariaLabel,
  onClose,
  dismissible = true,
  size = 'md',
  children,
  footer,
}) {
  const dialogRef = useRef(null);
  const titleId = useId();

  useEffect(() => {
    const previouslyFocused = document.activeElement;

    // Move focus into the dialog (first focusable, else the dialog itself).
    const node = dialogRef.current;
    const first = node?.querySelector(FOCUSABLE);
    (first ?? node)?.focus();

    const onKeyDown = (e) => {
      if (e.key === 'Escape' && dismissible) {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !node) return;
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

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      // Restore focus to whatever opened the modal.
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, [onClose, dismissible]);

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (dismissible && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={`modal modal--${size}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : ariaLabel}
        tabIndex={-1}
      >
        {title && (
          <div className="modal__header">
            <h2 id={titleId} className="modal__title">{title}</h2>
            {dismissible && (
              <button type="button" className="modal__close" onClick={onClose} aria-label="Close">
                ×
              </button>
            )}
          </div>
        )}
        <div className="modal__body">{children}</div>
        {footer && <div className="modal__footer">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}
