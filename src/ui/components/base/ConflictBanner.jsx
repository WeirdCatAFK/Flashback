import { useT } from "../../translations/index";
import "./ConflictBanner.css";

export default function ConflictBanner({ onReload, onOverwrite, message }) {
  const { t } = useT();
  return (
    <div className="conflict-banner" role="alert">
      <span className="conflict-banner__message">
        {message ??
          t(
            "This document changed while you were editing it. Your unsaved work is still here.",
          )}
      </span>
      <span className="conflict-banner__actions">
        <button
          type="button"
          className="btn btn--quiet btn--sm"
          onClick={onReload}
        >
          {t("Reload")}
        </button>
        <button
          type="button"
          className="btn btn--quiet-accent btn--sm"
          onClick={onOverwrite}
        >
          {t("Overwrite")}
        </button>
      </span>
    </div>
  );
}
