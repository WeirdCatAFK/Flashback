import { useState, useEffect, useCallback, useMemo } from "react";
import "./Stats.css";
import { getStatistics } from "../api/srs";
import { LoadingState, ErrorState } from "../components/shared/StateView";

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

const DAY = 86400000;
const WEEKS = 26; // half-year activity window shown in the heatmap

// A sequential accent ramp step: mixes the accent over the surface so it reads
// light→dark in both light and dark themes without hardcoding a colour.
const ramp = (pct) =>
  `color-mix(in srgb, var(--color-accent) ${pct}%, var(--color-bg-surface))`;

const pctText = (r) => (r == null ? "—" : `${Math.round(r * 100)}%`);
const num = (n) => (n ?? 0).toLocaleString();

// ── Headline tiles ────────────────────────────────────────────────────────────

function StatTile({ label, value, sub }) {
  return (
    <div className="stats-tile">
      <div className="stats-tile-value">{value}</div>
      <div className="stats-tile-label">{label}</div>
      {sub && <div className="stats-tile-sub">{sub}</div>}
    </div>
  );
}

// ── Card maturity (stacked bar) ───────────────────────────────────────────────

function MaturityBar({ maturity }) {
  const { new: neu, young, mature } = maturity;
  const total = neu + young + mature;
  const segments = [
    { key: "mature", label: "Mature", count: mature, hint: "Interval ≥ 21 days", fill: ramp(85) },
    { key: "young", label: "Young", count: young, hint: "Reviewed, interval < 21 days", fill: ramp(40) },
    { key: "new", label: "New", count: neu, hint: "Not yet reviewed", fill: ramp(12) },
  ];

  if (total === 0) {
    return <p className="stats-empty-inline">No cards yet.</p>;
  }

  return (
    <div className="stats-maturity">
      <div className="stats-maturity-track" role="img"
        aria-label={`Card maturity: ${mature} mature, ${young} young, ${neu} new`}>
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
            <span className="stats-legend-count">{num(s.count)}</span>
            <span className="stats-legend-hint">{s.hint}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Due forecast (bar chart, next 14 days) ────────────────────────────────────

function ForecastChart({ forecast, overdue }) {
  const max = Math.max(1, ...forecast.map((f) => f.due));
  const totalDue = forecast.reduce((a, f) => a + f.due, 0);

  const dow = (iso) => {
    const d = new Date(iso + "T00:00:00Z");
    return ["S", "M", "T", "W", "T", "F", "S"][d.getUTCDay()];
  };

  if (totalDue === 0 && overdue === 0) {
    return <p className="stats-empty-inline">Nothing scheduled — you&rsquo;re all caught up.</p>;
  }

  return (
    <div className="stats-forecast">
      {overdue > 0 && (
        <p className="stats-overdue">
          <strong>{num(overdue)}</strong> card{overdue === 1 ? "" : "s"} overdue
        </p>
      )}
      <div className="stats-forecast-bars">
        {forecast.map((f, i) => (
          <div key={f.date} className="stats-forecast-col"
            title={`${f.date}: ${f.due} due`}>
            <div className="stats-forecast-count">{f.due > 0 ? f.due : ""}</div>
            <div className="stats-forecast-bar-wrap">
              <div className="stats-forecast-bar"
                style={{ height: `${(f.due / max) * 100}%`, background: ramp(f.due > 0 ? 70 : 0) }} />
            </div>
            <div className={`stats-forecast-x${i === 0 ? " is-today" : ""}`}>
              {i === 0 ? "Today" : dow(f.date)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Activity heatmap (last 26 weeks) ──────────────────────────────────────────

function ActivityHeatmap({ activity }) {
  const { cells, max } = useMemo(() => {
    const byDay = new Map(activity.map((a) => [a.day, a.total]));
    const now = new Date();
    const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    // Start on the Monday on/before the first day of the window.
    let startMs = todayMs - (WEEKS * 7 - 1) * DAY;
    const startDow = (new Date(startMs).getUTCDay() + 6) % 7; // 0 = Mon
    startMs -= startDow * DAY;

    const dayStr = (ms) => new Date(ms).toISOString().slice(0, 10);
    const grid = [];
    let peak = 0;
    for (let ms = startMs; ms <= todayMs; ms += DAY) {
      const key = dayStr(ms);
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
              title={`${c.key}: ${c.total} review${c.total === 1 ? "" : "s"}`} />
          ),
        )}
      </div>
      <div className="stats-heatmap-legend">
        <span>Less</span>
        {[0, 1, 2, 3, 4].map((lv) => (
          <span key={lv} className="stats-heatmap-cell" style={{ background: cellBg(lv) }} />
        ))}
        <span>More</span>
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

const ALGO_LABEL = { leitner: "Leitner", sm2: "SM-2", fsrs: "FSRS" };

export default function Stats({ isActive }) {
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
          <h1 className="stats-title">Statistics</h1>
          <p className="stats-lede">
            How your vault is progressing
            {stats && <> · scheduled with <strong>{ALGO_LABEL[stats.algorithm] ?? stats.algorithm}</strong></>}.
          </p>
        </header>

        {firstLoad ? (
          <LoadingState message="Crunching your review history…" />
        ) : error && !stats ? (
          <ErrorState error={error} onRetry={reload} />
        ) : stats && stats.totals.cards === 0 && stats.totals.reviews === 0 ? (
          <p className="stats-empty">
            No cards or reviews yet. Create some flashcards and study them in the
            Trainer — your progress will show up here.
          </p>
        ) : stats ? (
          <>
            <div className="stats-tiles">
              <StatTile label="Cards" value={num(stats.totals.cards)}
                sub={`${num(stats.maturity.mature)} mature`} />
              <StatTile label="Reviews" value={num(stats.totals.reviews)}
                sub={stats.totals.reviewsToday > 0 ? `${num(stats.totals.reviewsToday)} today` : "none today"} />
              <StatTile label="Retention" value={pctText(stats.totals.retentionAll)}
                sub={`${pctText(stats.totals.retention30)} last 30 days`} />
              <StatTile label="Streak" value={`${num(stats.streak.current)}d`}
                sub={`best ${num(stats.streak.longest)}d`} />
            </div>

            <Panel title="Review activity" hint="Reviews per day over the last 26 weeks.">
              <ActivityHeatmap activity={stats.activity} />
            </Panel>

            <div className="stats-two-col">
              <Panel title="Due forecast" hint="Cards coming up over the next two weeks.">
                <ForecastChart forecast={stats.forecast} overdue={stats.overdue} />
              </Panel>
              <Panel title="Card maturity">
                <MaturityBar maturity={stats.maturity} />
              </Panel>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
