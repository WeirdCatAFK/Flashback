/**
 * Diary — the per-day study record: a rail of dates, the selected day's summary
 * and the reflection written for it. Called "Logs" on a shared server, where one
 * history holds several people's prose (diaryLabels.js). Data is in useDiary.js.
 */

import { LoadingState } from '../../components/base/StateView';
import IconDiary from '../../components/icons/IconDiary';
import { useT } from '../../translations/index';
import { diaryLabels, isSharedVault } from '../../diaryLabels.js';
import { fmtDate } from './dates.js';
import useDiary from './useDiary';
import { SummaryPanel, EntryEditor } from './DiaryPanels';
import './Diary.css';

export default function DiaryView({ isActive, connection }) {
  const { t, locale } = useT();
  const shared = isSharedVault(connection);
  const labels = diaryLabels(t, shared);
  const d = useDiary(isActive);
  const { today, selectedDate, setSelectedDate, dates, datesError, summaryState, summary, entryLoading, entry, rebuilding, railDates, onEntrySaved } = d;
  const onRebuild = d.rebuild;

  if (dates === null) return <LoadingState message={labels.loading} />;

  return (
    <div className="diary">
      <aside className="diary-rail">
        <div className="diary-rail-head">
          <IconDiary size={18} />
          <span>{labels.title}</span>
        </div>
        {datesError && <p className="diary-rail-error">{t('Couldn’t load dates.')}</p>}
        <ul className="diary-date-list">
          {railDates.map((d) => (
            <li key={d.date}>
              <button
                type="button"
                className={`diary-date${d.date === selectedDate ? " diary-date--active" : ""}`}
                onClick={() => setSelectedDate(d.date)}
              >
                <span className="diary-date-label">
                  {d.date === today ? t('Today') : fmtDate(d.date, locale)}
                </span>
                <span className="diary-date-badges">
                  {d.hasSummary && <span className="diary-badge diary-badge--summary" title={t('Has summary')}>S</span>}
                  {d.hasEntry && <span className="diary-badge diary-badge--entry" title={t('Has entry')}>✎</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <main className="diary-main">
        <header className="diary-main-head">
          <h2 className="diary-main-title">{selectedDate === today ? t('Today') : fmtDate(selectedDate, locale)}</h2>
          <span className="diary-main-date">{selectedDate}</span>
          <div className="diary-main-actions">
            <button
              type="button"
              className="btn btn--sm"
              onClick={onRebuild}
              disabled={rebuilding}
              title={t('Rebuild every day’s summary from your review history')}
            >
              {rebuilding ? t('Rebuilding…') : t('Rebuild from history')}
            </button>
          </div>
        </header>

        {shared && (
          <p className="diary-privacy-note" role="note">
            {t('Everyone studying on this server shares one log history, and an administrator can read your summaries and anything you write.')}
          </p>
        )}

        <SummaryPanel state={summaryState} summary={summary} />
        <EntryEditor date={selectedDate} loading={entryLoading} content={entry} onSaved={onEntrySaved} />
      </main>
    </div>
  );
}
