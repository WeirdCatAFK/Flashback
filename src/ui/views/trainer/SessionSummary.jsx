/**
 * SessionSummary — the two panels shown instead of a card: "nothing due" (with
 * the reason) before a session, and the tally, the next-session button and the
 * cards worth a look after one.
 */

import { useT } from '../../translations/index';
import { hasExclusions } from './scope';
import { formatNextDue } from './cards';

/** When the next card is due, or the no-schedule line. */
function NextDueLine({ nextDue, fallback }) {
  const { t, formatRelative } = useT();
  return (
    <p className="trainer-summary-line">
      {nextDue ? t('Next review {when}', { when: formatNextDue(nextDue, formatRelative, t) }) : fallback}
    </p>
  );
}

export function EmptySession({ readOnly, scope, result, onStudyEverything }) {
  const { t } = useT();
  return (
    <div className="trainer-summary">
      {readOnly ? (
        <>
          <h3 className="trainer-summary-title">{t('Nothing due from what you’ve read')}</h3>
          <p className="trainer-summary-line">{t('Cards from pages you haven’t reached yet are being held back.')}</p>
          <button type="button" className="btn btn--primary" onClick={onStudyEverything}>{t('Study everything instead')}</button>
        </>
      ) : hasExclusions(scope.exclude) ? (
        <>
          <h3 className="trainer-summary-title">{t('Nothing due outside what you left out')}</h3>
          <p className="trainer-summary-line">{t('Clear an “Except” chip above to widen the session.')}</p>
        </>
      ) : (
        <>
          <h3 className="trainer-summary-title">{t('All caught up')}</h3>
          <NextDueLine nextDue={result?.nextDue} fallback={t('No cards scheduled yet — start reviewing to build your schedule.')} />
        </>
      )}
    </div>
  );
}

export default function SessionSummary({ stats, total, figures, loading, cardsWaiting, result, flagged, onStartNew, onInspect }) {
  const { t, tp } = useT();
  return (
    <div className="trainer-summary">
      <h3 className="trainer-summary-title">{t('Session complete')}</h3>
      <p className="trainer-summary-line">
        {t('{cards} cards · {reviews} reviews · {pct}% correct', { cards: total, reviews: figures.reviews, pct: figures.accuracy })}
      </p>
      <div className="trainer-summary-breakdown">
        <span className="sum sum--again">{t('Again')} <b>{stats.again}</b></span>
        <span className="sum sum--good">{t('Good')} <b>{stats.good}</b></span>
        <span className="sum sum--easy">{t('Easy')} <b>{stats.easy}</b></span>
      </div>
      {loading && <p className="trainer-summary-line">{t('Checking for new cards…')}</p>}
      {!loading && cardsWaiting > 0 && (
        <button type="button" className="btn btn--primary" onClick={onStartNew}>
          {tp('Start new session ({n} card)', 'Start new session ({n} cards)', cardsWaiting)}
        </button>
      )}
      {!loading && cardsWaiting === 0 && <NextDueLine nextDue={result?.nextDue} fallback={t('All caught up!')} />}

      {flagged.length > 0 && (
        <div className="trainer-flagged">
          <h4 className="trainer-flagged-title">{tp('{n} card worth a look', '{n} cards worth a look', flagged.length)}</h4>
          <ul className="trainer-flagged-list">
            {flagged.map((f) => (
              <li key={f.hash} className="trainer-flagged-item">
                <button type="button" className="trainer-flagged-btn" onClick={() => onInspect(f.hash)}>{f.label}</button>
                <span className="trainer-flagged-why">{f.flags.map((x) => x.title).join(' · ')}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
