import { useEffect, useState } from 'react';
import { mediaFileSrc } from '../../api/media';
import Flashcard from '../../components/flashcard/Flashcard';
import { formatKeyLabel } from '../../utils/keybindings';
import { useT } from '../../translations/index';
import { displayCardFor, sourceTitle } from './cards';
import { previewGap } from './grading';
import { formatGap, formatWhen } from './session';
import useReviewer from './useReviewer';

const MAX_PILE = 5;

function CardPile({ remaining }) {
  const n = Math.min(remaining, MAX_PILE);
  return (
    <div className="card-pile" aria-hidden="true">
      {Array.from({ length: n }).map((_, i) => (
        <span key={i} className="card-pile-card" style={{ '--i': n - i }} />
      ))}
    </div>
  );
}

export function GradePop({ pop, top }) {
  if (!pop) return null;
  return (
    <div className="grade-pop" key={pop.id} style={top != null ? { top: `${top}px` } : undefined} aria-live="polite">
      <span className={`grade-pop-word grade-pop-word--${pop.key}`}>{pop.word}</span>
      {pop.to && (
        <span className="grade-pop-gap">
          <span className="grade-pop-from">{pop.from}</span>
          <span className="grade-pop-arrow" aria-hidden="true">→</span>
          <span className={`grade-pop-to${pop.missed ? ' grade-pop-to--missed' : ''}`}>
            <GapTicker key={`${pop.id}:${pop.toDays}`} from={pop.fromDays} to={pop.toDays} label={pop.to} />
          </span>
        </span>
      )}
    </div>
  );
}

const TICK_DELAY = 120;
const TICK_MS = 420;

function GapTicker({ from, to, label }) {
  const { t } = useT();
  const still = from == null || to == null || from === to
    || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const [value, setValue] = useState(from);
  useEffect(() => {
    if (still) return undefined;
    let raf = 0;
    const start = performance.now() + TICK_DELAY;
    const step = (now) => {
      const k = Math.min(1, Math.max(0, (now - start) / TICK_MS));
      setValue(from + (to - from) * (1 - (1 - k) ** 3));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [from, to, still]);
  return still ? label : formatGap(value, t);
}

export default function Reviewer({ card, remaining, isActive, holding = false, stageRef, onResult, onInterval, onReplied, onViewSource, onSaveError, onFlagged, onUndo, canUndo, session, algorithm }) {
  const { t, tp } = useT();
  const r = useReviewer({ card, isActive, session, onResult, onInterval, onReplied, onViewSource, onSaveError, onFlagged });
  const revealKey = r.keymap['trainer.reveal']?.[0] ?? 'Space';
  const undoKey = r.keymap['trainer.undo']?.[0];
  const sourceKey = r.keymap['trainer.viewSource']?.[0];

  return (
    <div className="trainer-reviewer">
      <div className="card-slot">
        <div className="card-stage" ref={stageRef}>
          <CardPile remaining={remaining} />
          {!holding && <Flashcard
            ref={r.cardRef}
            card={displayCardFor(card)}
            face={r.flipped ? 'back' : 'front'}
            onFlip={(next) => r.setFlipped(next === 'back')}
            onSwipe={r.swipe}
            onTypeCheck={r.typeCheck}
            source={sourceTitle(card.documentPath)}
            verdict={r.isTypeAnswer && r.flipped ? { typed: r.typedAnswer, correct: r.isCorrect } : null}
            resolveMedia={(ref) => mediaFileSrc(card.documentPath, ref)}
          />}
        </div>
      </div>

      <div className="trainer-grades" aria-live="polite">
        {!r.flipped && (
          <span className="trainer-hint">
            {r.isTypeAnswer
              ? <>{t('Type your answer, then press')} <kbd>{formatKeyLabel('Enter')}</kbd></>
              : <>{t('Turn the card over: click or')} <kbd>{formatKeyLabel(revealKey)}</kbd></>}
          </span>
        )}
        {r.flipped && Object.entries(r.grades).map(([key, g]) => {
          const when = formatWhen(previewGap(card, key, algorithm), t, tp);
          const shortcut = r.keymap[g.action]?.[0];
          return (
            <button type="button" key={key} className={`trainer-grade trainer-grade--${key}`} onClick={() => r.gradeWithAnimation(key)}>
              <span className="trainer-grade-label">{g.label}</span>
              <span className="trainer-grade-meta">
                {when}{when && shortcut ? ' · ' : ''}{shortcut && <kbd>{formatKeyLabel(shortcut)}</kbd>}
              </span>
            </button>
          );
        })}
      </div>

      <div className="trainer-actions">
        <button type="button" className="link-action" onClick={onUndo} disabled={!canUndo}
          title={t('Take back your last grade and review that card again')}>
          {t('Undo')}{undoKey && <kbd>{formatKeyLabel(undoKey)}</kbd>}
        </button>
        {card.documentPath && (
          <button type="button" className="link-action" onClick={onViewSource}>
            {t('View source')}{sourceKey && <kbd>{formatKeyLabel(sourceKey)}</kbd>}
          </button>
        )}
      </div>
    </div>
  );
}
