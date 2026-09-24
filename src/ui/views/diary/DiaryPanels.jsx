/**
 * The diary's panels: the day's summary (tiles, breakdowns by document and
 * tag, the cards struggled with) and the reflection editor, which renders
 * Markdown when not editing.
 */

import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import { saveEntry } from '../../api/diary';
import StatTile from '../../components/base/StatTile';
import { LoadingState, ErrorState, EmptyState } from '../../components/base/StateView';
import { useT } from '../../translations/index';
import { pct } from './dates.js';

export function Breakdown({ title, rows, nameKey, emptyHint }) {
  const { t } = useT();
  const max = Math.max(...(rows ?? []).map((r) => r.reviews), 1);
  if (!rows?.length) return null;
  return (
    <div className="diary-breakdown">
      <h4 className="eyebrow diary-sub-heading">{title}</h4>
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

export function SummaryPanel({ state, summary }) {
  const { t, formatNumber, formatDateTime } = useT();
  if (state === "loading") return <LoadingState message={t('Loading summary…')} />;
  if (state === "error") return <ErrorState error={t('Could not load the summary.')} />;
  if (state === "none") {
    return (
      <EmptyState
        title={t('No summary for this day')}
        message={t('Summaries are written automatically when you finish a study session. Use “Rebuild from history” above to recreate them from past reviews.')}
      />
    );
  }

  const totals = summary.totals;
  const r = summary.retention ?? {};
  return (
    <div className="diary-summary">
      <div className="diary-tiles">
        <StatTile compact label={t('Reviews')} value={formatNumber(totals.reviews)} />
        <StatTile compact label={t('Cards seen')} value={formatNumber(totals.uniqueCards)}
          hint={t('{n} new', { n: formatNumber(totals.newCards) })} />
        <StatTile compact label={t('Pass rate')} value={pct(r.reviewPassRate ?? r.passRate)}
          hint={r.learningPassRate != null
            ? t('{pct} on new · {n} failed', { pct: pct(r.learningPassRate), n: formatNumber(totals.failed) })
            : t('{n} failed', { n: formatNumber(totals.failed) })} />
        <StatTile compact label={t('Streak')} value={t('{n}d', { n: formatNumber(summary.streak?.current) })}
          hint={t('best {n}d', { n: formatNumber(summary.streak?.longest) })} />
      </div>

      <Breakdown title={t('By deck')} rows={summary.byDeck} nameKey="deck" />
      <Breakdown title={t('By document')} rows={summary.byDocument} nameKey="path" />

      {summary.struggledCards?.length > 0 && (
        <div className="diary-breakdown">
          <h4 className="eyebrow diary-sub-heading">{t('Struggled with')}</h4>
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

export function EntryEditor({ date, loading, content, onSaved, editRequest = 0 }) {
  const { t } = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(content);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const [synced, setSynced] = useState({ date, content });
  if (synced.date !== date || synced.content !== content) {
    setSynced({ date, content });
    setDraft(content);
    setEditing(false);
    setError(null);
  }

  const [seenEditRequest, setSeenEditRequest] = useState(0);
  const [wantsEdit, setWantsEdit] = useState(false);
  if (seenEditRequest !== editRequest) {
    setSeenEditRequest(editRequest);
    if (editRequest) setWantsEdit(true);
  }
  if (wantsEdit && !loading) {
    setWantsEdit(false);
    setEditing(true);
  }

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
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => { setDraft(content); setEditing(false); }} disabled={saving}>
                {t('Cancel')}
              </button>
              <button type="button" className="btn btn--primary btn--sm" onClick={save} disabled={saving || !dirty}>
                {saving ? t('Saving…') : t('Save')}
              </button>
            </>
          ) : (
            <button type="button" className="btn btn--sm" onClick={() => setEditing(true)}>
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
