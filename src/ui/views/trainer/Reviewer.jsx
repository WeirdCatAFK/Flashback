/**
 * Reviewer — the live card on its stage: the reducing deck behind it, the level
 * pop over it, the reveal hint, the grade buttons and the source link. State and
 * grading live in useReviewer.js; this is the markup.
 */

import { mediaFileSrc } from '../../api/media';
import Flashcard from '../../components/flashcard/Flashcard';
import { formatKeyLabel } from '../../keybindings';
import { useT } from '../../translations/index';
import { displayCardFor } from './cards';
import useReviewer from './useReviewer';

const MAX_DECK = 5;

/** The faint stack behind the live card: one card-back per remaining card, capped. */
function CardDeck({ remaining }) {
  const n = Math.min(remaining, MAX_DECK);
  return (
    <div className="card-deck" aria-hidden="true">
      {Array.from({ length: n }).map((_, i) => (
        <span key={i} className="card-deck-card" style={{ '--i': n - i }} />
      ))}
    </div>
  );
}

/** The level change floating over the card after a grade. */
export function GradePop({ pop, top }) {
  const { t } = useT();
  if (!pop) return null;
  const up = pop.kind === 'up';
  return (
    <div
      className={`grade-pop grade-pop--${up ? 'up' : 'down'}`}
      key={pop.id}
      style={top != null ? { top: `${top}px` } : undefined}
    >
      <span className="grade-pop-arrow">{up ? '↑' : '↓'}</span>
      <span className="grade-pop-level">{t('Lv {n}', { n: pop.toLevel })}</span>
    </div>
  );
}

export default function Reviewer({ card, remaining, isActive, stageRef, onResult, onViewSource, onSaveError, onFlagged, onUndo, canUndo, session }) {
  const { t } = useT();
  const r = useReviewer({ card, isActive, session, onResult, onViewSource, onSaveError, onFlagged });
  const cardType = card.cardType ?? 'basic';

  return (
    <div className="trainer-reviewer">
      <p className="trainer-card-meta">
        <strong>{t('Level {n}', { n: card.level ?? 0 })}</strong>
        {' · '}{card.category ?? t('uncategorized')}
        {card.isNew ? ` · ${t('New')}` : ''}
        {cardType !== 'basic' && <span className="badge badge--accent">{cardType.replace('_', ' ')}</span>}
      </p>
      <div className="card-stage" ref={stageRef}>
        <CardDeck remaining={remaining} />
        <Flashcard
          ref={r.cardRef}
          card={displayCardFor(card)}
          face={r.flipped ? 'back' : 'front'}
          onFlip={(next) => r.setFlipped(next === 'back')}
          onSwipe={r.swipe}
          onTypeCheck={r.typeCheck}
          resolveMedia={(ref) => mediaFileSrc(card.documentPath, ref)}
        />
      </div>

      {!r.flipped && !r.isTypeAnswer && (
        <p className="trainer-hint">
          {t('Press')} <kbd>{formatKeyLabel(r.keymap['trainer.reveal']?.[0] ?? 'Space')}</kbd> {t('or click to reveal')}
        </p>
      )}
      {!r.flipped && r.isTypeAnswer && (
        <p className="trainer-hint">{t('Enter to check · Shift+Enter for newline')}</p>
      )}
      {r.flipped && r.isTypeAnswer && (
        <div className={`type-answer-verdict type-answer-verdict--${r.isCorrect ? 'correct' : 'wrong'}`}>
          {r.isCorrect
            ? t('Correct!')
            : <span> {t('You typed:')} <em>&quot;{r.typedAnswer}&quot;</em></span>}
        </div>
      )}

      {r.flipped && (
        <div className="trainer-grades">
          {Object.entries(r.grades).map(([key, g]) => (
            <button type="button" key={key} className={`trainer-grade trainer-grade--${key}`} onClick={() => r.gradeWithAnimation(key)}>
              {r.keymap[g.action]?.[0] && <kbd className="grade-key">{formatKeyLabel(r.keymap[g.action][0])}</kbd>}
              <span className="grade-label">{g.label}</span>
              {g.level && <span className="grade-hint">{t('Lv {n}', { n: g.level(card.level ?? 0) })}</span>}
            </button>
          ))}
          <button
            type="button"
            className="trainer-grade trainer-grade--undo"
            onClick={onUndo}
            disabled={!canUndo}
            title={t('Take back your last grade and review that card again')}
          >
            {r.keymap['trainer.undo']?.[0] && <kbd className="grade-key">{formatKeyLabel(r.keymap['trainer.undo'][0])}</kbd>}
            <span className="grade-label">Undo</span>
          </button>
        </div>
      )}

      {card.documentPath && (
        <div className="trainer-source-row">
          <button type="button" className="btn btn--ghost btn--sm" onClick={onViewSource}>
            {r.keymap['trainer.viewSource']?.[0] && (
              <kbd className="trainer-source-key">{formatKeyLabel(r.keymap['trainer.viewSource'][0])}</kbd>
            )}
            {t('View source ↗')}
          </button>
        </div>
      )}
    </div>
  );
}
