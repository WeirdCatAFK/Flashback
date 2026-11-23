import { heatLevel } from '../../utils/activityLevel.js';

const pad = (n) => String(n).padStart(2, '0');
export const keyOf = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
export const ymOf = (key) => ({ y: Number(key.slice(0, 4)), m: Number(key.slice(5, 7)) - 1 });

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

export function monthRange(days, today) {
  const keys = (days ?? []).map((d) => d.date).filter(Boolean).sort();
  const first = keys[0] && keys[0] < today ? keys[0] : today;
  return { first, from: ymOf(first), to: ymOf(today) };
}

export function stepMonth({ y, m }, step, from, to) {
  const t = y * 12 + m + step;
  const lo = from.y * 12 + from.m, hi = to.y * 12 + to.m;
  const c = Math.min(hi, Math.max(lo, t));
  return { y: Math.floor(c / 12), m: c % 12 };
}

export function writtenIn(days, year, month) {
  const prefix = keyOf(year, month, 1).slice(0, 7);
  return (days ?? [])
    .filter((d) => d.hasEntry && d.date.startsWith(prefix))
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .map((d) => ({ date: d.date, firstLine: d.firstLine ?? '' }));
}
