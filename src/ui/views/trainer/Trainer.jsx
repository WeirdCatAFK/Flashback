/**
 * Trainer — the study session view. Composes the scope bar, the settings row, the
 * progress line, the live Reviewer and the summaries; every piece of state comes
 * from useTrainerSession.
 */

import CardDetailModal from '../../components/flashcard/CardDetailModal';
import { LoadingState, ErrorState } from '../../components/base/StateView';
import ProgressBar from '../../components/base/ProgressBar';
import Toggle from '../../components/base/Toggle';
import { useT } from '../../translations/index';
import useTrainerSession from './useTrainerSession';
import ScopeBar from './ScopeBar';
import Reviewer, { GradePop } from './Reviewer';
import SessionSummary, { EmptySession } from './SessionSummary';
import './Trainer.css';

export default function FlashcardsTrainer({ isActive, studySession, onOpenSource }) {
  const { t } = useT();
  const s = useTrainerSession({ isActive, studySession, onOpenSource });
  const { controls, session, figures } = s;
  const { sessionDone, lastSession, queue } = session;

  return (
    <div className="trainer-view">
      <h2>{t('Trainer')}</h2>

      {s.loading && !sessionDone && <LoadingState message={t('Loading cards…')} />}
      {s.error && <ErrorState error={s.error} title={t('Couldn’t load your cards')} onRetry={s.refresh} />}

      {s.saveError && (
        <div className="trainer-save-error" role="alert">
          <span>{t('Couldn’t save your last review — {reason}.', { reason: s.saveError.message || t('the change may not be recorded') })}</span>
          <button type="button" className="btn-close" onClick={() => s.setSaveError(null)} aria-label={t('Dismiss')}>×</button>
        </div>
      )}

      {s.result && !sessionDone && (
        <p className="trainer-session-info">
          {t('{due} due · {new} new · {algorithm}', { due: s.result.counts.due, new: s.result.counts.new, algorithm: s.result.algorithm })}
        </p>
      )}

      <ScopeBar controls={controls} />

      <div className="trainer-settings-row">
        <div className="trainer-setting">
          <label className="trainer-setting-label" htmlFor="trainer-max-new">{t('Max new')}</label>
          <input
            id="trainer-max-new"
            type="number"
            className="field field--sm trainer-setting-input"
            min="0"
            max="500"
            value={controls.maxNewDisplay}
            onChange={(e) => controls.setMaxNewDisplay(e.target.value)}
            onBlur={() => controls.applyMaxNew(controls.maxNewDisplay)}
            onKeyDown={(e) => { if (e.key === 'Enter') controls.applyMaxNew(controls.maxNewDisplay); }}
          />
        </div>
        <div className="trainer-setting">
          <Toggle checked={controls.readOnly} onChange={controls.applyReadOnly} label={t('Only what I’ve read')} />
        </div>
      </div>

      {s.empty && (
        <EmptySession readOnly={controls.readOnly} scope={controls.scope} result={s.result} onStudyEverything={() => controls.applyReadOnly(false)} />
      )}

      {!sessionDone && queue.length > 0 && (
        <div className="trainer-progress">
          <ProgressBar value={figures.progress} />
          <span className="trainer-progress-text">
            {t('{passed}/{total} cleared · {reviews} reviews', { passed: figures.passed, total: s.cards.length, reviews: figures.reviews })}
            {figures.reviews ? ` · ${t('{pct}% correct', { pct: figures.accuracy })}` : ''}
          </span>
        </div>
      )}

      {sessionDone && lastSession && (
        <SessionSummary
          stats={s.displayStats}
          total={s.displayTotal}
          figures={figures}
          loading={s.loading}
          cardsWaiting={s.cards.length}
          result={s.result}
          flagged={s.flagged}
          onStartNew={s.startNewSession}
          onInspect={s.setInspecting}
        />
      )}

      {s.inspecting && <CardDetailModal hash={s.inspecting} onClose={() => s.setInspecting(null)} />}

      {!sessionDone && s.currentCard && (
        <div className="leitner-arena" ref={s.arenaRef}>
          <Reviewer
            key={s.turn}
            card={s.currentCard}
            remaining={s.remaining}
            isActive={isActive}
            stageRef={s.stageRef}
            onResult={s.handleResult}
            onViewSource={s.handleViewSource}
            onSaveError={s.setSaveError}
            onFlagged={s.handleFlagged}
            onUndo={s.handleUndo}
            canUndo={!!session.lastAction}
            session={{ sessionId: s.sessionId, ...session.presented }}
          />
          <GradePop pop={s.pop} top={s.popTop} />
        </div>
      )}
    </div>
  );
}
