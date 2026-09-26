/**
 * SessionSummary — what stands in for the card when there is none: "nothing due"
 * (with the reason) before a session, and after a batch, what happened in plain
 * sentences — cards remembered, the reviews it took, misses, new cards, how many
 * more are due — with Next and Write in your diary. It describes; it never grades
 * the person. The cards worth a look follow, as before.
 */

import { useT } from '../../translations/index';
import { hasExclusions } from './scope';
import { formatNextDue } from './cards';
import { nextBatchSize } from './session';

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
          <button type="button" className="btn btn--quiet-accent" onClick={onStudyEverything}>{t('Study everything instead')}</button>
        </>
      ) : hasExclusions(scope.exclude) ? (
        <>
          <h3 className="trainer-summary-title">{t('Nothing due outside what you left out')}</h3>
          <p className="trainer-summary-line">{t('Open the filter above to widen the session.')}</p>
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

export default function SessionSummary({ tally, loading, cardsWaiting, batchSize, result, flagged, onNext, onWriteDiary, onInspect }) {
  const { t, tp } = useT();
  const more = loading ? 0 : cardsWaiting;
  const next = nextBatchSize(batchSize, more);
  return (
    <div className="trainer-summary">
      <div className="eyebrow">{more > 0 ? t('Batch done') : t('Session done')}</div>
      <h3 className="trainer-summary-title">{tp('{n} card remembered', '{n} cards remembered', tally.remembered)}</h3>
      <p className="trainer-summary-line">
        {tp('It took {n} review.', 'It took {n} reviews.', tally.reviews)}
        {tally.missed > 0 && <> {tp('{n} came round again after a miss.', '{n} came round again after a miss.', tally.missed)}</>}
        {tally.fresh > 0 && <> {tp('{n} was new.', '{n} were new.', tally.fresh)}</>}
        {more > 0 && <> {tp('{n} more is due.', '{n} more are due.', more)}</>}
      </p>
      {loading && <p className="trainer-summary-line">{t('Checking for more cards…')}</p>}
      <div className="trainer-summary-actions">
        {more > 0 && (
          <button type="button" className="btn btn--quiet-accent" onClick={onNext}>{t('Next {n}', { n: next })}</button>
        )}
        {onWriteDiary && (
          <button type="button" className={`btn ${more > 0 ? 'btn--quiet' : 'btn--quiet-accent'}`} onClick={onWriteDiary}>{t('Write in your diary')}</button>
        )}
      </div>
      {!loading && more === 0 && <NextDueLine nextDue={result?.nextDue} fallback={t('All caught up.')} />}

      {flagged.length > 0 && (
        <div className="trainer-flagged">
          <h4 className="eyebrow trainer-flagged-title">{tp('{n} card worth a look', '{n} cards worth a look', flagged.length)}</h4>
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
