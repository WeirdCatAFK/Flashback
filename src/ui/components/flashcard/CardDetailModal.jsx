/**
 * CardDetailModal — one card in full: its faces, its schedule and review
 * history, the card-health verdict with what it rests on, and in-place editing.
 */

import { useCallback, useEffect, useState } from 'react';
import Modal from '../base/Modal';
import StatTile from '../base/StatTile';
import Flashcard from './Flashcard';
import FlashcardForm from './FlashcardForm';
import RetentionCurve from './RetentionCurve';
import ReviewStrip from './ReviewStrip';
import { LoadingState, ErrorState } from '../base/StateView';
import { getCardDetail, updateCard, dismissCardFlag } from '../../api/decks';
import { getPref } from '../../prefs.js';
import { mediaFileSrc } from '../../api/media';
import { useT } from '../../translations/index';
import { useSession } from '../../sessionContext.js';
import { capabilityHint } from '../../roleLabels.js';
import './CardDetailModal.css';

const pct = (r) => (r == null ? '—' : `${Math.round(r * 100)}%`);
const days = (d) => (d == null ? '—' : d >= 10 ? `${Math.round(d)} d` : `${Math.round(d * 10) / 10} d`);

/**
 * One card-health flag: what the classifier concluded, what it concluded it from, and
 * what the user might do about it.
 *
 * The evidence row is the point. A flag that only asserted "this card is overloaded"
 * would be an oracle; showing the peak intervals it walked and the answer length it
 * compared against lets the reader disagree with it. Nothing here applies a change —
 * the action is a sentence, not a button that splits the card.
 */
function evidenceBits(f, t, tp) {
  const e = f.evidence ?? {};
  const bits = [];
  if (e.lapses != null) bits.push(tp('{n} lapse', '{n} lapses', e.lapses));
  if (e.windowDays) bits.push(t('over {span}', { span: days(e.windowDays) }));
  if (e.peaks?.length) bits.push(t('intervals reached {peaks}', { peaks: e.peaks.map((p) => days(p)).join(' → ') }));
  if (e.answerTokens != null && e.medianAnswerTokens) {
    bits.push(t('answer {words} words vs. {typical} typical',
      { words: e.answerTokens, typical: Math.round(e.medianAnswerTokens) }));
  }
  if (e.chunks > 1) bits.push(t('{n} separate parts', { n: e.chunks }));
  if (e.worstOverdueRatio) bits.push(t('up to {ratio}× past due', { ratio: e.worstOverdueRatio }));
  if (e.medianFailurePosition != null) {
    bits.push(t('fails {pct}% into a session', { pct: Math.round(e.medianFailurePosition * 100) }));
  }
  return bits;
}

function CardFlag({ flag, hash, onDismissed }) {
  const [busy, setBusy] = useState(false);
  const { t, tp } = useT();
  const bits = evidenceBits(flag, t, tp);

  const dismiss = async () => {
    setBusy(true);
    try {
      await dismissCardFlag(hash, flag.kind);
      onDismissed?.();
    } catch {
      setBusy(false);
    }
  };

  return (
    <li className={`cd-flag cd-flag--${flag.kind}`}>
      <div className="cd-flag-head">
        <strong className="cd-flag-title">{flag.title}</strong>
        <span className="cd-flag-confidence" title={t('How much history this rests on')}>
          {flag.confidence}
        </span>
        <button type="button" className="link-action cd-flag-dismiss" onClick={dismiss} disabled={busy}
          title={t('Stop showing this flag for this card')}>
          {t('Dismiss')}
        </button>
      </div>
      <p className="cd-flag-detail">{flag.detail}</p>
      <p className="cd-flag-action">{flag.action}</p>
      {bits.length > 0 && <p className="cd-flag-evidence">{bits.join(' · ')}</p>}
      {flag.evidence?.memoryModel === 'approximated' && (
        <p className="cd-flag-evidence">
          {t('Your scheduler records no difficulty signal, so this reads the card’s intervals alone.')}
        </p>
      )}
    </li>
  );
}

export default function CardDetailModal({ hash, onClose, onSaved }) {
  const [data, setData]       = useState(null);
  const [error, setError]     = useState(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving]   = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [face, setFace]       = useState('front');
  const { t, formatRelative } = useT();
  const { can } = useSession();
  const mayEdit = can('editCards');

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    const algorithm = getPref('fb-srs-algorithm') ?? 'sm2';
    getCardDetail(hash, algorithm)
      .then(setData)
      .catch(setError)
      .finally(() => setLoading(false));
  }, [hash]);

  useEffect(load, [load]);

  const handleSave = async ({ card }) => {
    setSaving(true);
    setSaveError(null);
    try {
      await updateCard(hash, {
        name: card.name,
        cardType: card.cardType,
        frontText: card.vanillaData?.frontText ?? '',
        backText: card.vanillaData?.backText ?? '',
        ...(card.vanillaData?.answerText !== undefined
          ? { answerText: card.vanillaData.answerText }
          : {}),
        customHtml: card.customData?.html ?? '',
        category: card.category,
        tags: card.tags ?? [],
      });
      setEditing(false);
      load();
      onSaved?.();
    } catch (err) {
      setSaveError(err.message ?? t('Failed to save'));
    } finally {
      setSaving(false);
    }
  };

  const card = data?.card;
  const srs = data?.srs;

  const title = editing
    ? t('Edit card')
    : (card?.name || card?.frontText || t('Card'));

  const docPath = card?.documentPath ?? null;
  const resolveMedia = useCallback((ref) => mediaFileSrc(docPath, ref), [docPath]);

  const preview = card && (card.cardType === 'custom'
    ? { cardType: 'custom', customData: { html: card.customHtml ?? '' } }
    : {
        cardType: card.cardType ?? 'basic',
        direction: 'forward',
        vanillaData: {
          frontText: card.frontText ?? '',
          backText: card.backText ?? '',
          answerText: card.answerText ?? null,
          media: card.media ?? {},
        },
      });

  return (
    <Modal title={title} size="xl" onClose={onClose}>
      {loading && <LoadingState message={t('Loading card…')} />}
      {!loading && error && (
        <ErrorState error={error} title={t('Couldn’t load this card')} onRetry={load} />
      )}

      {!loading && !error && data && (editing ? (
        <FlashcardForm
          initial={{
            cardType: card.cardType ?? 'basic',
            frontText: card.frontText ?? '',
            backText: card.backText ?? '',
            answerText: card.answerText ?? null,
            customHtml: card.customHtml ?? '',
            category: card.category ?? '',
            media: card.media ?? null,
            tags: card.tags ?? [],
          }}
          resolveMedia={resolveMedia}
          submitLabel={t('Save changes')}
          saving={saving}
          error={saveError}
          onSubmit={handleSave}
          onCancel={() => { setEditing(false); setSaveError(null); }}
        />
      ) : (
        <div className="cd-body">
          <div className="cd-top">
            <div className="cd-preview">
              <Flashcard
                card={preview}
                face={face}
                onFlip={setFace}
                onTypeCheck={() => setFace('back')}
                resolveMedia={resolveMedia}
                variant="full"
              />
              <span className="cd-flip-hint">
                {preview.cardType === 'type_answer' ? t('check to reveal the back') : t('click to flip')}
              </span>
            </div>

            <div className="cd-side">
              <div className="cd-meta">
                <span className="cd-badge">{(card.cardType ?? 'basic').replace('_', ' ')}</span>
                {card.category && <span className="cd-badge">{card.category}</span>}
                <span className="cd-badge cd-badge--muted" title={card.documentPath ?? undefined}>
                  {card.documentPath
                    ? card.documentPath.split(/[\\/]/).pop()
                    : t('standalone')}
                </span>
                {card.origin === 'ai' && <span className="cd-badge cd-badge--muted">{t('AI-made')}</span>}
              </div>

              <div className="cd-stats">
                <StatTile compact label={t('level')} value={srs.level ?? 0} />
                <StatTile compact label={t('reviews')} value={srs.reviews} />
                <StatTile compact label={t('retention')} value={pct(srs.retention)}
                  title={t('Share of this card’s reviews that were correct')} />
                <StatTile compact label={t('interval')} value={srs.state === 'new' ? '—' : days(srs.intervalDays)} />
              </div>

              <dl className="cd-facts">
                <div><dt>{t('Last review')}</dt>
                  <dd title={srs.lastRecall ?? undefined}>
                    {srs.lastRecall ? formatRelative(srs.lastRecall) : t('never')}
                  </dd></div>
                <div><dt>{t('Due')}</dt>
                  <dd title={srs.dueAt ?? undefined}>
                    {srs.dueAt ? formatRelative(srs.dueAt) : '—'}
                    {srs.overdueDays > 0 && <span className="cd-overdue"> {t('overdue')}</span>}
                  </dd></div>
                <div><dt>{t('Scheduler')}</dt><dd>{data.algorithm}</dd></div>
                {srs.fsrs && data.algorithm === 'fsrs' && (
                  <div><dt>{t('Difficulty')}</dt>
                    <dd>{srs.fsrs.difficulty?.toFixed(1) ?? '—'} / 10</dd></div>
                )}
              </dl>

              <button
                type="button"
                className="btn btn--quiet btn--sm cd-edit-btn"
                onClick={() => setEditing(true)}
                disabled={!mayEdit}
                title={mayEdit ? undefined : capabilityHint(t, 'editCards')}
              >
                {t('Edit card')}
              </button>
            </div>
          </div>

          {data.flags?.length > 0 && (
            <section className="cd-section">
              <h3 className="cd-section-title">{t('Card health')}</h3>
              <ul className="cd-flags">
                {data.flags.map((f) => (
                  <CardFlag key={f.id} flag={f} hash={hash} onDismissed={load} />
                ))}
              </ul>
            </section>
          )}

          <section className="cd-section">
            <h3 className="cd-section-title">{t('Predicted recall')}</h3>
            {data.curve
              ? <RetentionCurve curve={data.curve} />
              : <p className="cd-empty">{t('No curve yet — this card hasn’t been reviewed.')}</p>}
          </section>

          <section className="cd-section">
            <h3 className="cd-section-title">{t('Review history')}</h3>
            <ReviewStrip history={data.history} />
          </section>
        </div>
      ))}
    </Modal>
  );
}
