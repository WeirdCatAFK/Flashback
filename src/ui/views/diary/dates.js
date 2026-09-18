/**
 * Diary date keys. They are the user's LOCAL calendar day, matching the server's
 * date(timestamp, 'localtime') bucketing — toISOString() would open tomorrow's
 * empty page for anyone studying in the evening west of Greenwich.
 */

export const todayIso = (d = new Date()) => {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export const pct = (r) => (r == null ? '—' : `${Math.round(r * 100)}%`);

/** A human date from a 'YYYY-MM-DD' key, parsed as UTC to match the key, in the chosen locale. */
export const fmtDate = (iso, locale) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString(locale, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });

/** The rail always shows today, even before it has a summary or an entry. */
export function withToday(dates, today) {
  const list = dates ?? [];
  if (list.some((d) => d.date === today)) return list;
  return [{ date: today, hasSummary: false, hasEntry: false }, ...list];
}
