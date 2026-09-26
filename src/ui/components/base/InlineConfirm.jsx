/**
 * InlineConfirm — a confirmation that opens in place, beside the thing it is
 * about, instead of a modal. It says what will happen in plain words and offers
 * Cancel plus one or more actions. Cancel takes focus, so a stray Enter is never
 * the destructive choice.
 *
 *   <InlineConfirm title={t('Deactivate M. Okafor?')} message={t('Every token they hold…')}
 *     onCancel={close} actions={[{ label: t('Deactivate'), kind: 'danger', onClick: deactivate }]} />
 *
 * `kind` is 'danger', 'primary' or omitted for a plain action. `tone="neutral"` drops
 * the danger tint, for a choice that loses nothing (switching a scheduler, say).
 */

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
