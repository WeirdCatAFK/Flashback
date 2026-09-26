/**
 * The Statistics report's arithmetic, as plain functions: the heatmap's days laid out
 * as week columns, each at one of four levels; the gap bands as rows with their share;
 * and the forecast's total. No React, no DOM, so `node --test` loads it as is.
 */

import { GAP_BANDS } from '../../../shared/intervals.js';
import { heatLevel } from '../../activityLevel.js';

export { heatLevel };

/** How many weeks the heatmap covers. */
export const HEAT_WEEKS = 26;

const pad = (n) => String(n).padStart(2, '0');
/** A local date as `YYYY-MM-DD`, the key the activity rows use. */
export const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * The heatmap's cells: `HEAT_WEEKS` columns of seven days, Monday first, ending with
 * the week that holds `today`. Days after today are `future` and drawn empty.
 * @param {Array<{ day: string, total: number }>} activity
 */
export function heatDays(activity, today = new Date()) {
  const byDay = new Map((activity ?? []).map((a) => [a.day, a.total]));
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const mondayOffset = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - mondayOffset - (HEAT_WEEKS - 1) * 7);
  const todayKey = dayKey(today);
  const days = [];
  let future = false;
  for (let i = 0; i < HEAT_WEEKS * 7; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const key = dayKey(d);
    days.push({ day: key, date: d, total: future ? 0 : byDay.get(key) ?? 0, future });
    if (key === todayKey) future = true;
  }
  const max = Math.max(0, ...days.map((d) => d.total));
  return days.map((d) => ({ ...d, level: heatLevel(d.total, max) }));
}

/** The gap bands as rows, in order: count, share of all cards, and share of the fullest band (the bar). */
export function bandRows(bands) {
  const counts = GAP_BANDS.map((b) => ({ id: b.id, n: bands?.[b.id] ?? 0 }));
  const total = counts.reduce((a, r) => a + r.n, 0);
  const max = Math.max(0, ...counts.map((r) => r.n));
  return counts.map((r) => ({ ...r, share: total ? r.n / total : 0, bar: max ? r.n / max : 0 }));
}

/** Cards due over the whole forecast. */
export const forecastTotal = (forecast) => (forecast ?? []).reduce((a, f) => a + (f.due ?? 0), 0);
