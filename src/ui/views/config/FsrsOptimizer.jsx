/**
 * FsrsOptimizer — the panel under the FSRS scheduler: eligibility, the last fit,
 * the Optimize button and its result. Rendered only while FSRS is active.
 */

import { useT } from '../../translations/index';
import { Rich } from '../../translations/components.jsx';
import useFsrsOptimizer from './useFsrsOptimizer';

const fmtLoss = (n) => (typeof n === 'number' ? n.toFixed(4) : '—');

export default function FsrsOptimizer() {
  const { t, tp, formatDate } = useT();
  const { info, running, result, error, enough, run } = useFsrsOptimizer();


  return (
    <div className="fsrs-optimizer">
      <p className="config-hint">
        {t('Fit the memory model to your own review history for more accurate scheduling.')}{' '}
        {info != null
          ? t('Needs at least {min} graded reviews — you have {count}.',
            { min: info.minReviews, count: info.reviewCount })
          : t('Needs at least {min} graded reviews.', { min: 400 })}
      </p>

      {info?.optimizedAt && (
        <p className="fsrs-optimizer-status">
          {info.weightReviewCount != null
            ? tp('Last fitted {date} from {n} review.', 'Last fitted {date} from {n} reviews.',
              info.weightReviewCount, { date: formatDate(info.optimizedAt) })
            : t('Last fitted {date}.', { date: formatDate(info.optimizedAt) })}
        </p>
      )}
      {info && !info.optimizedAt && (
        <p className="fsrs-optimizer-status">{t('Using default weights.')}</p>
      )}

      <button
        type="button"
        className="btn btn--primary btn--sm"
        onClick={run}
        disabled={running || !enough}
      >
        {running ? t('Optimizing…') : t('Optimize FSRS parameters')}
      </button>

      {result && result.optimized && (
        <p className="fsrs-optimizer-result">
          {tp('Fitted from {n} review.', 'Fitted from {n} reviews.', result.reviewCount)}{' '}
          <Rich
            text={result.loss < result.initialLoss
              ? t('Loss {before} → {after} (improved).')
              : t('Loss {before} → {after} (already near-optimal).')}
            values={{
              before: fmtLoss(result.initialLoss),
              after: <strong>{fmtLoss(result.loss)}</strong>,
            }}
          />
        </p>
      )}
      {result && !result.optimized && (
        <p className="fsrs-optimizer-result">
          {t('Not enough graded reviews yet ({count} of {min}). Keep reviewing and try again later.',
            { count: result.reviewCount, min: result.minReviews })}
        </p>
      )}
      {error && <p className="fsrs-optimizer-error">{error}</p>}
    </div>
  );
}
