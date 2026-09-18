/**
 * Locale-aware date/number formatting. Reached through useT():
 *
 *   const { formatDate, formatRelative, formatNumber } = useT();
 *
 * Everything here is built on Intl, which means the relative ladder ("2 days ago",
 * "tomorrow", "in 3 hours") is produced by the platform in the active language.
 * That is the point: the ladders this replaces spelled those words in English in
 * our own source, so they could not be translated without a key per rung.
 *
 * Deliberately free of any dependency on ./index.jsx — no t() is needed here, so
 * there is no import cycle between the provider and its own formatters.
 *
 * Replaced the old utils/relativeTime.js (past-only, English, hardcoded
 * toLocaleDateString) and the future-facing ladder inlined in Trainer.jsx; that
 * module is gone now that its last callers went through here.
 */

/**
 * Largest-first: [unit, seconds per unit, minimum magnitude to use that unit].
 * The first row whose minimum the gap reaches wins, so 'second' (minimum 0) is
 * always the terminating case.
 */
const LADDER = [
  ['year',   31_536_000, 29_030_400],
  ['month',   2_592_000,  2_246_400],
  ['day',        86_400,     79_200],
  ['hour',        3_600,      2_700],
  ['minute',         60,         45],
  ['second',          1,          0],
];

/**
 * Accepts a Date, epoch ms, an ISO string, or SQLite's "YYYY-MM-DD HH:MM:SS" (which
 * is UTC but carries no zone marker — parsing it raw makes it local and silently
 * shifts every timestamp). Returns null when the value can't be read as a date.
 */
export function toDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value !== 'string') return null;

  const iso = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function makeFormatters(locale) {
  const date     = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  const dayLong  = new Intl.DateTimeFormat(locale, {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
  });
  const number   = new Intl.NumberFormat(locale);
  const weekdayNarrow = new Intl.DateTimeFormat(locale, { weekday: 'narrow', timeZone: 'UTC' });
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });

  const formatDate = (value) => {
    const d = toDate(value);
    return d ? date.format(d) : '';
  };

  const formatDateTime = (value) => {
    const d = toDate(value);
    return d ? dateTime.format(d) : '';
  };

  const formatDay = (isoDay) => {
    const d = toDate(typeof isoDay === 'string' && !isoDay.includes('T')
      ? `${isoDay}T00:00:00Z`
      : isoDay);
    return d ? dayLong.format(d) : '';
  };

  const formatRelative = (value, { maxUnit } = {}) => {
    const d = toDate(value);
    if (!d) return '';
    const seconds = (d.getTime() - Date.now()) / 1000;
    const magnitude = Math.abs(seconds);

    const start = maxUnit ? LADDER.findIndex(([unit]) => unit === maxUnit) : 0;
    const ladder = start > 0 ? LADDER.slice(start) : LADDER;

    for (const [unit, perUnit, minimum] of ladder) {
      if (magnitude < minimum) continue;
      return relative.format(Math.round(seconds / perUnit), unit);
    }
    return relative.format(Math.round(seconds), 'second');
  };

  const formatNumber = (n) => number.format(n ?? 0);

  const formatWeekdayNarrow = (isoDay) => {
    const d = toDate(typeof isoDay === 'string' && !isoDay.includes('T')
      ? `${isoDay}T00:00:00Z`
      : isoDay);
    return d ? weekdayNarrow.format(d) : '';
  };

  return { formatDate, formatDateTime, formatDay, formatRelative, formatNumber, formatWeekdayNarrow };
}
