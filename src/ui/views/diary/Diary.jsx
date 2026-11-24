import { useState } from 'react';
import { LoadingState } from '../../components/base/StateView';
import ProgressScopePicker from '../../components/account/ProgressScopePicker';
import { useT } from '../../translations/index';
import { diaryLabels, isSharedVault } from '../../utils/diaryLabels.js';
import { exportEntries } from '../../api/diary';
import { downloadBlob } from '../../utils/download.js';
import { todayIso } from './dates.js';
import { ymOf } from './calendar.js';
import useDiary from './useDiary';
import DiaryRail from './DiaryRail';
import DiaryPage from './DiaryPage';
import './Diary.css';

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
        onExport={() => exportEntries().then((zip) => downloadBlob(zip, `flashback-diary-${today}.zip`)).catch(console.error)}
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
