/**
 * Diary — the per-day study record, writing first: a rail with a month calendar and what
 * was written (DiaryRail), and the chosen day as a journal page (DiaryPage). Called
 * "Logs" on a shared server, where one history holds several people's prose
 * (diaryLabels.js). Data is in useDiary.js; the calendar's arithmetic in calendar.js.
 *
 * There the Author can also read someone else's Logs: "Logs of" in the rail (or Logs on a
 * person's row in Server Management) picks them, and the page turns read-only. Whose Logs
 * are showing is App.jsx's, like whose progress Statistics shows.
 */

import { useState } from 'react';
import { LoadingState } from '../../components/base/StateView';
import ProgressScopePicker from '../../components/account/ProgressScopePicker';
import { useT } from '../../translations/index';
import { diaryLabels, isSharedVault } from '../../diaryLabels.js';
import { todayIso } from './dates.js';
import { ymOf } from './calendar.js';
import useDiary from './useDiary';
import DiaryRail from './DiaryRail';
import DiaryPage from './DiaryPage';
import './Diary.css';

/** How long "Rebuilt from your review history" stays after a rebuild. */
const REBUILT_MS = 2400;

export default function DiaryView({ isActive, connection, writeRequest = 0, viewingAccount = null, onViewingAccountChange }) {
  const { t } = useT();
  const shared = isSharedVault(connection);
  const labels = diaryLabels(t, shared);
  const reading = shared ? viewingAccount : null;
  const d = useDiary(isActive, reading);
  const { today, selectedDate, setSelectedDate, dates, railDates, summaryState, summary, entryLoading, entry, rebuilding, onEntrySaved } = d;
  const [month, setMonth] = useState(() => ymOf(today));
  const [rebuilt, setRebuilt] = useState(false);

  const yesterday = (() => { const x = new Date(); x.setDate(x.getDate() - 1); return todayIso(x); })();

  const [seenWriteRequest, setSeenWriteRequest] = useState(0);
  const [editToken, setEditToken] = useState(0);
  if (seenWriteRequest !== writeRequest) {
    setSeenWriteRequest(writeRequest);
    if (writeRequest) {
      setSelectedDate(today);
      setMonth(ymOf(today));
      setEditToken((n) => n + 1);
    }
  }

  const select = (key) => { setSelectedDate(key); setMonth(ymOf(key)); };
  const rebuild = async () => {
    await d.rebuild();
    setRebuilt(true);
    setTimeout(() => setRebuilt(false), REBUILT_MS);
  };

  const picker = shared && onViewingAccountChange && (
    <ProgressScopePicker className="dy-whose" capability="readAllLogs" label={t('Logs of')} everyone
      value={viewingAccount} onChange={onViewingAccountChange} />
  );

  if (dates === null) return <LoadingState message={labels.loading} />;

  return (
    <div className="diary">
      <DiaryRail
        title={labels.title}
        picker={picker}
        readOnly={!!reading}
        days={railDates}
        today={today}
        selected={selectedDate}
        month={month}
        onMonth={setMonth}
        onSelect={select}
        rebuilding={rebuilding}
        rebuilt={rebuilt}
        onRebuild={rebuild}
      />
      <main className="diary-main">
        <DiaryPage
          date={selectedDate}
          today={today}
          yesterday={yesterday}
          shared={shared}
          reader={reading?.name ?? null}
          summaryState={summaryState}
          summary={summary}
          entryLoading={entryLoading}
          entry={entry}
          onSaved={onEntrySaved}
          editRequest={editToken}
        />
      </main>
    </div>
  );
}
