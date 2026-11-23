import { GAP_BANDS } from '../../../shared/intervals.js';
import { heatLevel } from '../../utils/activityLevel.js';

export { heatLevel };

export const HEAT_WEEKS = 26;

const pad = (n) => String(n).padStart(2, '0');
export const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

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

export function bandRows(bands) {
  const counts = GAP_BANDS.map((b) => ({ id: b.id, n: bands?.[b.id] ?? 0 }));
  const total = counts.reduce((a, r) => a + r.n, 0);
  const max = Math.max(0, ...counts.map((r) => r.n));
  return counts.map((r) => ({ ...r, share: total ? r.n / total : 0, bar: max ? r.n / max : 0 }));
}

export const forecastTotal = (forecast) => (forecast ?? []).reduce((a, f) => a + (f.due ?? 0), 0);
