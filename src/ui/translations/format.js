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
  ['year',   31_536_000, 29_030_400], // >= ~11 months
  ['month',   2_592_000,  2_246_400], // >= 26 days
  ['day',        86_400,     79_200], // >= 22 hours
  ['hour',        3_600,      2_700], // >= 45 minutes
  ['minute',         60,         45], // >= 45 seconds
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
  // UTC because its only caller keys off bare ISO days, which are calendar dates
  // rather than instants — reading them locally shifts the weekday west of Greenwich.
  const weekdayNarrow = new Intl.DateTimeFormat(locale, { weekday: 'narrow', timeZone: 'UTC' });
  // numeric:'auto' is what turns +1 day into "tomorrow" and 0 seconds into "now".
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });

  /** "12 Aug 2026" — null-safe, returns '' for unreadable input. */
  const formatDate = (value) => {
    const d = toDate(value);
    return d ? date.format(d) : '';
  };

  /** "12 Aug 2026, 14:30" */
  const formatDateTime = (value) => {
    const d = toDate(value);
    return d ? dateTime.format(d) : '';
  };

  /**
   * "Saturday, 8 August 2026" from a bare ISO day ("2026-08-08"), read as UTC so
   * the calendar date never slips a day west of Greenwich. For the Diary, whose
   * records are keyed by day rather than instant.
   */
  const formatDay = (isoDay) => {
    const d = toDate(typeof isoDay === 'string' && !isoDay.includes('T')
      ? `${isoDay}T00:00:00Z`
      : isoDay);
    return d ? dayLong.format(d) : '';
  };

  /**
   * Signed relative time in the active language: past reads "2 days ago", future
   * reads "in 3 hours" / "tomorrow". Replaces both hand-rolled ladders, and needs
   * no plural handling — Intl applies the target language's own plural rules.
   *
   * `maxUnit` caps how coarse the answer may get. The default ladder is idiomatic
   * but lossy at range — 40 days becomes "next month" — which is wrong for an SRS
   * interval, where the user is asking exactly how far out the card is. Those call
   * sites pass { maxUnit: 'day' } and get "in 40 days".
   */
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
    /* 'second' has minimum 0, so the loop only falls through on an unknown maxUnit. */
    return relative.format(Math.round(seconds), 'second');
  };

  const formatNumber = (n) => number.format(n ?? 0);

  /**
   * A single-letter weekday ("M", "L", "月") for dense axes like the Stats heatmap,
   * which previously indexed a hardcoded English ["S","M","T",…] array.
   */
  const formatWeekdayNarrow = (isoDay) => {
    const d = toDate(typeof isoDay === 'string' && !isoDay.includes('T')
      ? `${isoDay}T00:00:00Z`
      : isoDay);
    return d ? weekdayNarrow.format(d) : '';
  };

  return { formatDate, formatDateTime, formatDay, formatRelative, formatNumber, formatWeekdayNarrow };
}
