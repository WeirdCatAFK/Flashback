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
import { useT } from '../../translations';
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
  const { t } = useT();

  // Labels are stored raw (possibly undefined) and defaulted at render, not here:
  // t() at call time would freeze the dialog in whatever language was active when
  // it opened, and t(dialog.cancelLabel) would be a non-literal the extractor
  // cannot see. Defaulting in the JSX below keeps both honest.
  const confirm = useCallback((opts) => {
    return new Promise((resolve) => {
      resolverRef.current = resolve;
      setDialog({
        title: opts.title,
        message: opts.message ?? '',
        confirmLabel: opts.confirmLabel,
        cancelLabel: opts.cancelLabel,
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
          title={dialog.title ?? t('Are you sure?')}
          size="sm"
          onClose={() => settle(false)}
          footer={
            <>
              <button type="button" className="confirm-btn" onClick={() => settle(false)}>
                {dialog.cancelLabel ?? t('Cancel')}
              </button>
              <button
                type="button"
                className={`confirm-btn confirm-btn--primary confirm-btn--${dialog.tone}`}
                onClick={() => settle(true)}
              >
                {dialog.confirmLabel ?? t('Confirm')}
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
