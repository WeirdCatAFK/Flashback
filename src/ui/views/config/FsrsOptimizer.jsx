/**
 * FsrsOptimizer — the "Fit to your reviews" row under the FSRS scheduler. Its hint says
 * where things stand: default weights and how many reviews fitting needs, or when it was
 * last fitted; after a fit, what the fit did. Rendered only while FSRS is active.
 */

import { useT } from '../../translations/index';
import ConfigRow from './ConfigRow';
import useFsrsOptimizer from './useFsrsOptimizer';

const fmtLoss = (n) => (typeof n === 'number' ? n.toFixed(4) : '—');

export default function FsrsOptimizer() {
  const { t, tp, formatDate } = useT();
  const { info, running, result, error, enough, run } = useFsrsOptimizer();

  const standing = info?.optimizedAt
    ? info.weightReviewCount != null
      ? tp('Last fitted {date} from {n} review.', 'Last fitted {date} from {n} reviews.', info.weightReviewCount, { date: formatDate(info.optimizedAt) })
      : t('Last fitted {date}.', { date: formatDate(info.optimizedAt) })
    : info
      ? t('Uses default weights. Fitting needs at least {min} graded reviews; you have {count}.', { min: info.minReviews, count: info.reviewCount })
      : undefined;

  const outcome = error
    ?? (result?.optimized
      ? `${tp('Fitted from {n} review.', 'Fitted from {n} reviews.', result.reviewCount)} ${
        result.loss < result.initialLoss
          ? t('Loss {before} → {after} (improved).', { before: fmtLoss(result.initialLoss), after: fmtLoss(result.loss) })
          : t('Loss {before} → {after} (already near-optimal).', { before: fmtLoss(result.initialLoss), after: fmtLoss(result.loss) })}`
      : result
        ? t('Not enough graded reviews yet ({count} of {min}). Keep reviewing and try again later.', { count: result.reviewCount, min: result.minReviews })
        : null);

  return (
    <ConfigRow id="optimize" hint={outcome ?? standing}>
      <button type="button" className="btn btn--quiet btn--sm" onClick={run} disabled={running || !enough}>
        {running ? t('Fitting…') : t('Optimize')}
      </button>
    </ConfigRow>
  );
}
