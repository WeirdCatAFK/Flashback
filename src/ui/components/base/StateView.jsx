import { useT } from "../../translations/index";
import "./StateView.css";

function StateView({ tone = "neutral", icon, title, message, action }) {
  return (
    <div
      className={`state-view state-view--${tone}`}
      role={tone === "error" ? "alert" : undefined}
    >
      {icon && (
        <div className="state-view__icon" aria-hidden="true">
          {icon}
        </div>
      )}
      {title && <p className="state-view__title">{title}</p>}
      {message && <p className="state-view__message">{message}</p>}
      {action && <div className="state-view__action">{action}</div>}
    </div>
  );
}

export function LoadingState({ message }) {
  const { t } = useT();
  return (
    <StateView
      tone="neutral"
      icon={<span className="state-view__line"><i /></span>}
      message={message ?? t("Loading…")}
    />
  );
}

export function ErrorState({ error, title, onRetry }) {
  const { t } = useT();
  const message =
    typeof error === "string"
      ? error
      : error?.message || t("Unexpected error.");
  return (
    <StateView
      tone="error"
      title={title ?? t("Something went wrong")}
      message={message}
      action={
        onRetry && (
          <button type="button" className="btn btn--quiet btn--sm" onClick={onRetry}>
            {t("Try again")}
          </button>
        )
      }
    />
  );
}

export function EmptyState({ icon, title, message, action }) {
  return (
    <StateView
      tone="neutral"
      icon={icon}
      title={title}
      message={message}
      action={action}
    />
  );
}

export default StateView;
