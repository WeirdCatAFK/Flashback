/**
 * The diary's data: the dates that have a summary or an entry, and the selected
 * day's summary and reflection. Loads once the tab is first shown; a rebuild
 * re-derives every summary from the review logs.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { listDiary, getSummary, getEntry, rebuildSummaries } from '../../api/diary';
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
  const [loadedOnce, setLoadedOnce] = useState(false);

  const loadDates = useCallback(() => {
    setDatesError(null);
    listDiary().then(setDates).catch((e) => { setDates([]); setDatesError(e); });
  }, []);

  useEffect(() => {
    if (isActive && !loadedOnce) { setLoadedOnce(true); loadDates(); }
  }, [isActive, loadedOnce, loadDates]);

  useEffect(() => {
    if (!loadedOnce) return undefined;
    let ignore = false;
    setSummaryState('loading');
    getSummary(selectedDate)
      .then((s) => { if (!ignore) { setSummary(s); setSummaryState('ready'); } })
      .catch((e) => { if (!ignore) { setSummary(null); setSummaryState(summaryStateFor(e)); } });
    setEntryLoading(true);
    getEntry(selectedDate)
      .then((r) => { if (!ignore) { setEntry(r.content ?? ''); setEntryLoading(false); } })
      .catch(() => { if (!ignore) { setEntry(''); setEntryLoading(false); } });
    return () => { ignore = true; };
  }, [selectedDate, loadedOnce]);

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
