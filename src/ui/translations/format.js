const LADDER = [
  ['year',   31_536_000, 29_030_400],
  ['month',   2_592_000,  2_246_400],
  ['day',        86_400,     79_200],
  ['hour',        3_600,      2_700],
  ['minute',         60,         45],
  ['second',          1,          0],
];

/** SQLite writes UTC as "YYYY-MM-DD HH:MM:SS" with no zone marker, so this adds a Z. Parsed raw, it reads as local time. */
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
  const time     = new Intl.DateTimeFormat(locale, { timeStyle: 'short' });
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

  const formatTime = (value) => {
    const d = toDate(value);
    return d ? time.format(d) : '';
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

  return { formatDate, formatDateTime, formatTime, formatDay, formatRelative, formatNumber, formatWeekdayNarrow };
}
