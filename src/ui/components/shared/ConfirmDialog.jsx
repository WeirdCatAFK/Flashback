/**
 * ConfirmDialog — replaces native window.confirm/alert with an in-app dialog that
 * matches the rest of the UI and is accessible (built on <Modal>). It's exposed as
 * a promise-based hook so call sites read almost like the native call they replace:
 *
 *   const confirm = useConfirm();
 *   if (!(await confirm({
 *     title: 'Delete deck?',
 *     message: 'This removes the deck. Cards are not deleted.',
 *     confirmLabel: 'Delete',
 *     tone: 'danger',
 *   }))) return;
 *
 * Mount <ConfirmProvider> once near the app root; useConfirm() works anywhere below.
 */

import { createContext, useCallback, useContext, useRef, useState } from 'react';
import Modal from './Modal';
import './ConfirmDialog.css';

const ConfirmContext = createContext(null);

export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used within <ConfirmProvider>');
  return ctx;
}

export function ConfirmProvider({ children }) {
  const [dialog, setDialog] = useState(null);
  const resolverRef = useRef(null);

  const confirm = useCallback((opts) => {
    return new Promise((resolve) => {
      resolverRef.current = resolve;
      setDialog({
        title: opts.title ?? 'Are you sure?',
        message: opts.message ?? '',
        confirmLabel: opts.confirmLabel ?? 'Confirm',
        cancelLabel: opts.cancelLabel ?? 'Cancel',
        tone: opts.tone ?? 'default',
      });
    });
  }, []);

  const settle = useCallback((result) => {
    resolverRef.current?.(result);
    resolverRef.current = null;
    setDialog(null);
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {dialog && (
        <Modal
          title={dialog.title}
          size="sm"
          onClose={() => settle(false)}
          footer={
            <>
              <button type="button" className="confirm-btn" onClick={() => settle(false)}>
                {dialog.cancelLabel}
              </button>
              <button
                type="button"
                className={`confirm-btn confirm-btn--primary confirm-btn--${dialog.tone}`}
                onClick={() => settle(true)}
              >
                {dialog.confirmLabel}
              </button>
            </>
          }
        >
          {dialog.message && <p className="confirm-message">{dialog.message}</p>}
        </Modal>
      )}
    </ConfirmContext.Provider>
  );
}
