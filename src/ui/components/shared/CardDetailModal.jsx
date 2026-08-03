import { useCallback, useEffect, useState } from 'react';
import Modal from './Modal';
import Flashcard from './Flashcard';
import FlashcardForm from './FlashcardForm';
import RetentionCurve from './RetentionCurve';
import ReviewStrip from './ReviewStrip';
import { LoadingState, ErrorState } from './StateView';
import { getCardDetail, updateCard, dismissCardFlag } from '../../api/decks';
import { mediaFileSrc } from '../../api/media';
import { relativeFromIso } from '../../utils/relativeTime';
import './CardDetailModal.css';

/**
 * CardDetailModal — everything the vault knows about one card.
 *
 * Opened from the Flashcards list, which is the only place a card can be found by
 * name and until now was a dead end: you could delete a card from there but never
 * look at it or fix it. One request (`GET /api/flashcards/:hash/detail`) brings the
 * content, the schedule, the review ledger and the retention curve, so the view has
 * a single loading state and no scheduler math of its own.
 *
 * Editing writes through `PUT /api/flashcards/:hash`, which resolves whether the
 * card lives in a document's sidecar or the system deck — this component doesn't
 * branch on that, and deliberately doesn't autosave: one save is one Seal commit.
 */

const pct = (r) => (r == null ? '—' : `${Math.round(r * 100)}%`);
const days = (d) => (d == null ? '—' : d >= 10 ? `${Math.round(d)} d` : `${Math.round(d * 10) / 10} d`);

function Stat({ label, value, title }) {
  return (
    <div className="cd-stat" title={title}>
      <span className="cd-stat-value">{value}</span>
      <span className="cd-stat-label">{label}</span>
    </div>
  );
}

/**
 * One card-health flag: what the classifier concluded, what it concluded it from, and
 * what the user might do about it.
 *
 * The evidence row is the point. A flag that only asserted "this card is overloaded"
 * would be an oracle; showing the peak intervals it walked and the answer length it
 * compared against lets the reader disagree with it. Nothing here applies a change —
 * the action is a sentence, not a button that splits the card.
 */
function evidenceBits(f) {
  const e = f.evidence ?? {};
  const bits = [];
  if (e.lapses != null) bits.push(`${e.lapses} lapse${e.lapses === 1 ? '' : 's'}`);
  if (e.windowDays) bits.push(`over ${days(e.windowDays)}`);
  if (e.peaks?.length) bits.push(`intervals reached ${e.peaks.map((p) => days(p)).join(' → ')}`);
  if (e.answerTokens != null && e.medianAnswerTokens) {
    bits.push(`answer ${e.answerTokens} words vs. ${Math.round(e.medianAnswerTokens)} typical`);
  }
  if (e.chunks > 1) bits.push(`${e.chunks} separate parts`);
  if (e.worstOverdueRatio) bits.push(`up to ${e.worstOverdueRatio}× past due`);
  if (e.medianFailurePosition != null) {
    bits.push(`fails ${Math.round(e.medianFailurePosition * 100)}% into a session`);
  }
  return bits;
}

function CardFlag({ flag, hash, onDismissed }) {
  const [busy, setBusy] = useState(false);
  const bits = evidenceBits(flag);

  const dismiss = async () => {
    setBusy(true);
    try {
      await dismissCardFlag(hash, flag.kind);
      onDismissed?.();
    } catch {
      setBusy(false);   // stays visible; the user can try again
    }
  };

  return (
    <li className={`cd-flag cd-flag--${flag.kind}`}>
      <div className="cd-flag-head">
        <strong className="cd-flag-title">{flag.title}</strong>
        <span className="cd-flag-confidence" title="How much history this rests on">
          {flag.confidence}
        </span>
        <button type="button" className="cd-flag-dismiss" onClick={dismiss} disabled={busy}
          title="Stop showing this flag for this card">
          Dismiss
        </button>
      </div>
      <p className="cd-flag-detail">{flag.detail}</p>
      <p className="cd-flag-action">{flag.action}</p>
      {bits.length > 0 && <p className="cd-flag-evidence">{bits.join(' · ')}</p>}
      {flag.evidence?.memoryModel === 'approximated' && (
        <p className="cd-flag-evidence">
          Your scheduler records no difficulty signal, so this reads the card&rsquo;s
          intervals alone — it&rsquo;s a weaker call than it would be under FSRS.
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

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    // The active scheduler is a local preference the API can't see; send it so the
    // schedule shown here is the one the Trainer would actually use.
    const algorithm = localStorage.getItem('fb-srs-algorithm') ?? 'sm2';
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
        customHtml: card.customData?.html ?? '',
        category: card.category,
        // No `tags` key on purpose: this view's payload is the derived layer, which
        // doesn't carry the card's own tag list, and an omitted field leaves the
        // stored value alone. Tags are edited in the document Inspector, which reads
        // them from the sidecar and can show what it's about to replace.
      });
      setEditing(false);
      load();
      onSaved?.();
    } catch (err) {
      setSaveError(err.message ?? 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const card = data?.card;
  const srs = data?.srs;

  const title = editing
    ? 'Edit card'
    : (card?.name || card?.frontText || 'Card');

  // Media arrives as stored references ("./media/front-1a2b.png"); they only become
  // loadable once resolved against the card's document.
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
          media: card.media ?? {},
        },
      });

  return (
    <Modal title={title} size="xl" onClose={onClose}>
      {loading && <LoadingState message="Loading card…" />}
      {!loading && error && (
        <ErrorState error={error} title="Couldn't load this card" onRetry={load} />
      )}

      {!loading && !error && data && (editing ? (
        <FlashcardForm
          initial={{
            cardType: card.cardType ?? 'basic',
            frontText: card.frontText ?? '',
            backText: card.backText ?? '',
            customHtml: card.customHtml ?? '',
            category: card.category ?? '',
            media: card.media ?? null,
          }}
          resolveMedia={resolveMedia}
          showTags={false}
          submitLabel="Save changes"
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
                {preview.cardType === 'type_answer' ? 'check to reveal the back' : 'click to flip'}
              </span>
            </div>

            <div className="cd-side">
              <div className="cd-meta">
                <span className="cd-badge">{(card.cardType ?? 'basic').replace('_', ' ')}</span>
                {card.category && <span className="cd-badge">{card.category}</span>}
                <span className="cd-badge cd-badge--muted" title={card.documentPath ?? undefined}>
                  {card.documentPath
                    ? card.documentPath.split(/[\\/]/).pop()
                    : 'standalone'}
                </span>
                {card.origin === 'ai' && <span className="cd-badge cd-badge--muted">AI-made</span>}
              </div>

              <div className="cd-stats">
                <Stat label="level" value={srs.level ?? 0} />
                <Stat label="reviews" value={srs.reviews} />
                <Stat label="retention" value={pct(srs.retention)}
                  title="Share of this card's reviews that were correct" />
                <Stat label="interval" value={srs.state === 'new' ? '—' : days(srs.intervalDays)} />
              </div>

              <dl className="cd-facts">
                <div><dt>Last review</dt>
                  <dd title={srs.lastRecall ?? undefined}>
                    {srs.lastRecall ? relativeFromIso(srs.lastRecall) : 'never'}
                  </dd></div>
                <div><dt>Due</dt>
                  <dd title={srs.dueAt ?? undefined}>
                    {srs.dueAt ? relativeFromIso(srs.dueAt) : '—'}
                    {srs.overdueDays > 0 && <span className="cd-overdue"> overdue</span>}
                  </dd></div>
                <div><dt>Scheduler</dt><dd>{data.algorithm}</dd></div>
                {srs.fsrs && data.algorithm === 'fsrs' && (
                  <div><dt>Difficulty</dt>
                    <dd>{srs.fsrs.difficulty?.toFixed(1) ?? '—'} / 10</dd></div>
                )}
              </dl>

              <button type="button" className="cd-edit-btn" onClick={() => setEditing(true)}>
                Edit card
              </button>
            </div>
          </div>

          {data.flags?.length > 0 && (
            <section className="cd-section">
              <h3 className="cd-section-title">Card health</h3>
              <ul className="cd-flags">
                {data.flags.map((f) => (
                  <CardFlag key={f.id} flag={f} hash={hash} onDismissed={load} />
                ))}
              </ul>
            </section>
          )}

          <section className="cd-section">
            <h3 className="cd-section-title">Predicted recall</h3>
            {data.curve
              ? <RetentionCurve curve={data.curve} />
              : <p className="cd-empty">No curve yet — this card hasn&rsquo;t been reviewed.</p>}
          </section>

          <section className="cd-section">
            <h3 className="cd-section-title">Review history</h3>
            <ReviewStrip history={data.history} />
          </section>
        </div>
      ))}
    </Modal>
  );
}
