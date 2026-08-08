import { useState, useEffect, useCallback, useMemo } from "react";
import "./Stats.css";
import { getStatistics } from "../api/srs";
import { LoadingState, ErrorState } from "../components/shared/StateView";
import { ramp } from "../utils/chartRamp";
import { useT } from "../translations";

/**
 * Stats — read-only, vault-wide study analytics. Everything here is derived from
 * the SRS state and ReviewLogs (no writes). Interval/maturity/next-due depend on
 * the scheduler, so the view reports against the user's active algorithm (the same
 * `fb-srs-algorithm` preference the Trainer uses).
 *
 * Visual language (per the project's design tokens): a single accent hue used as a
 * sequential ramp — light → dark encodes magnitude (heatmap intensity, card
 * maturity). Text always wears the ink tokens, never the accent, so identity is
 * never colour-alone.
 */

const WEEKS = 26; // half-year activity window shown in the heatmap

const pctText = (r) => (r == null ? "—" : `${Math.round(r * 100)}%`);
const oneDp = (n) => (n == null ? "—" : n.toFixed(1));
// Counts go through formatNumber (from useT) rather than a bare toLocaleString, so
// grouping follows the chosen language instead of the browser's own locale.

// ── Headline tiles ────────────────────────────────────────────────────────────

function StatTile({ label, value, sub, title }) {
  return (
    <div className="stats-tile" title={title}>
      <div className="stats-tile-value">{value}</div>
      <div className="stats-tile-label">{label}</div>
      {sub && <div className="stats-tile-sub">{sub}</div>}
    </div>
  );
}

// ── Acquisition (learning-phase measures) ─────────────────────────────────────

// Retention answers "is what I learned staying?", which only means anything once a
// card is actually learned. These are the other half: how new material lands while
// it is still being acquired.
function AcquisitionPanel({ acquisition }) {
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
          <div className="stats-tile-sub">{m.sub}</div>
          <div className="stats-metric-hint">{m.hint}</div>
        </div>
      ))}
    </div>
  );
}

// ── Card maturity (stacked bar) ───────────────────────────────────────────────

function MaturityBar({ maturity }) {
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

// ── Due forecast (bar chart, next 14 days) ────────────────────────────────────

function ForecastChart({ forecast, overdue }) {
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

// ── Activity heatmap (last 26 weeks) ──────────────────────────────────────────

function ActivityHeatmap({ activity }) {
  const { t, tp } = useT();
  const { cells, max } = useMemo(() => {
    const byDay = new Map(activity.map((a) => [a.day, a.total]));
    // `activity[].day` keys are local calendar days (the server buckets with
    // date(timestamp, 'localtime')), so the grid has to be walked in local days too —
    // stepping in fixed 24h increments from a UTC midnight would offset every key by
    // one cell for anyone not on UTC.
    const now = new Date();
    const dayAt = (offset) =>
      new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    const pad = (n) => String(n).padStart(2, "0");
    const dayStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

    // Start on the Monday on/before the first day of the window.
    let startOffset = -(WEEKS * 7 - 1);
    startOffset -= (dayAt(startOffset).getDay() + 6) % 7; // 0 = Mon

    const grid = [];
    let peak = 0;
    for (let offset = startOffset; offset <= 0; offset++) {
      const key = dayStr(dayAt(offset));
      const total = byDay.get(key) ?? 0;
      if (total > peak) peak = total;
      grid.push({ key, total, future: false });
    }
    // Pad the final (partial) week so the grid stays 7 rows tall.
    while (grid.length % 7 !== 0) grid.push({ key: `pad-${grid.length}`, total: 0, future: true });
    return { cells: grid, max: peak };
  }, [activity]);

  // Quartile buckets → ramp step. 0 reviews reads as an empty (neutral) cell.
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

// ── Panel wrapper ─────────────────────────────────────────────────────────────

function Panel({ title, hint, children }) {
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

// ── View ──────────────────────────────────────────────────────────────────────

// Scheduler names are proper nouns and stay as-is in every language.
const ALGO_LABEL = { leitner: "Leitner", sm2: "SM-2", fsrs: "FSRS" };

export default function Stats({ isActive }) {
  const { t, formatNumber } = useT();
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const reload = useCallback(() => {
    const algorithm = localStorage.getItem("fb-srs-algorithm") ?? "sm2";
    setLoading(true);
    getStatistics(algorithm)
      .then((s) => { setStats(s); setError(null); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  // Reviewing in the Trainer changes these numbers, so re-pull whenever the tab
  // regains focus rather than caching once on mount.
  useEffect(() => { if (isActive) reload(); }, [isActive, reload]);

  const firstLoad = loading && !stats;

  return (
    <div className="stats-view">
      <div className="stats-body">
        <header className="stats-header">
          <h1 className="stats-title">{t('Statistics')}</h1>
          <p className="stats-lede">
            {t('How your vault is progressing')}
            {stats && <> · {t('scheduled with {algorithm}', { algorithm: ALGO_LABEL[stats.algorithm] ?? stats.algorithm })}</>}.
          </p>
        </header>

        {firstLoad ? (
          <LoadingState message={t('Crunching your review history…')} />
        ) : error && !stats ? (
          <ErrorState error={error} onRetry={reload} />
        ) : stats && stats.totals.cards === 0 && stats.totals.reviews === 0 ? (
          <p className="stats-empty">
            {t('No cards or reviews yet. Create some flashcards and study them in the Trainer — your progress will show up here.')}
          </p>
        ) : stats ? (
          <>
            <div className="stats-tiles">
              <StatTile label={t('Cards')} value={formatNumber(stats.totals.cards)}
                sub={t('{n} mature', { n: formatNumber(stats.maturity.mature) })} />
              <StatTile label={t('Reviews')} value={formatNumber(stats.totals.reviews)}
                sub={stats.totals.reviewsToday > 0
                  ? t('{n} today', { n: formatNumber(stats.totals.reviewsToday) })
                  : t('none today')} />
              <StatTile label={t('Retention')} value={pctText(stats.totals.retentionAll)}
                sub={t('{pct} last 30 days', { pct: pctText(stats.totals.retention30) })}
                title={t('Measured on {reviews} reviews of cards past their learning phase — a card’s first {learning} reviews are counted as acquisition instead.',
                  { reviews: formatNumber(stats.totals.retentionReviews), learning: stats.acquisition.learningReviews })} />
              <StatTile label={t('Streak')} value={t('{n}d', { n: formatNumber(stats.streak.current) })}
                sub={t('best {n}d', { n: formatNumber(stats.streak.longest) })} />
            </div>

            <Panel
              title={t('Acquisition')}>
              <AcquisitionPanel acquisition={stats.acquisition} />
            </Panel>

            <Panel title={t('Review activity')} hint={t('Reviews per day over the last 26 weeks.')}>
              <ActivityHeatmap activity={stats.activity} />
            </Panel>

            <div className="stats-two-col">
              <Panel title={t('Due forecast')} hint={t('Cards coming up over the next two weeks.')}>
                <ForecastChart forecast={stats.forecast} overdue={stats.overdue} />
              </Panel>
              <Panel title={t('Card maturity')}>
                <MaturityBar maturity={stats.maturity} />
              </Panel>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
