/**
 * Trainer — the study session view. One top bar (what to study, the session's
 * settings, and the count with the streak), a full-width progress bar, and the
 * stage: the card on its pile, or the summary when there is no card. Every piece
 * of state comes from useTrainerSession; the screen's name is in the title bar,
 * so the view repeats no heading.
 */

import CardDetailModal from '../../components/flashcard/CardDetailModal';
import { LoadingState, ErrorState } from '../../components/base/StateView';
import Stepper from '../../components/base/Stepper';
import Toggle from '../../components/base/Toggle';
import { useT } from '../../translations/index';
import useTrainerSession from './useTrainerSession';
import ScopeBar from './ScopeBar';
import Reviewer, { GradePop } from './Reviewer';
import SessionSummary, { EmptySession } from './SessionSummary';
import { stepBatch, canStepBatch, stepNew, NEW_MAX } from './session';
import './Trainer.css';

const ALGO_LABEL = { leitner: 'Leitner', sm2: 'SM-2', fsrs: 'FSRS' };

/** The session's settings, always in view: Per session, New cards, Only what I've read. */
function SessionSettings({ controls, due }) {
  const { t } = useT();
  const { batchSize, maxNew } = controls;
  return (
    <div className="trainer-settings" role="group" aria-label={t('Session')}>
      <span className="trainer-setting" title={t('How many due cards one session takes; the rest wait for the next batch')}>
        <span>{t('Per session')}</span>
        <Stepper
          label={t('Per session')}
          display={batchSize ? batchSize : t('All')}
          decreaseLabel={t('Fewer cards per session')}
          increaseLabel={t('More cards per session')}
          canDecrease={canStepBatch(batchSize, -1, due)}
          canIncrease={canStepBatch(batchSize, 1, due)}
          onDecrease={() => controls.applyBatch(stepBatch(batchSize, -1, due))}
          onIncrease={() => controls.applyBatch(stepBatch(batchSize, 1, due))}
          onValueClick={batchSize ? () => controls.applyBatch(0) : undefined}
          valueTitle={batchSize ? t('Study all due cards') : undefined}
        />
      </span>
      <span className="trainer-setting">
        <span>{t('New cards')}</span>
        <Stepper
          label={t('New cards')}
          display={maxNew}
          decreaseLabel={t('Fewer new cards')}
          increaseLabel={t('More new cards')}
          canDecrease={maxNew > 0}
          canIncrease={maxNew < NEW_MAX}
          onDecrease={() => controls.applyMaxNew(stepNew(maxNew, -1))}
          onIncrease={() => controls.applyMaxNew(stepNew(maxNew, 1))}
        />
      </span>
      <Toggle checked={controls.readOnly} onChange={controls.applyReadOnly} label={t('Only what I’ve read')} />
    </div>
  );
}

/** Cards remembered out of the batch, and the streak. */
function Meter({ passed, total, streak }) {
  const { t } = useT();
  return (
    <div className="trainer-meter">
      <span className="trainer-count" title={t('{passed} of {total} cards remembered this session', { passed, total })}>
        {passed}<span className="trainer-count-rest"> / {total}</span>
      </span>
      <span key={streak} className={`trainer-streak${streak === 0 ? ' trainer-streak--cold' : ' trainer-streak--bump'}`} title={t('Cards remembered in a row')}>
        ×{streak}
      </span>
    </div>
  );
}

export default function FlashcardsTrainer({ isActive, studySession, onOpenSource, onWriteDiary }) {
  const { t } = useT();
  const s = useTrainerSession({ isActive, studySession, onOpenSource });
  const { controls, session, figures } = s;
  const { sessionDone, lastSession, queue } = session;
  const algorithm = s.result?.algorithm;

  return (
    <div className="trainer-view">
      <div className="trainer-top">
        <div className="trainer-scope">
          <ScopeBar controls={controls} result={s.result} />
          {algorithm && (
            <span className="trainer-algo">
              {ALGO_LABEL[algorithm] ?? algorithm}
              {!s.loading && <> · {t('{n} due', { n: s.cards.length })}</>}
            </span>
          )}
        </div>
        <SessionSettings controls={controls} due={s.cards.length} />
        <Meter passed={figures.passed} total={s.batch.length} streak={s.streak} />
      </div>

      <div className="trainer-track" aria-hidden="true">
        <i style={{ width: `${Math.round((sessionDone ? 1 : figures.progress) * 100)}%` }} />
      </div>

      {s.saveError && (
        <div className="trainer-save-error" role="alert">
          <span>{t('Couldn’t save your last review — {reason}.', { reason: s.saveError.message || t('the change may not be recorded') })}</span>
          <button type="button" className="btn-close" onClick={() => s.setSaveError(null)} aria-label={t('Dismiss')}>×</button>
        </div>
      )}

      <div className="trainer-stage" ref={s.arenaRef}>
        {s.loading && !sessionDone && <LoadingState message={t('Loading cards…')} />}
        {s.error && <ErrorState error={s.error} title={t('Couldn’t load your cards')} onRetry={s.refresh} />}

        {s.empty && (
          <EmptySession readOnly={controls.readOnly} scope={controls.scope} result={s.result} onStudyEverything={() => controls.applyReadOnly(false)} />
        )}

        {sessionDone && lastSession && (
          <SessionSummary
            tally={s.tally}
            loading={s.loading}
            cardsWaiting={s.cards.length}
            batchSize={controls.batchSize}
            result={s.result}
            flagged={s.flagged}
            onNext={s.startNewSession}
            onWriteDiary={onWriteDiary}
            onInspect={s.setInspecting}
          />
        )}

        {!sessionDone && s.currentCard && queue.length > 0 && (
          <Reviewer
            key={s.turn}
            card={s.currentCard}
            remaining={s.remaining}
            isActive={isActive && !s.holding}
            holding={s.holding}
            stageRef={s.stageRef}
            onResult={s.handleResult}
            onInterval={s.handleInterval}
            onReplied={s.handleReplied}
            onViewSource={s.handleViewSource}
            onSaveError={s.setSaveError}
            onFlagged={s.handleFlagged}
            onUndo={s.handleUndo}
            canUndo={!!session.lastAction}
            session={{ sessionId: s.sessionId, ...session.presented }}
            algorithm={algorithm}
          />
        )}
        <GradePop pop={s.pop} top={s.popTop} />
      </div>

      {s.inspecting && <CardDetailModal hash={s.inspecting} onClose={() => s.setInspecting(null)} />}
    </div>
  );
}
