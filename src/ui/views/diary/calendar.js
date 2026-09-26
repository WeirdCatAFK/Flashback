/**
 * The Diary rail's month, as plain functions: the days of a month laid out Monday
 * first, each with how busy it was (the Statistics heatmap's four levels) and whether
 * something was written on it; which months can be shown; and what was written in one.
 * Dates are `YYYY-MM-DD` keys in the user's local calendar. No React, no DOM.
 */

import { heatLevel } from '../../activityLevel.js';

const pad = (n) => String(n).padStart(2, '0');
export const keyOf = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
export const ymOf = (key) => ({ y: Number(key.slice(0, 4)), m: Number(key.slice(5, 7)) - 1 });

/**
 * One month's cells: `lead` blanks before the 1st (Monday first), then every day with
 * its key, level and whether it has an entry. `off` marks a day outside the range the
 * diary covers (before the first recorded day, or after today).
 * @param {Array<{ date: string, reviews?: number, hasEntry?: boolean }>} days
 */
export function monthCells(year, month, days, { first, today }) {
  const byKey = new Map((days ?? []).map((d) => [d.date, d]));
  const max = Math.max(0, ...(days ?? []).map((d) => d.reviews ?? 0));
  const lead = (new Date(year, month, 1).getDay() + 6) % 7;
  const count = new Date(year, month + 1, 0).getDate();
  const cells = [];
  for (let n = 1; n <= count; n++) {
    const key = keyOf(year, month, n);
    const d = byKey.get(key);
    cells.push({
      key, n,
      level: heatLevel(d?.reviews ?? 0, max),
      reviews: d?.reviews ?? 0,
      wrote: !!d?.hasEntry,
      off: key < first || key > today,
    });
  }
  return { lead, cells };
}

/** The first and last months the rail can show: the earliest recorded day's, and today's. */
export function monthRange(days, today) {
  const keys = (days ?? []).map((d) => d.date).filter(Boolean).sort();
  const first = keys[0] && keys[0] < today ? keys[0] : today;
  return { first, from: ymOf(first), to: ymOf(today) };
}

/** A month moved by `step`, kept within [from, to]. */
export function stepMonth({ y, m }, step, from, to) {
  const t = y * 12 + m + step;
  const lo = from.y * 12 + from.m, hi = to.y * 12 + to.m;
  const c = Math.min(hi, Math.max(lo, t));
  return { y: Math.floor(c / 12), m: c % 12 };
}

/** What was written in one month, newest first: `{ date, firstLine }`. */
export function writtenIn(days, year, month) {
  const prefix = keyOf(year, month, 1).slice(0, 7);
  return (days ?? [])
    .filter((d) => d.hasEntry && d.date.startsWith(prefix))
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .map((d) => ({ date: d.date, firstLine: d.firstLine ?? '' }));
}
