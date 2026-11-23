import { useEffect, useRef } from "react";
import { useT } from "../../translations/index";

export default function InlineConfirm({ title, message, children, actions = [], onCancel, cancelLabel, busy = false, tone = "danger", className = "" }) {
  const { t } = useT();
  const cancelRef = useRef(null);
  useEffect(() => { cancelRef.current?.focus({ preventScroll: true }); }, []);

  return (
    <div
      className={`inline-confirm${tone === "neutral" ? " inline-confirm--neutral" : ""}${className ? ` ${className}` : ""}`}
      role="group"
      aria-label={title}
      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onCancel(); } }}
    >
      <p className="inline-confirm__text">
        {title && <b className="inline-confirm__title">{title}</b>}
        {title && message ? " " : null}
        {message}
      </p>
      {children}
      <div className="inline-confirm__actions">
        <button ref={cancelRef} type="button" className="btn btn--quiet btn--sm" onClick={onCancel} disabled={busy}>
          {cancelLabel ?? t("Cancel")}
        </button>
        {actions.map((a) => (
          <button
            key={a.label}
            type="button"
            className={`btn btn--sm ${a.kind === "danger" ? "btn--danger-quiet" : a.kind === "primary" ? "btn--quiet-accent" : "btn--quiet"}`}
            onClick={a.onClick}
            disabled={busy || a.disabled}
          >
            {a.label}
          </button>
        ))}
      </div>
    </div>
  );
}
