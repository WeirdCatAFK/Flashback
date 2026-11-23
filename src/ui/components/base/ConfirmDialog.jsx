import { useCallback, useRef, useState } from "react";
import { ConfirmContext } from "./confirmContext.js";
import Modal from "./Modal";
import { useT } from "../../translations/index";
import "./ConfirmDialog.css";

export function ConfirmProvider({ children }) {
  const [dialog, setDialog] = useState(null);
  const resolverRef = useRef(null);
  const { t } = useT();

  const confirm = useCallback((opts) => {
    return new Promise((resolve) => {
      resolverRef.current = resolve;
      setDialog({
        title: opts.title,
        message: opts.message ?? "",
        confirmLabel: opts.confirmLabel,
        cancelLabel: opts.cancelLabel,
        tone: opts.tone ?? "default",
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
          title={dialog.title ?? t("Are you sure?")}
          size="sm"
          onClose={() => settle(false)}
          footer={
            <>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => settle(false)}
              >
                {dialog.cancelLabel ?? t("Cancel")}
              </button>
              <button
                type="button"
                className={`btn ${dialog.tone === "danger" ? "btn--danger-quiet" : "btn--quiet-accent"}`}
                onClick={() => settle(true)}
              >
                {dialog.confirmLabel ?? t("Confirm")}
              </button>
            </>
          }
        >
          {dialog.message && (
            <p className="confirm-message">{dialog.message}</p>
          )}
        </Modal>
      )}
    </ConfirmContext.Provider>
  );
}
