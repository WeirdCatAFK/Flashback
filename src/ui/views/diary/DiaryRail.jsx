/**
 * DiaryRail — the Diary's rail: a real month calendar (previous and next month, a year
 * picker, Back to today) where amber is how many reviews you did that day, on the
 * Statistics heatmap's four levels, and a short underline marks a day you wrote on;
 * then what was written that month, each with its first line; and, at the foot, the
 * occasional Rebuild summaries from history — absent while reading someone else's Logs,
 * which are theirs to rebuild.
 */

import { useMemo } from 'react';
import { useT } from '../../translations/index';
import { monthCells, monthRange, stepMonth, writtenIn } from './calendar.js';

/** Monday to Sunday, as the locale writes a weekday's initial (1 Jan 2024 was a Monday). */
/** Six weeks: every month takes the same height, so nothing below the calendar moves as you step through them. */
const GRID_CELLS = 42;

const WEEK = ['2024-01-01', '2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05', '2024-01-06', '2024-01-07'];

function Chevron({ dir }) {
  return (
    <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
      <path d={dir < 0 ? 'M6.5 1.5 3 5l3.5 3.5' : 'M3.5 1.5 7 5 3.5 8.5'} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function DiaryRail({ title, picker, readOnly, days, today, selected, month, onMonth, onSelect, rebuilding, rebuilt, onRebuild }) {
  const { t, tp, locale, formatDay, formatWeekdayNarrow, formatNumber } = useT();
  const range = useMemo(() => monthRange(days, today), [days, today]);
  const { lead, cells } = useMemo(() => monthCells(month.y, month.m, days, { first: range.first, today }), [month, days, range.first, today]);
  const written = useMemo(() => writtenIn(days, month.y, month.m), [days, month]);
  const monthName = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' }).format(Date.UTC(month.y, month.m, 1));
  const atStart = month.y === range.from.y && month.m === range.from.m;
  const atEnd = month.y === range.to.y && month.m === range.to.m;
  const years = [];
  for (let y = range.from.y; y <= range.to.y; y++) years.push(y);
  const dayName = (key) => (key === today ? t('Today') : formatDay(key));
  const shortName = (key) => {
    if (key === today) return t('Today');
    const d = new Date(`${key}T00:00:00Z`);
    return new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(d);
  };

  return (
    <aside className="dy-rail" aria-label={t('Days')}>
      <div className="dy-rail__head">{title}</div>
      {picker}

      <div className="dy-nav">
        <button type="button" className="dy-step" onClick={() => onMonth(stepMonth(month, -1, range.from, range.to))} disabled={atStart} aria-label={t('Previous month')}><Chevron dir={-1} /></button>
        <span className="dy-nav__month">{monthName}</span>
        <select className="dy-nav__year" value={month.y} aria-label={t('Year')} onChange={(e) => onMonth(stepMonth({ y: Number(e.target.value), m: month.m }, 0, range.from, range.to))}>
          {years.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        <button type="button" className="dy-step" onClick={() => onMonth(stepMonth(month, 1, range.from, range.to))} disabled={atEnd} aria-label={t('Next month')}><Chevron dir={1} /></button>
      </div>
      <button type="button" className={`link-action dy-today${atEnd ? ' is-here' : ''}`} onClick={() => onSelect(today)}>{t('Back to today')}</button>

      <div className="dy-month" aria-label={`${monthName} ${month.y}`}>
        <div className="dy-dow" aria-hidden="true">{WEEK.map((k) => <span key={k}>{formatWeekdayNarrow(k)}</span>)}</div>
        <div className="dy-grid">
          {Array.from({ length: lead }, (_, i) => <span key={`pad${i}`} className="dy-cell dy-cell--pad" />)}
          {cells.map((c) => (c.off ? (
            <span key={c.key} className="dy-cell dy-cell--off" aria-hidden="true"><span>{c.n}</span></span>
          ) : (
            <button
              key={c.key}
              type="button"
              className={`dy-cell${c.key === selected ? ' is-selected' : ''}${c.wrote ? ' is-written' : ''}${c.key === today ? ' is-today' : ''}`}
              data-l={c.level}
              aria-label={dayName(c.key)}
              aria-current={c.key === selected ? 'date' : undefined}
              title={`${dayName(c.key)}: ${c.reviews ? tp('{n} review', '{n} reviews', c.reviews, { n: formatNumber(c.reviews) }) : t('no reviews')}${c.wrote ? ` · ${t('something written')}` : ''}`}
              onClick={() => onSelect(c.key)}
            >
              <span>{c.n}</span>
            </button>
          )))}
          {Array.from({ length: GRID_CELLS - lead - cells.length }, (_, i) => <span key={`end${i}`} className="dy-cell dy-cell--pad" />)}
        </div>
        <div className="dy-key" aria-hidden="true">{t('Fewer')}<i data-l="0" /><i data-l="1" /><i data-l="2" /><i data-l="3" /><i data-l="4" />{t('More reviews')}</div>
      </div>

      <div className="dy-label">{t('Written in {month}', { month: monthName })}</div>
      <div className="dy-list">
        {written.length ? written.map((w) => (
          <button key={w.date} type="button" className={`dy-item${w.date === selected ? ' is-selected' : ''}`} onClick={() => onSelect(w.date)}>
            <span className="dy-item__date">{shortName(w.date)}</span>
            <span className="dy-item__text">{w.firstLine}</span>
          </button>
        )) : <p className="dy-none">{t('Nothing written this month.')}</p>}
      </div>

      {!readOnly && <div className="dy-foot">
        <button type="button" className="link-action" onClick={onRebuild} disabled={rebuilding} title={t('Rebuild every day’s summary from your review history')}>
          {rebuilding ? t('Rebuilding…') : t('Rebuild summaries from history')}
        </button>
        {rebuilt && <span className="dy-rebuilt" role="status">{t('Rebuilt from your review history.')}</span>}
      </div>}
    </aside>
  );
}
