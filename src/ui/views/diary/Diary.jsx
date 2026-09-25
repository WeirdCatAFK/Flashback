/**
 * Diary — the per-day study record, writing first: a rail with a month calendar and what
 * was written (DiaryRail), and the chosen day as a journal page (DiaryPage). Called
 * "Logs" on a shared server, where one history holds several people's prose
 * (diaryLabels.js). Data is in useDiary.js; the calendar's arithmetic in calendar.js.
 */

import { useState } from 'react';
import { LoadingState } from '../../components/base/StateView';
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

export default function DiaryView({ isActive, connection, writeRequest = 0 }) {
  const { t } = useT();
  const shared = isSharedVault(connection);
  const labels = diaryLabels(t, shared);
  const d = useDiary(isActive);
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

  if (dates === null) return <LoadingState message={labels.loading} />;

  return (
    <div className="diary">
      <DiaryRail
        title={labels.title}
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
