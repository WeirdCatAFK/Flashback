/** The local calendar day, as the server buckets it with date(timestamp, 'localtime'). Never use toISOString(), which gives the UTC day. */
export const todayIso = (d = new Date()) => {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export const pct = (r) => (r == null ? '—' : `${Math.round(r * 100)}%`);

export function withToday(dates, today) {
  const list = dates ?? [];
  if (list.some((d) => d.date === today)) return list;
  return [{ date: today, hasSummary: false, hasEntry: false, reviews: 0, firstLine: null }, ...list];
}
