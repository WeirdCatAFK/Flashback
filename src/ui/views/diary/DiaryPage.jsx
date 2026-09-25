/**
 * DiaryPage — one day, read like a dated journal entry: the date, one sentence summing
 * the day up in the Statistics voice, then your reflection, written in place (Markdown,
 * Ctrl+S saves, Esc cancels), and last the numbers as "the day in detail" — by deck, by
 * document, and what you missed more than once. On a shared server the privacy note
 * sits above the writing, where it is true.
 */

import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import { saveEntry } from '../../api/diary';
import { LoadingState, ErrorState } from '../../components/base/StateView';
import { useT } from '../../translations/index';
import { pct } from './dates.js';

/** A figure in a sentence: bold mono, read in place. */
const F = ({ children }) => <b className="dy-fig-n">{children}</b>;

const docTitle = (path) => String(path ?? '').split('/').pop().replace(/\.[^.]+$/, '');

function Bars({ label, rows, nameOf }) {
  const { formatNumber } = useT();
  if (!rows?.length) return null;
  const max = Math.max(1, ...rows.map((r) => r.reviews));
  return (
    <div className="dy-block">
      <div className="dy-label">{label}</div>
      {rows.map((r, i) => (
        <div key={i} className="dy-bar">
          <span className="dy-bar__name" title={nameOf(r)}>{nameOf(r)}</span>
          <span className="dy-bar__track"><i style={{ width: `${(r.reviews / max) * 100}%` }} /></span>
          <span className="dy-bar__n">{formatNumber(r.reviews)}</span>
        </div>
      ))}
    </div>
  );
}

function Entry({ date, today, loading, content, onSaved, editRequest }) {
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

  const cancel = () => { setDraft(content); setEditing(false); setError(null); };
  const save = async () => {
    if (draft === content) { setEditing(false); return; }
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

  if (editing) {
    return (
      <section className="dy-entry" aria-label={t('Reflection')}>
        <textarea
          className="dy-editor"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t('How did studying go? Markdown works here. No cards are made from what you write.')}
          aria-label={t('Reflection')}
          autoFocus
          spellCheck
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
            if (e.key === 'Escape') { e.preventDefault(); cancel(); }
          }}
        />
        <div className="dy-edit-actions">
          <span className="dy-hint">{t('Ctrl+S saves · Esc cancels')}</span>
          <button type="button" className="btn btn--ghost btn--sm" onClick={cancel} disabled={saving}>{t('Cancel')}</button>
          <button type="button" className="btn btn--sm dy-save" onClick={save} disabled={saving}>{saving ? t('Saving…') : t('Save')}</button>
        </div>
        {error && <p className="dy-error" role="alert">{error}</p>}
      </section>
    );
  }

  return (
    <section className="dy-entry" aria-label={t('Reflection')}>
      {content ? (
        <>
          <div className="dy-prose markdown-body"><ReactMarkdown remarkPlugins={[remarkBreaks]}>{content}</ReactMarkdown></div>
          <button type="button" className="link-action dy-edit" onClick={() => setEditing(true)}>{t('Edit')}</button>
        </>
      ) : (
        <button type="button" className="dy-write" onClick={() => setEditing(true)}>
          <span>{date === today ? t('How did studying go today?') : t('Nothing written for this day.')}</span>
          <em>{t('Write')}</em>
        </button>
      )}
    </section>
  );
}

export default function DiaryPage({ date, today, yesterday, shared, summaryState, summary, entryLoading, entry, onSaved, editRequest }) {
  const { t, tp, locale, formatDay, formatNumber } = useT();
  const title = date === today ? t('Today') : date === yesterday ? t('Yesterday')
    : new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
  const totals = summary?.totals;
  const r = summary?.retention ?? {};
  const missed = (summary?.struggledCards ?? []).filter((c) => c.failCount > 1);
  const hasDay = summaryState === 'ready' && totals?.reviews > 0;

  return (
    <article className="dy-page">
      <div className="dy-eyebrow">{formatDay(date)}</div>
      <h1 className="dy-title">{title}</h1>
      <p className="dy-sentence">
        {summaryState === 'loading' ? t('Loading the day…')
          : hasDay ? (
            <>
              {t('You reviewed')} <F>{formatNumber(totals.reviews)}</F> {tp('card', 'cards', totals.reviews)}
              {totals.newCards > 0 && <> ({t('{n} new', { n: formatNumber(totals.newCards) })})</>}
              {' '}{t('and recalled')} <F>{pct(r.reviewPassRate ?? r.passRate)}</F>.
              {summary.streak?.current > 0 && <> {t('A streak of')} <F>{tp('{n} day', '{n} days', summary.streak.current, { n: formatNumber(summary.streak.current) })}</F>.</>}
            </>
          ) : summaryState === 'error' ? t('The day’s summary could not be loaded.')
            : t('No reviews this day.')}
      </p>

      {shared && (
        <p className="dy-privacy" role="note">
          {t('Everyone studying on this server shares one log history, and an administrator can read your summaries and anything you write.')}
        </p>
      )}

      <Entry date={date} today={today} loading={entryLoading} content={entry} onSaved={onSaved} editRequest={editRequest} />

      {summaryState === 'error' && <ErrorState error={t('Could not load the summary.')} />}
      {hasDay && (
        <section className="dy-detail">
          <h2 className="dy-h">{t('The day in detail')}</h2>
          <div className="dy-cols">
            <Bars label={t('By deck')} rows={summary.byDeck} nameOf={(x) => x.deck} />
            <Bars label={t('By document')} rows={summary.byDocument} nameOf={(x) => docTitle(x.path)} />
          </div>
          {missed.length > 0 && (
            <div className="dy-block">
              <div className="dy-label">{t('Missed more than once')}</div>
              {missed.map((c) => (
                <div key={c.globalHash} className="dy-missed">
                  <span>{c.front}</span>
                  <span className="dy-missed__n">{tp('{n} time', '{n} times', c.failCount, { n: formatNumber(c.failCount) })}</span>
                </div>
              ))}
            </div>
          )}
          <p className="dy-note">{t('Derived from your review history. Nothing here is typed by hand.')}</p>
        </section>
      )}
    </article>
  );
}
