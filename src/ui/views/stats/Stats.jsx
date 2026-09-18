/**
 * Stats — how the vault is progressing: completeness, the headline tiles,
 * acquisition, the due forecast, review activity and card maturity, for the
 * caller or for whoever an admin is viewing. Data comes from useStats.js; the
 * panels are in StatsPanels.jsx.
 */

import StatTile from '../../components/base/StatTile';
import { LoadingState, ErrorState } from '../../components/base/StateView';
import ProgressScopePicker from '../../components/account/ProgressScopePicker';
import { useT } from '../../translations/index';
import { pctText, algoLabel } from './format.js';
import useStats from './useStats';
import { CompletenessBand, AcquisitionPanel, MaturityBar, ForecastChart, ActivityHeatmap, Panel } from './StatsPanels';
import './Stats.css';

export default function Stats({ isActive, viewingAccount = null, onViewingAccountChange }) {
  const { t, formatNumber } = useT();
  const viewingName = viewingAccount?.name ?? null;
  const { stats, error, reload, firstLoad } = useStats(isActive, viewingAccount?.id ?? null);

  return (
    <div className="stats-view">
      <div className="stats-body">
        <header className="stats-header">
          <div className="stats-header__row">
            <h1 className="stats-title">{t('Statistics')}</h1>
            {onViewingAccountChange && (
              <ProgressScopePicker value={viewingAccount} onChange={onViewingAccountChange} />
            )}
          </div>
          <p className="stats-lede">
            {viewingName
              ? t("How {name}'s vault is progressing", { name: viewingName })
              : t('How your vault is progressing')}
            {stats && <> · {t('scheduled with {algorithm}', { algorithm: algoLabel(stats.algorithm) })}</>}.
          </p>
        </header>

        {firstLoad ? (
          <LoadingState message={t('Crunching your review history…')} />
        ) : error && !stats ? (
          <ErrorState error={error} onRetry={reload} />
        ) : stats && stats.totals.cards === 0 && stats.totals.reviews === 0 ? (
          <p className="stats-empty">
            {viewingName
              ? t('{name} has no cards or reviews yet.', { name: viewingName })
              : t('No cards or reviews yet. Create some flashcards and study them in the Trainer — your progress will show up here.')}
          </p>
        ) : stats ? (
          <>
            <CompletenessBand completeness={stats.completeness} />

            <div className="stats-tiles">
              <StatTile label={t('Cards')} value={formatNumber(stats.totals.cards)}
                hint={t('{n} mature', { n: formatNumber(stats.maturity.mature) })} />
              <StatTile label={t('Reviews')} value={formatNumber(stats.totals.reviews)}
                hint={stats.totals.reviewsToday > 0
                  ? t('{n} today', { n: formatNumber(stats.totals.reviewsToday) })
                  : t('none today')} />
              <StatTile label={t('Retention')} value={pctText(stats.totals.retentionAll)}
                hint={t('{pct} last 30 days', { pct: pctText(stats.totals.retention30) })}
                title={t('Measured on {reviews} reviews — a card’s first {learning} reviews don’t count.',
                  { reviews: formatNumber(stats.totals.retentionReviews), learning: stats.acquisition.learningReviews })} />
              <StatTile label={t('Streak')} value={t('{n}d', { n: formatNumber(stats.streak.current) })}
                hint={t('best {n}d', { n: formatNumber(stats.streak.longest) })} />
            </div>

            <div className="stats-grid">
              <div className="stats-col">
                <Panel title={t('Acquisition')}>
                  <AcquisitionPanel acquisition={stats.acquisition} />
                </Panel>
                <Panel title={t('Due forecast')} hint={t('Cards coming up over the next two weeks.')}>
                  <ForecastChart forecast={stats.forecast} overdue={stats.overdue} />
                </Panel>
              </div>
              <div className="stats-col">
                <Panel title={t('Review activity')} hint={t('Reviews per day over the last 26 weeks.')}>
                  <ActivityHeatmap activity={stats.activity} />
                </Panel>
                <Panel title={t('Card maturity')}>
                  <MaturityBar maturity={stats.maturity} />
                </Panel>
              </div>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
