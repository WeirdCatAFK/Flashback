/**
 * StateView — one consistent treatment for the loading / error / empty states
 * every view needs. Before this, views hand-rolled these (some as unstyled bare
 * <p>, some swallowed errors so a failure looked identical to "empty"). Use these
 * so a failed fetch always reads as a failure, and an empty result invites action.
 *
 *   <LoadingState message="Loading cards…" />
 *   <ErrorState error={err} onRetry={refetch} />
 *   <EmptyState title="No decks yet" message="Create one to get started." action={…} />
 */

import { useT } from '../../translations';
import './StateView.css';

function StateView({ tone = 'neutral', icon, title, message, action }) {
  return (
    <div className={`state-view state-view--${tone}`} role={tone === 'error' ? 'alert' : undefined}>
      {icon && <div className="state-view__icon" aria-hidden="true">{icon}</div>}
      {title && <p className="state-view__title">{title}</p>}
      {message && <p className="state-view__message">{message}</p>}
      {action && <div className="state-view__action">{action}</div>}
    </div>
  );
}

// Defaults resolve in the body rather than as parameter defaults: t() only exists
// once the hook has run, and a default resolved at render re-runs on a language switch.
export function LoadingState({ message }) {
  const { t } = useT();
  return (
    <StateView
      tone="neutral"
      icon={<span className="state-view__spinner" />}
      message={message ?? t('Loading…')}
    />
  );
}

export function ErrorState({ error, title, onRetry }) {
  const { t } = useT();
  const message = typeof error === 'string' ? error : error?.message || t('Unexpected error.');
  return (
    <StateView
      tone="error"
      title={title ?? t('Something went wrong')}
      message={message}
      action={onRetry && (
        <button type="button" className="state-view__btn" onClick={onRetry}>
          {t('Try again')}
        </button>
      )}
    />
  );
}

export function EmptyState({ icon, title, message, action }) {
  return <StateView tone="neutral" icon={icon} title={title} message={message} action={action} />;
}

export default StateView;
