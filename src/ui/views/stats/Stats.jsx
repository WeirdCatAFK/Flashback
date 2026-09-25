/**
 * Stats — a short report, not a dashboard: one column read top to bottom, each section
 * answering one question in the order it is asked. Where am I (the headline "N%
 * complete", with the Read and Known lines)? What's coming (the forecast)? Is it staying
 * (retention, and how new cards land)? Where are the cards (the gap bands Flashcards
 * uses; a band opens those cards there)? Your reviews (the heatmap and the streak).
 * Figures sit inside sentences in bold mono, where they are read in context, and each
 * chart carries a numbered caption.
 *
 * It shows the caller's progress, or whoever an admin chose in the scope picker; the
 * bands only open Flashcards for your own, since Flashcards is always about yours.
 * Data comes from useStats.js; the figures are in StatsFigures.jsx.
 */

import { LoadingState, ErrorState } from '../../components/base/StateView';
import ProgressScopePicker from '../../components/account/ProgressScopePicker';
import { useT } from '../../translations/index';
import { pctText, oneDp, algoLabel } from './format.js';
import { forecastTotal } from './report.js';
import useStats from './useStats';
import { Forecast, Bands, Heatmap } from './StatsFigures';
import './Stats.css';

/** A figure in a sentence: bold mono, read in place. */
const F = ({ children }) => <b className="sx-fig-n">{children}</b>;

function Head({ stats, viewingName, onBackToMine }) {
  const { t, tp, formatNumber } = useT();
  const c = stats.completeness;
  const read = c?.read, known = c?.known;
  return (
    <header className="sx-head">
      {viewingName && (
        <p className="sx-viewing">
          {t('Showing {name}’s progress.', { name: viewingName })}{' '}
          <button type="button" className="link-action" onClick={onBackToMine}>{t('Back to yours')}</button>
        </p>
      )}
      <h1 className="sx-title"><b>{pctText(c?.percent)}</b> {t('complete')}</h1>
      <p className="sx-lede">
        {viewingName
          ? t('{name} has read {read} of this vault and knows {known} of the {n} cards made from it.', { name: viewingName, read: pctText(read?.percent), known: pctText(known?.percent), n: formatNumber(known?.cards ?? 0) })
          : t('You have read {read} of this vault and know {known} of the {n} cards made from it.', { read: pctText(read?.percent), known: pctText(known?.percent), n: formatNumber(known?.cards ?? 0) })}
      </p>
      <div className="sx-halves">
        <div className="sx-half">
          <span className="sx-half__label">{t('Read')}</span>
          <b>{pctText(read?.percent)}</b>
          <span className="sx-line" aria-hidden="true"><i style={{ width: `${Math.round((read?.percent ?? 0) * 100)}%` }} /></span>
          <span className="sx-half__note">
            {read?.documents
              ? `${tp('{n} of {total} document finished', '{n} of {total} documents finished', read.finished, { n: formatNumber(read.finished), total: formatNumber(read.documents) })} · ${t('{n} started', { n: formatNumber(read.inProgress) })}`
              : t('No documents yet')}
          </span>
        </div>
        <div className="sx-half">
          <span className="sx-half__label">{t('Known')}</span>
          <b>{pctText(known?.percent)}</b>
          <span className="sx-line" aria-hidden="true"><i style={{ width: `${Math.round((known?.percent ?? 0) * 100)}%` }} /></span>
          <span className="sx-half__note">
            {known?.cards
              ? `${tp('{n} card', '{n} cards', known.cards, { n: formatNumber(known.cards) })} · ${t('{n} past 21 days', { n: formatNumber(known.mature) })}`
              : t('No cards yet')}
          </span>
        </div>
      </div>
    </header>
  );
}

function Coming({ stats }) {
  const { t, formatNumber } = useT();
  const today = stats.forecast[0]?.due ?? 0;
  return (
    <section className="sx-sec">
      <h2 className="sx-h">{t('What’s coming')}</h2>
      <p className="sx-p">
        <F>{formatNumber(today)}</F> {t('due today')}
        {stats.overdue > 0 && <>, {t('and')} <F>{formatNumber(stats.overdue)}</F> {t('overdue from earlier')}</>}
        . <F>{formatNumber(forecastTotal(stats.forecast))}</F> {t('over the next two weeks.')}
      </p>
      <figure className="sx-figure">
        <Forecast forecast={stats.forecast} />
        <figcaption><span>{t('Fig. {n}', { n: 1 })}</span> {t('Cards due each day, today first.')}</figcaption>
      </figure>
    </section>
  );
}

function Staying({ stats }) {
  const { t, formatNumber } = useT();
  const a = stats.acquisition;
  const r = a.reviewsToRecall;
  return (
    <section className="sx-sec">
      <h2 className="sx-h">{t('Is it staying?')}</h2>
      <p className="sx-p">
        {stats.totals.retentionAll == null
          ? t('Nothing has come back for review yet, so there is no retention to measure.')
          : <>{t('Of the cards you had already learned, you recalled')} <F>{pctText(stats.totals.retentionAll)}</F> {t('when they came back,')} <F>{pctText(stats.totals.retention30)}</F> {t('in the last 30 days.')}</>}
      </p>
      <div className="sx-trio" title={t('How new cards land, while they are still being learned')}>
        <div>
          <b>{pctText(a.firstExposureAll)}</b>
          <span>{t('right on first sight')}</span>
          <small>{t('{pct} last 30 days · {n} cards', { pct: pctText(a.firstExposure30), n: formatNumber(a.firstExposureCards) })}</small>
        </div>
        <div>
          <b>{oneDp(r.median)}</b>
          <span>{t('reviews to learn a card')}</span>
          <small>{t('median · average {avg} · {n} cards', { avg: oneDp(r.avg), n: formatNumber(r.cards) })}</small>
        </div>
        <div>
          <b>{pctText(a.retentionAll)}</b>
          <span>{t('new-card pass rate')}</span>
          <small>{t('{pct} last 30 days', { pct: pctText(a.retention30) })}</small>
        </div>
      </div>
      <p className="sx-note">
        {t('Retention counts {n} reviews. A card’s first {k} reviews, while it is still being learned, are measured separately in the row above.', { n: formatNumber(stats.totals.retentionReviews), k: a.learningReviews })}
      </p>
    </section>
  );
}

function Where({ stats, onShowBand }) {
  const { t, formatNumber } = useT();
  const total = Object.values(stats.bands ?? {}).reduce((x, n) => x + n, 0);
  return (
    <section className="sx-sec">
      <h2 className="sx-h">{t('Where the cards are')}</h2>
      <p className="sx-p">{t('Grouped by the gap between reviews, the same way Flashcards groups them. The further down, the longer a card waits before it comes back.')}</p>
      <figure className="sx-figure">
        <Bands bands={stats.bands} onShowBand={onShowBand} />
        <figcaption><span>{t('Fig. {n}', { n: 2 })}</span> {t('{n} cards by current interval. The 21-day line sits between “up to 3 weeks” and “up to 2 months”.', { n: formatNumber(total) })}</figcaption>
      </figure>
    </section>
  );
}

function Reviews({ stats }) {
  const { t, tp, formatNumber } = useT();
  return (
    <section className="sx-sec">
      <h2 className="sx-h">{t('Your reviews')}</h2>
      <p className="sx-p">
        <F>{formatNumber(stats.totals.reviewsToday)}</F> {t('today')} · <F>{formatNumber(stats.totals.reviews)}</F> {t('in all')} · {t('a streak of')}{' '}
        <F>{tp('{n} day', '{n} days', stats.streak.current, { n: formatNumber(stats.streak.current) })}</F>, {t('your longest {n}', { n: formatNumber(stats.streak.longest) })}.
      </p>
      <figure className="sx-figure">
        <Heatmap activity={stats.activity} />
        <figcaption>
          <span>{t('Fig. {n}', { n: 3 })}</span> {t('Reviews per day over the last 26 weeks, one column per week.')}
          <span className="sx-legend" aria-hidden="true">{t('Fewer')}<i data-l="0" /><i data-l="1" /><i data-l="2" /><i data-l="3" /><i data-l="4" />{t('More')}</span>
        </figcaption>
      </figure>
    </section>
  );
}

export default function Stats({ isActive, viewingAccount = null, onViewingAccountChange, onShowBand }) {
  const { t } = useT();
  const viewingName = viewingAccount?.name ?? null;
  const { stats, error, reload, firstLoad } = useStats(isActive, viewingAccount?.id ?? null);

  return (
    <div className="stats-view">
      <article className="sx-report">
        <div className="sx-top">
          <span className="sx-eyebrow">{stats ? t('Scheduled with {algorithm}', { algorithm: algoLabel(stats.algorithm) }) : t('Statistics')}</span>
          {onViewingAccountChange && <ProgressScopePicker value={viewingAccount} onChange={onViewingAccountChange} />}
        </div>

        {firstLoad ? (
          <LoadingState message={t('Crunching your review history…')} />
        ) : error && !stats ? (
          <ErrorState error={error} onRetry={reload} />
        ) : stats && stats.totals.cards === 0 && stats.totals.reviews === 0 ? (
          <p className="sx-empty">
            {viewingName
              ? t('{name} has no cards or reviews yet.', { name: viewingName })
              : t('No cards or reviews yet. Create some flashcards and study them in the Trainer — your progress will show up here.')}
          </p>
        ) : stats ? (
          <>
            <Head stats={stats} viewingName={viewingName} onBackToMine={() => onViewingAccountChange?.(null)} />
            <Coming stats={stats} />
            <Staying stats={stats} />
            <Where stats={stats} onShowBand={viewingName ? null : onShowBand} />
            <Reviews stats={stats} />
          </>
        ) : null}
      </article>
    </div>
  );
}
