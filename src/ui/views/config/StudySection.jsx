/**
 * StudySection — how this vault is studied: the scheduler (three side by side, each
 * described in the row's hint), FSRS's retention and fitting while FSRS is on, the order
 * cards come in, new cards a day, and the Diary. All vault-scoped preferences
 * (useSrsPrefs.js), applied as they change.
 *
 * Changing the scheduler asks first, right under the row: carrying progress over maps
 * each card's gap to the new scheduler (`migrateProgress`), starting fresh treats every
 * card as new.
 */

import { useState } from 'react';
import SegmentedControl from '../../components/base/SegmentedControl';
import Stepper from '../../components/base/Stepper';
import Toggle from '../../components/base/Toggle';
import ProgressDialog from '../../components/base/ProgressDialog';
import { migrateProgress } from '../../api/srs';
import { useT } from '../../translations/index';
import { Rich } from '../../translations/components.jsx';
import ConfigRow from './ConfigRow';
import FsrsOptimizer from './FsrsOptimizer';

/** Display name for a scheduler id. */
const ALGO_LABEL = { leitner: 'Leitner', sm2: 'SM-2', fsrs: 'FSRS' };

/** New cards a day moves in fives, within what the Trainer accepts. */
const NEW_STEP = 5;
const NEW_MAX = 200;

function algoHint(id, t) {
  switch (id) {
    case 'leitner': return t('Cards move up a box when you remember them and back to the first when you don’t; each box doubles the gap.');
    case 'sm2': return t('Each card has an ease factor that grows or shrinks with your grades and stretches the gap.');
    case 'fsrs': return t('A memory model that predicts when you’re about to forget each card, fitted to your own history.');
    default: return '';
  }
}

function orderHint(order, t) {
  switch (order) {
    case 'interleaved': return t('Cards from the same document, tag or folder are spread apart, so each one is recalled on its own.');
    case 'shuffle': return t('Random order within each category-priority level.');
    case 'priority': return t('Foundational cards first, then in the order they were created.');
    default: return undefined;
  }
}

export default function StudySection({ prefs, diary, studyRecord }) {
  const { t } = useT();
  const [pending, setPending] = useState(null);
  const [migrating, setMigrating] = useState(false);
  const { algorithm, applyAlgorithm, maxNew, setMaxNew, retention, setRetention, order, setOrder } = prefs;

  const choose = (next) => setPending(next === algorithm ? null : next);
  const confirm = async (carryOver) => {
    const to = pending;
    setPending(null);
    if (carryOver) {
      setMigrating(true);
      try { await migrateProgress(algorithm, to); } catch {}
      setMigrating(false);
    }
    applyAlgorithm(to);
  };

  return (
    <>
      <ConfigRow id="scheduler" hint={algoHint(pending ?? algorithm, t)}>
        <SegmentedControl
          label={t('Scheduler')}
          value={pending ?? algorithm}
          onChange={choose}
          options={Object.entries(ALGO_LABEL).map(([value, label]) => ({ value, label }))}
        />
      </ConfigRow>
      {pending && (
        <div className="cf-confirm" role="alert">
          <p>
            <Rich text={t('Switch to {algorithm}?')} values={{ algorithm: <b>{ALGO_LABEL[pending]}</b> }} />{' '}
            {t('Carrying progress over maps each card’s current gap to the nearest equivalent in {algorithm}. Starting fresh treats every card as new.', { algorithm: ALGO_LABEL[pending] })}
          </p>
          <div className="cf-confirm__acts">
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setPending(null)}>{t('Cancel')}</button>
            <button type="button" className="btn btn--quiet btn--sm" onClick={() => confirm(false)}>{t('Start fresh')}</button>
            <button type="button" className="btn btn--quiet-accent btn--sm" onClick={() => confirm(true)} autoFocus>{t('Carry over progress')}</button>
          </div>
        </div>
      )}

      {algorithm === 'fsrs' && (
        <>
          <ConfigRow id="retention" htmlFor="cf-retention">
            <span className="cf-range">
              <input id="cf-retention" type="range" min={0.7} max={0.97} step={0.01} value={retention}
                onChange={(e) => setRetention(e.target.value)} />
              <b>{Math.round(retention * 100)}%</b>
            </span>
          </ConfigRow>
          <FsrsOptimizer />
        </>
      )}

      <ConfigRow id="order" htmlFor="cf-order" hint={orderHint(order, t)}>
        <select id="cf-order" className="field field--sm cf-select" value={order} onChange={(e) => setOrder(e.target.value)}>
          <option value="interleaved">{t('Interleaved')}</option>
          <option value="shuffle">{t('Shuffled')}</option>
          <option value="priority">{t('By category priority')}</option>
        </select>
      </ConfigRow>

      <ConfigRow id="maxNew">
        <Stepper
          label={t('New cards a day')}
          display={maxNew}
          onDecrease={() => setMaxNew(Math.max(0, maxNew - NEW_STEP))}
          onIncrease={() => setMaxNew(Math.min(NEW_MAX, maxNew + NEW_STEP))}
          canDecrease={maxNew > 0}
          canIncrease={maxNew < NEW_MAX}
        />
      </ConfigRow>

      <ConfigRow id="diary">
        <Toggle checked={diary.enabled} onChange={diary.setEnabled} ariaLabel={studyRecord.prefLabel} />
      </ConfigRow>

      {migrating && (
        <ProgressDialog title={t('Translating progress…')} statusText={t('Mapping intervals to the new algorithm')} progress={0} processing />
      )}
    </>
  );
}
