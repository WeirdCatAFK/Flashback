/**
 * The Statistics report's three figures: the forecast (cards due each day, today in the
 * accent), the gap bands (a quiet bar per band with its count and share; a band opens
 * those cards in Flashcards when `onShowBand` is given), and the heatmap (one column per
 * week, four levels of the accent, a day's count in its tooltip).
 */

import { useMemo } from 'react';
import { useT } from '../../translations/index';
import { bandLabel } from '../../gapBands.js';
import { heatDays, bandRows } from './report.js';

export function Forecast({ forecast }) {
  const { t, formatDay, formatWeekdayNarrow } = useT();
  const max = Math.max(1, ...forecast.map((f) => f.due));
  return (
    <div className="sx-bars" role="img" aria-label={t('Cards due each day for the next 14 days')}>
      {forecast.map((f, i) => {
        return (
          <div key={f.date} className={`sx-col${i === 0 ? ' is-today' : ''}`} title={t('{date}: {n} due', { date: formatDay(f.date), n: f.due })}>
            <span className="sx-col__n">{f.due || ''}</span>
            <span className="sx-col__bar"><i style={{ height: `${(f.due / max) * 100}%` }} /></span>
            <span className="sx-col__x">{i === 0 ? t('Today') : formatWeekdayNarrow(f.date)}</span>
          </div>
        );
      })}
    </div>
  );
}

export function Bands({ bands, onShowBand }) {
  const { t, formatNumber } = useT();
  const rows = bandRows(bands);
  return (
    <div className="sx-bands">
      {rows.map((r) => {
        const body = (
          <>
            <span className="sx-band__label">{bandLabel(r.id, t)}</span>
            <span className="sx-band__bar"><i style={{ width: `${r.bar * 100}%` }} /></span>
            <span className="sx-band__n">{formatNumber(r.n)}</span>
            <span className="sx-band__pct">{Math.round(r.share * 100)}%</span>
          </>
        );
        return onShowBand ? (
          <button key={r.id} type="button" className="sx-band" data-band={r.id} title={t('Open these cards in Flashcards')} onClick={() => onShowBand(r.id)}>{body}</button>
        ) : (
          <div key={r.id} className="sx-band" data-band={r.id}>{body}</div>
        );
      })}
    </div>
  );
}

export function Heatmap({ activity }) {
  const { t, tp, formatDay, formatNumber } = useT();
  const days = useMemo(() => heatDays(activity), [activity]);
  return (
    <div className="sx-heat" role="img" aria-label={t('Reviews per day over the last 26 weeks')}>
      {days.map((d) => (
        <span
          key={d.day}
          className={`sx-cell${d.future ? ' is-future' : ''}`}
          data-l={d.level}
          title={d.future ? undefined : `${formatDay(d.day)}: ${tp('{n} review', '{n} reviews', d.total, { n: formatNumber(d.total) })}`}
        />
      ))}
    </div>
  );
}
