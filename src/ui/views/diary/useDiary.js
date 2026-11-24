import { useState, useEffect, useCallback, useMemo } from 'react';
import { listDiary, getSummary, getEntry, rebuildSummaries, generateSummary } from '../../api/diary';
import { getAccountLogs, getAccountLogSummary } from '../../api/accounts';
import { todayIso, withToday } from './dates.js';

const summaryStateFor = (err) => (err?.status === 404 ? 'none' : 'error');

const readersFor = (accountId) => (accountId
  ? {
      list: () => getAccountLogs(accountId),
      summary: (date) => getAccountLogSummary(accountId, date),
    }
  : { list: listDiary, summary: getSummary, entry: getEntry });

export default function useDiary(isActive, account = null) {
  const accountId = account?.id ?? null;
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

  const read = useMemo(() => readersFor(accountId), [accountId]);

  const [seenAccount, setSeenAccount] = useState(accountId);
  if (seenAccount !== accountId) {
    setSeenAccount(accountId);
    setDates(null);
    setSummary(null);
    setEntry('');
  }

  const loadDates = useCallback(() => {
    setDatesError(null);
    read.list().then(setDates).catch((e) => { setDates([]); setDatesError(e); });
  }, [read]);

  useEffect(() => {
    if (!visit) return undefined;
    let ignore = false;
    setSummaryState('loading');
    const day = selectedDate === today && !accountId
      ? generateSummary(today).then((r) => {
          if (!r?.summary) throw Object.assign(new Error('no summary'), { status: 404 });
          return r.summary;
        })
      : read.summary(selectedDate);
    day
      .then((s) => { if (!ignore) { setSummary(s); setSummaryState('ready'); } })
      .catch((e) => { if (!ignore) { setSummary(null); setSummaryState(summaryStateFor(e)); } })
      .finally(() => { if (!ignore) loadDates(); });
    if (read.entry) {
      setEntryLoading(true);
      read.entry(selectedDate)
        .then((r) => { if (!ignore) { setEntry(r.content ?? ''); setEntryLoading(false); } })
        .catch(() => { if (!ignore) { setEntry(''); setEntryLoading(false); } });
    }
    return () => { ignore = true; };
  }, [selectedDate, visit, today, loadDates, read, accountId]);

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
