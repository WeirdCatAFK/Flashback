import { useState, useEffect, useCallback, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import "./Diary.css";
import { listDiary, getSummary, getEntry, saveEntry, rebuildSummaries } from "../api/diary";
import { LoadingState, ErrorState, EmptyState } from "../components/shared/StateView";
import IconDiary from "../components/icons/IconDiary";
import { useT } from "../translations";

/**
 * Logs — a per-day study record living OUTSIDE the workspace (see DATAMODEL.md § Diary).
 *
 * Called "Diary" everywhere below the UI — the route is `/api/diary`, the directory is
 * `diary/`, the preference is `fb-diary-enabled` — and renaming any of those would be a
 * migration that bought nothing and silently reset everyone's opt-in. The LABEL changed
 * because on a shared server the name was misleading: see the privacy note rendered below.
 * Two pieces per date: a machine-written summary (rendered read-only from JSON) and
 * an optional user-written markdown entry. This view deliberately offers no flashcard
 * creation or highlighting — the diary is metadata about studying, not study material,
 * so the entry editor is a plain markdown field, not the document renderer pipeline.
 *
 * Opt-in lives in Config (localStorage `fb-diary-enabled`); when off, summaries aren't
 * auto-written, but any existing days remain browsable/editable here.
 */

// Date keys are the user's LOCAL calendar day, matching the server's
// date(timestamp, 'localtime') bucketing — toISOString() would open tomorrow's
// (empty) diary page for anyone studying in the evening west of Greenwich.
const todayIso = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const pct = (r) => (r == null ? "—" : `${Math.round(r * 100)}%`);

// A human date label from a 'YYYY-MM-DD' key (parsed as UTC to match the key).
// Takes the active locale explicitly rather than passing `undefined`, which would
// follow the browser's language instead of the one chosen in Config.
const fmtDate = (iso, locale) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString(locale, {
    weekday: "short", year: "numeric", month: "short", day: "numeric", timeZone: "UTC",
  });

// ── Summary panel (read-only, rendered from the derived JSON) ──────────────────

function Tile({ label, value, sub }) {
  return (
    <div className="diary-tile">
      <div className="diary-tile-value">{value}</div>
      <div className="diary-tile-label">{label}</div>
      {sub != null && <div className="diary-tile-sub">{sub}</div>}
    </div>
  );
}

function Breakdown({ title, rows, nameKey, emptyHint }) {
  const { t } = useT();
  const max = Math.max(...(rows ?? []).map((r) => r.reviews), 1);
  if (!rows?.length) return null;
  return (
    <div className="diary-breakdown">
      <h4 className="diary-sub-heading">{title}</h4>
      <ul className="diary-bars">
        {rows.map((r, i) => (
          <li key={i} className="diary-bar-row" title={
            t('{n} reviews', { n: r.reviews })
            + (r.failed != null ? ` · ${t('{n} failed', { n: r.failed })}` : "")
          }>
            <span className="diary-bar-name">{r[nameKey]}</span>
            <span className="diary-bar-track">
              <span className="diary-bar-fill" style={{ width: `${(r.reviews / max) * 100}%` }} />
            </span>
            <span className="diary-bar-count">{r.reviews}</span>
          </li>
        ))}
      </ul>
      {emptyHint}
    </div>
  );
}

function SummaryPanel({ state, summary }) {
  const { t, formatNumber, formatDateTime } = useT();
  if (state === "loading") return <LoadingState message={t('Loading summary…')} />;
  if (state === "error") return <ErrorState error={t('Could not load the summary.')} />;
  if (state === "none") {
    // No action here — "Rebuild from history" lives in the day header, where it
    // stays reachable on days that *do* have a summary (an out-of-date one is
    // exactly when you want to re-derive it).
    return (
      <EmptyState
        title={t('No summary for this day')}
        message={t('Summaries are written automatically when you finish a study session (with logging enabled). Use “Rebuild from history” above to re-derive them from your review log.')}
      />
    );
  }

  const totals = summary.totals;
  // Pass rate excludes cards still in their learning phase (schema v2); summaries
  // written before that fall back to the day's overall rate.
  const r = summary.retention ?? {};
  return (
    <div className="diary-summary">
      <div className="diary-tiles">
        <Tile label={t('Reviews')} value={formatNumber(totals.reviews)} />
        <Tile label={t('Cards seen')} value={formatNumber(totals.uniqueCards)}
          sub={t('{n} new', { n: formatNumber(totals.newCards) })} />
        <Tile label={t('Pass rate')} value={pct(r.reviewPassRate ?? r.passRate)}
          sub={r.learningPassRate != null
            ? t('{pct} on new · {n} failed', { pct: pct(r.learningPassRate), n: formatNumber(totals.failed) })
            : t('{n} failed', { n: formatNumber(totals.failed) })} />
        <Tile label={t('Streak')} value={t('{n}d', { n: formatNumber(summary.streak?.current) })}
          sub={t('best {n}d', { n: formatNumber(summary.streak?.longest) })} />
      </div>

      <Breakdown title={t('By deck')} rows={summary.byDeck} nameKey="deck" />
      <Breakdown title={t('By document')} rows={summary.byDocument} nameKey="path" />

      {summary.struggledCards?.length > 0 && (
        <div className="diary-breakdown">
          <h4 className="diary-sub-heading">{t('Struggled with')}</h4>
          <ul className="diary-struggled">
            {summary.struggledCards.map((c) => (
              <li key={c.globalHash} className="diary-struggled-row">
                <span className="diary-struggled-front">{c.front}</span>
                <span className="diary-struggled-count">×{c.failCount}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="diary-generated">
        {t('Derived from your review history')}
        {summary.generatedAt
          ? ` · ${t('updated {when}', { when: formatDateTime(summary.generatedAt) })}`
          : ""}.
      </p>
    </div>
  );
}

// ── Entry editor (plain markdown; no cards, no highlights) ─────────────────────

function EntryEditor({ date, loading, content, onSaved }) {
  const { t } = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(content);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Reset local state whenever the loaded entry (i.e. the date) changes.
  useEffect(() => {
    setDraft(content);
    setEditing(false);
    setError(null);
  }, [content, date]);

  const dirty = draft !== content;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await saveEntry(date, draft);
      onSaved(date, draft);
      setEditing(false);
    } catch (e) {
      setError(e?.message ?? t('Could not save the entry.'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <LoadingState message={t('Loading entry…')} />;

  return (
    <div className="diary-entry">
      <div className="diary-entry-head">
        <h3 className="diary-entry-title">{t('Reflection')}</h3>
        <div className="diary-entry-actions">
          {editing ? (
            <>
              <button type="button" className="diary-btn diary-btn--ghost" onClick={() => { setDraft(content); setEditing(false); }} disabled={saving}>
                {t('Cancel')}
              </button>
              <button type="button" className="diary-btn diary-btn--primary" onClick={save} disabled={saving || !dirty}>
                {saving ? t('Saving…') : t('Save')}
              </button>
            </>
          ) : (
            <button type="button" className="diary-btn" onClick={() => setEditing(true)}>
              {content ? t('Edit') : t('Write')}
            </button>
          )}
        </div>
      </div>

      {editing ? (
        <textarea
          className="diary-entry-textarea"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t('How did studying go today? Markdown supported. No flashcards are created here.')}
          autoFocus
          spellCheck
        />
      ) : content ? (
        <div className="diary-entry-preview markdown-body">
          <ReactMarkdown remarkPlugins={[remarkBreaks]}>{content}</ReactMarkdown>
        </div>
      ) : (
        <p className="diary-entry-empty">{t('No reflection for this day yet.')}</p>
      )}

      {error && <p className="diary-entry-error">{error}</p>}
    </div>
  );
}

// ── View ───────────────────────────────────────────────────────────────────────

export default function DiaryView({ isActive, connection }) {
  const { t, locale } = useT();
  // Only on a remote. On a local vault the warning would be false — there is one account and
  // nobody else to read anything — and a false warning teaches people to ignore true ones.
  const shared = connection?.kind === 'remote';
  const today = useMemo(() => todayIso(), []);
  const [selectedDate, setSelectedDate] = useState(today);

  const [dates, setDates] = useState(null);
  const [datesError, setDatesError] = useState(null);

  const [summaryState, setSummaryState] = useState("loading"); // loading|ready|none|error
  const [summary, setSummary] = useState(null);

  const [entryLoading, setEntryLoading] = useState(true);
  const [entry, setEntry] = useState("");

  const [rebuilding, setRebuilding] = useState(false);

  const loadDates = useCallback(() => {
    setDatesError(null);
    listDiary().then(setDates).catch((e) => { setDates([]); setDatesError(e); });
  }, []);

  // Load the date list once the view first becomes active (and on demand after writes).
  const [loadedOnce, setLoadedOnce] = useState(false);
  useEffect(() => {
    if (isActive && !loadedOnce) { setLoadedOnce(true); loadDates(); }
  }, [isActive, loadedOnce, loadDates]);

  // Load the selected day's summary + entry.
  useEffect(() => {
    if (!loadedOnce) return;
    let ignore = false;

    setSummaryState("loading");
    getSummary(selectedDate)
      .then((s) => { if (!ignore) { setSummary(s); setSummaryState("ready"); } })
      .catch((e) => { if (!ignore) { setSummary(null); setSummaryState(e?.status === 404 ? "none" : "error"); } });

    setEntryLoading(true);
    getEntry(selectedDate)
      .then((r) => { if (!ignore) { setEntry(r.content ?? ""); setEntryLoading(false); } })
      .catch(() => { if (!ignore) { setEntry(""); setEntryLoading(false); } });

    return () => { ignore = true; };
  }, [selectedDate, loadedOnce]);

  const onEntrySaved = useCallback((date, content) => {
    setEntry(content);
    loadDates(); // refresh hasEntry badges
  }, [loadDates]);

  const onRebuild = useCallback(async () => {
    setRebuilding(true);
    try {
      await rebuildSummaries();
      loadDates();
      // Re-fetch the current day's summary now that it may exist.
      try {
        const s = await getSummary(selectedDate);
        setSummary(s); setSummaryState("ready");
      } catch (e) {
        setSummary(null); setSummaryState(e?.status === 404 ? "none" : "error");
      }
    } finally {
      setRebuilding(false);
    }
  }, [loadDates, selectedDate]);

  // Merge today into the rail so it's always selectable even before any activity.
  const railDates = useMemo(() => {
    const list = dates ?? [];
    if (list.some((d) => d.date === today)) return list;
    return [{ date: today, hasSummary: false, hasEntry: false }, ...list];
  }, [dates, today]);

  if (dates === null) return <LoadingState message={t('Loading logs…')} />;

  return (
    <div className="diary">
      <aside className="diary-rail">
        <div className="diary-rail-head">
          <IconDiary size={18} />
          <span>{t('Logs')}</span>
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
              className="diary-btn"
              onClick={onRebuild}
              disabled={rebuilding}
              title={t('Re-derive every day’s summary from your review history')}
            >
              {rebuilding ? t('Rebuilding…') : t('Rebuild from history')}
            </button>
          </div>
        </header>

        {shared && (
          <p className="diary-privacy-note" role="note">
            {t('These logs are stored in this server’s vault, in one history shared with everyone else studying here. An administrator can read your summaries and anything you write. Keep private reflections elsewhere.')}
          </p>
        )}

        <SummaryPanel state={summaryState} summary={summary} />
        <EntryEditor date={selectedDate} loading={entryLoading} content={entry} onSaved={onEntrySaved} />
      </main>
    </div>
  );
}
