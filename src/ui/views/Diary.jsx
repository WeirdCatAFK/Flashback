import { useState, useEffect, useCallback, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import "./Diary.css";
import { listDiary, getSummary, getEntry, saveEntry, rebuildSummaries } from "../api/diary";
import { LoadingState, ErrorState, EmptyState } from "../components/shared/StateView";
import IconDiary from "../components/icons/IconDiary";

/**
 * Diary — a per-day study record living OUTSIDE the workspace (see DATAMODEL.md § Diary).
 * Two pieces per date: a machine-written summary (rendered read-only from JSON) and
 * an optional user-written markdown entry. This view deliberately offers no flashcard
 * creation or highlighting — the diary is metadata about studying, not study material,
 * so the entry editor is a plain markdown field, not the document renderer pipeline.
 *
 * Opt-in lives in Config (localStorage `fb-diary-enabled`); when off, summaries aren't
 * auto-written, but any existing days remain browsable/editable here.
 */

const todayIso = () => new Date().toISOString().slice(0, 10);

const pct = (r) => (r == null ? "—" : `${Math.round(r * 100)}%`);
const num = (n) => (n ?? 0).toLocaleString();

// A human date label from a 'YYYY-MM-DD' key (parsed as UTC to match the key).
const fmtDate = (iso) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
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
  if (!rows?.length) return null;
  const max = Math.max(...rows.map((r) => r.reviews), 1);
  return (
    <div className="diary-breakdown">
      <h4 className="diary-sub-heading">{title}</h4>
      <ul className="diary-bars">
        {rows.map((r, i) => (
          <li key={i} className="diary-bar-row" title={`${r.reviews} reviews${r.failed != null ? ` · ${r.failed} failed` : ""}`}>
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

function SummaryPanel({ state, summary, onRebuild, rebuilding }) {
  if (state === "loading") return <LoadingState message="Loading summary…" />;
  if (state === "error") return <ErrorState error="Could not load the summary." />;
  if (state === "none") {
    return (
      <EmptyState
        title="No summary for this day"
        message="Summaries are written automatically when you finish a study session (with the diary enabled). You can also rebuild them from your review history."
        action={
          <button type="button" className="diary-btn" onClick={onRebuild} disabled={rebuilding}>
            {rebuilding ? "Rebuilding…" : "Rebuild from history"}
          </button>
        }
      />
    );
  }

  const t = summary.totals;
  return (
    <div className="diary-summary">
      <div className="diary-tiles">
        <Tile label="Reviews" value={num(t.reviews)} />
        <Tile label="Cards seen" value={num(t.uniqueCards)} sub={`${num(t.newCards)} new`} />
        <Tile label="Pass rate" value={pct(summary.retention?.passRate)} sub={`${num(t.failed)} failed`} />
        <Tile label="Streak" value={`${num(summary.streak?.current)}d`} sub={`best ${num(summary.streak?.longest)}d`} />
      </div>

      <Breakdown title="By deck" rows={summary.byDeck} nameKey="deck" />
      <Breakdown title="By document" rows={summary.byDocument} nameKey="path" />

      {summary.struggledCards?.length > 0 && (
        <div className="diary-breakdown">
          <h4 className="diary-sub-heading">Struggled with</h4>
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
        Derived from your review history{summary.generatedAt ? ` · updated ${new Date(summary.generatedAt).toLocaleString()}` : ""}.
      </p>
    </div>
  );
}

// ── Entry editor (plain markdown; no cards, no highlights) ─────────────────────

function EntryEditor({ date, loading, content, onSaved }) {
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
      setError(e?.message ?? "Could not save the entry.");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <LoadingState message="Loading entry…" />;

  return (
    <div className="diary-entry">
      <div className="diary-entry-head">
        <h3 className="diary-entry-title">Reflection</h3>
        <div className="diary-entry-actions">
          {editing ? (
            <>
              <button type="button" className="diary-btn diary-btn--ghost" onClick={() => { setDraft(content); setEditing(false); }} disabled={saving}>
                Cancel
              </button>
              <button type="button" className="diary-btn diary-btn--primary" onClick={save} disabled={saving || !dirty}>
                {saving ? "Saving…" : "Save"}
              </button>
            </>
          ) : (
            <button type="button" className="diary-btn" onClick={() => setEditing(true)}>
              {content ? "Edit" : "Write"}
            </button>
          )}
        </div>
      </div>

      {editing ? (
        <textarea
          className="diary-entry-textarea"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="How did studying go today? Markdown supported. No flashcards are created here."
          autoFocus
          spellCheck
        />
      ) : content ? (
        <div className="diary-entry-preview markdown-body">
          <ReactMarkdown remarkPlugins={[remarkBreaks]}>{content}</ReactMarkdown>
        </div>
      ) : (
        <p className="diary-entry-empty">No reflection for this day yet.</p>
      )}

      {error && <p className="diary-entry-error">{error}</p>}
    </div>
  );
}

// ── View ───────────────────────────────────────────────────────────────────────

export default function DiaryView({ isActive }) {
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

  if (dates === null) return <LoadingState message="Loading diary…" />;

  return (
    <div className="diary">
      <aside className="diary-rail">
        <div className="diary-rail-head">
          <IconDiary size={18} />
          <span>Diary</span>
        </div>
        {datesError && <p className="diary-rail-error">Couldn’t load dates.</p>}
        <ul className="diary-date-list">
          {railDates.map((d) => (
            <li key={d.date}>
              <button
                type="button"
                className={`diary-date${d.date === selectedDate ? " diary-date--active" : ""}`}
                onClick={() => setSelectedDate(d.date)}
              >
                <span className="diary-date-label">
                  {d.date === today ? "Today" : fmtDate(d.date)}
                </span>
                <span className="diary-date-badges">
                  {d.hasSummary && <span className="diary-badge diary-badge--summary" title="Has summary">S</span>}
                  {d.hasEntry && <span className="diary-badge diary-badge--entry" title="Has entry">✎</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <main className="diary-main">
        <header className="diary-main-head">
          <h2 className="diary-main-title">{selectedDate === today ? "Today" : fmtDate(selectedDate)}</h2>
          <span className="diary-main-date">{selectedDate}</span>
        </header>

        <SummaryPanel state={summaryState} summary={summary} onRebuild={onRebuild} rebuilding={rebuilding} />
        <EntryEditor date={selectedDate} loading={entryLoading} content={entry} onSaved={onEntrySaved} />
      </main>
    </div>
  );
}
