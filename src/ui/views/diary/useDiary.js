/**
 * The diary's data: the dates that have a summary or an entry, and the selected
 * day's summary and reflection. Every time the tab is shown, today is re-derived
 * from the whole day's review log (a rebuild limited to one day), so a second
 * session shows up whether or not the Trainer recorded it; other days are read as
 * stored. A rebuild re-derives every summary.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { listDiary, getSummary, getEntry, rebuildSummaries, generateSummary } from '../../api/diary';
import { todayIso, withToday } from './dates.js';

const summaryStateFor = (err) => (err?.status === 404 ? 'none' : 'error');

export default function useDiary(isActive) {
  const today = useMemo(() => todayIso(), []);
  const [selectedDate, setSelectedDate] = useState(today);
  const [dates, setDates] = useState(null);
  const [datesError, setDatesError] = useState(null);
  const [summaryState, setSummaryState] = useState('loading');
  const [summary, setSummary] = useState(null);
  const [entryLoading, setEntryLoading] = useState(true);
  const [entry, setEntry] = useState('');
  const [rebuilding, setRebuilding] = useState(false);
  const [visit, setVisit] = useState(0);

  const [wasActive, setWasActive] = useState(false);
  if (wasActive !== isActive) {
    setWasActive(isActive);
    if (isActive) setVisit((n) => n + 1);
  }

  const loadDates = useCallback(() => {
    setDatesError(null);
    listDiary().then(setDates).catch((e) => { setDates([]); setDatesError(e); });
  }, []);

  useEffect(() => {
    if (!visit) return undefined;
    let ignore = false;
    setSummaryState('loading');
    const read = selectedDate === today
      ? generateSummary(today).then((r) => {
          if (!r?.summary) throw Object.assign(new Error('no summary'), { status: 404 });
          return r.summary;
        })
      : getSummary(selectedDate);
    read
      .then((s) => { if (!ignore) { setSummary(s); setSummaryState('ready'); } })
      .catch((e) => { if (!ignore) { setSummary(null); setSummaryState(summaryStateFor(e)); } })
      .finally(() => { if (!ignore) loadDates(); });
    setEntryLoading(true);
    getEntry(selectedDate)
      .then((r) => { if (!ignore) { setEntry(r.content ?? ''); setEntryLoading(false); } })
      .catch(() => { if (!ignore) { setEntry(''); setEntryLoading(false); } });
    return () => { ignore = true; };
  }, [selectedDate, visit, today, loadDates]);

  const onEntrySaved = useCallback((date, content) => {
    setEntry(content);
    loadDates();
  }, [loadDates]);

  const rebuild = useCallback(async () => {
    setRebuilding(true);
    try {
      await rebuildSummaries();
      loadDates();
      try {
        setSummary(await getSummary(selectedDate));
        setSummaryState('ready');
      } catch (e) {
        setSummary(null);
        setSummaryState(summaryStateFor(e));
      }
    } finally {
      setRebuilding(false);
    }
  }, [loadDates, selectedDate]);

  return {
    today, selectedDate, setSelectedDate, dates, datesError, summaryState, summary, entryLoading, entry, rebuilding,
    railDates: useMemo(() => withToday(dates, today), [dates, today]),
    onEntrySaved, rebuild,
  };
}
