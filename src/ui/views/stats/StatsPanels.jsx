/**
 * The Stats view's panels: the completeness band, acquisition metrics, the
 * maturity bar, the due forecast and the review-activity heatmap, plus the
 * Panel frame they sit in.
 */

import { useMemo } from 'react';
import { ramp } from '../../utils/chartRamp';
import { useT } from '../../translations/index';
import { pctText, oneDp } from './format.js';

const WEEKS = 26;

export function CompletenessBand({ completeness }) {
  const { t, tp, formatNumber } = useT();
  const c = completeness;
  if (!c) return null;

  const overall = c.percent == null ? null : Math.round(c.percent * 100);
  const halves = [
    {
      key: "read",
      label: t('Read'),
      percent: c.read.percent,
      detail: c.read.documents === 0
        ? t('No documents yet')
        : tp('{n} of {total} document read',
             '{n} of {total} documents read',
             c.read.finished,
             { n: formatNumber(c.read.finished), total: formatNumber(c.read.documents) }),
      hint: c.read.inProgress > 0
        ? tp('{n} started', '{n} started', c.read.inProgress, { n: formatNumber(c.read.inProgress) })
        : null,
    },
    {
      key: "known",
      label: t('Known'),
      percent: c.known.percent,
      detail: c.known.cards === 0
        ? t('No cards yet')
        : tp('{n} card', '{n} cards', c.known.cards, { n: formatNumber(c.known.cards) }),
      hint: c.known.cards > 0
        ? t('{n} mature', { n: formatNumber(c.known.mature) })
        : null,
    },
  ];

  return (
    <section className="stats-completeness">
      <div className="stats-completeness-head">
        <div>
          <div className="stats-completeness-value">{pctText(c.percent)}</div>
          <div className="stats-completeness-label">{t('Completeness')}</div>
        </div>
        <p className="stats-completeness-hint">
          {t('How much of this vault you have read, and how well you know the cards from it.')}
        </p>
      </div>

      <div
        className="stats-completeness-track"
        role="img"
        aria-label={overall == null
          ? t('Completeness unknown — nothing in this vault yet')
          : t('Vault {percent}% complete', { percent: overall })}
      >
        <div
          className="stats-completeness-fill"
          style={{ width: `${overall ?? 0}%`, background: ramp(70) }}
        />
      </div>

      <ul className="stats-completeness-halves">
        {halves.map((h) => (
          <li key={h.key} className="stats-completeness-half">
            <span className="stats-completeness-half-label">{h.label}</span>
            <span className="stats-completeness-half-track" aria-hidden="true">
              <span
                style={{
                  width: `${h.percent == null ? 0 : Math.round(h.percent * 100)}%`,
                  background: ramp(45),
                }}
              />
            </span>
            <span className="stats-completeness-half-value">{pctText(h.percent)}</span>
            <span className="stats-completeness-half-detail">
              {h.detail}{h.hint ? <> · {h.hint}</> : null}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Retention answers "is what I learned staying?", which only means anything once a
 * card is actually learned. These are the other half: how new material lands while
 * it is still being acquired.
 */
export function AcquisitionPanel({ acquisition }) {
  const { t, tp } = useT();
  const a = acquisition;
  if (a.reviews === 0 && a.firstExposureCards === 0) {
    return <p className="stats-empty-inline">{t('No reviews yet — study some new cards to see how they land.')}</p>;
  }

  const metrics = [
    {
      key: "pass",
      label: t('New-card pass rate'),
      value: pctText(a.retentionAll),
      sub: t('{pct} last 30 days', { pct: pctText(a.retention30) }),
      hint: tp('{n} learning review', '{n} learning reviews', a.reviews),
    },
    {
      key: "first",
      label: t('First-recall rate'),
      value: pctText(a.firstExposureAll),
      sub: t('{pct} last 30 days', { pct: pctText(a.firstExposure30) }),
      hint: tp('correct on first sight · {n} card',
               'correct on first sight · {n} cards', a.firstExposureCards),
    },
    {
      key: "cost",
      label: t('Reviews to learn'),
      value: oneDp(a.reviewsToRecall.median),
      sub: t('avg {value}', { value: oneDp(a.reviewsToRecall.avg) }),
      hint: tp('median attempts to first recall · {n} card',
               'median attempts to first recall · {n} cards', a.reviewsToRecall.cards),
    },
  ];

  return (
    <div className="stats-metrics">
      {metrics.map((m) => (
        <div key={m.key} className="stats-metric">
          <div className="stats-metric-value">{m.value}</div>
          <div className="stats-metric-label">{m.label}</div>
          <div className="stat-tile__hint">{m.sub}</div>
          <div className="stats-metric-hint">{m.hint}</div>
        </div>
      ))}
    </div>
  );
}

export function MaturityBar({ maturity }) {
  const { t, formatNumber } = useT();
  const { new: neu, young, mature } = maturity;
  const total = neu + young + mature;
  const segments = [
    { key: "mature", label: t('Mature'), count: mature, hint: t('Interval ≥ 21 days'), fill: ramp(85) },
    { key: "young", label: t('Young'), count: young, hint: t('Reviewed, interval < 21 days'), fill: ramp(40) },
    { key: "new", label: t('New'), count: neu, hint: t('Not yet reviewed'), fill: ramp(12) },
  ];

  if (total === 0) {
    return <p className="stats-empty-inline">{t('No cards yet.')}</p>;
  }

  return (
    <div className="stats-maturity">
      <div className="stats-maturity-track" role="img"
        aria-label={t('Card maturity: {mature} mature, {young} young, {neu} new',
          { mature, young, neu })}>
        {segments.map((s) =>
          s.count > 0 ? (
            <div key={s.key} className="stats-maturity-seg"
              style={{ flexGrow: s.count, background: s.fill }}
              title={`${s.label}: ${s.count} (${Math.round((s.count / total) * 100)}%)`} />
          ) : null,
        )}
      </div>
      <ul className="stats-legend">
        {segments.map((s) => (
          <li key={s.key} className="stats-legend-item">
            <span className="stats-legend-swatch" style={{ background: s.fill }} />
            <span className="stats-legend-label">{s.label}</span>
            <span className="stats-legend-count">{formatNumber(s.count)}</span>
            <span className="stats-legend-hint">{s.hint}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ForecastChart({ forecast, overdue }) {
  const { t, tp, formatWeekdayNarrow } = useT();
  const max = Math.max(1, ...forecast.map((f) => f.due));
  const totalDue = forecast.reduce((a, f) => a + f.due, 0);

  if (totalDue === 0 && overdue === 0) {
    return <p className="stats-empty-inline">{t('Nothing scheduled — you’re all caught up.')}</p>;
  }

  return (
    <div className="stats-forecast">
      {overdue > 0 && (
        <p className="stats-overdue">
          {tp('{n} card overdue', '{n} cards overdue', overdue)}
        </p>
      )}
      <div className="stats-forecast-bars">
        {forecast.map((f, i) => (
          <div key={f.date} className="stats-forecast-col"
            title={t('{date}: {n} due', { date: f.date, n: f.due })}>
            <div className="stats-forecast-count">{f.due > 0 ? f.due : ""}</div>
            <div className="stats-forecast-bar-wrap">
              <div className="stats-forecast-bar"
                style={{ height: `${(f.due / max) * 100}%`, background: ramp(f.due > 0 ? 70 : 0) }} />
            </div>
            <div className={`stats-forecast-x${i === 0 ? " is-today" : ""}`}>
              {i === 0 ? t('Today') : formatWeekdayNarrow(f.date)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ActivityHeatmap({ activity }) {
  const { t, tp } = useT();
  const { cells, max } = useMemo(() => {
    const byDay = new Map(activity.map((a) => [a.day, a.total]));
    const now = new Date();
    const dayAt = (offset) =>
      new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    const pad = (n) => String(n).padStart(2, "0");
    const dayStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

    let startOffset = -(WEEKS * 7 - 1);
    startOffset -= (dayAt(startOffset).getDay() + 6) % 7;

    const grid = [];
    let peak = 0;
    for (let offset = startOffset; offset <= 0; offset++) {
      const key = dayStr(dayAt(offset));
      const total = byDay.get(key) ?? 0;
      if (total > peak) peak = total;
      grid.push({ key, total, future: false });
    }
    while (grid.length % 7 !== 0) grid.push({ key: `pad-${grid.length}`, total: 0, future: true });
    return { cells: grid, max: peak };
  }, [activity]);

  const level = (total) => {
    if (total <= 0) return 0;
    if (max <= 1) return 4;
    const r = total / max;
    return r <= 0.25 ? 1 : r <= 0.5 ? 2 : r <= 0.75 ? 3 : 4;
  };
  const cellBg = (lv) => (lv === 0 ? "var(--color-bg-hover)" : ramp(15 + lv * 20));

  return (
    <div className="stats-heatmap-wrap">
      <div className="stats-heatmap">
        {cells.map((c) =>
          c.future ? (
            <span key={c.key} className="stats-heatmap-cell is-pad" />
          ) : (
            <span key={c.key} className="stats-heatmap-cell"
              style={{ background: cellBg(level(c.total)) }}
              title={`${c.key}: ${tp('{n} review', '{n} reviews', c.total)}`} />
          ),
        )}
      </div>
      <div className="stats-heatmap-legend">
        <span>{t('Less')}</span>
        {[0, 1, 2, 3, 4].map((lv) => (
          <span key={lv} className="stats-heatmap-cell" style={{ background: cellBg(lv) }} />
        ))}
        <span>{t('More')}</span>
      </div>
    </div>
  );
}

export function Panel({ title, hint, children }) {
  return (
    <section className="stats-panel">
      <div className="stats-panel-head">
        <h2 className="stats-panel-title">{title}</h2>
        {hint && <p className="stats-panel-hint">{hint}</p>}
      </div>
      {children}
    </section>
  );
}
