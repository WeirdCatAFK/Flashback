/**
 * ShownOnce — a secret that exists only in the response that created it (an access
 * token). Deliberately obtrusive rather than a toast that can be missed: it stays
 * until dismissed, and says plainly that dismissing it loses the value.
 *
 *   <ShownOnce title={t('A new token for M. Okafor.')} value={token} onDone={close} />
 */

import { useState } from "react";
import { useT } from "../../translations/index";

export default function ShownOnce({ title, value, notice, onDone }) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); setCopied(true); } catch { }
  };
  return (
    <div className="shown-once" role="alert">
      <p className="shown-once__text">
        {title && <b className="shown-once__title">{title}</b>}{title ? " " : null}
        {notice || t("Copy it now: it’s shown this once, and closing this panel loses it.")}
      </p>
      <code className="shown-once__value">{value}</code>
      <div className="shown-once__actions">
        <button type="button" className="btn btn--quiet-accent btn--sm" onClick={copy}>{copied ? t("Copied") : t("Copy")}</button>
        <button type="button" className="btn btn--quiet btn--sm" onClick={onDone}>{t("Done")}</button>
      </div>
    </div>
  );
}
