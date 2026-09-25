/**
 * Seal — the workspace's history, read as a short report in two tabs. History is the log
 * (SealHistory.jsx); Health is the maintenance: files changed outside Flashback, and the
 * index check, sync and rebuild (SealHealth.jsx). The Health tab carries the outside-change
 * count, so drift is seen without opening it.
 *
 * After a restore the index still describes the files as they were before (HEAD equals the
 * working tree, so drift inspection is blind to it), hence the sync banner above the report.
 */

import { useState, useEffect, useRef } from 'react';
import { rollback } from '../../api/seal';
import { syncIndex } from '../../api/doctor';
import { invalidateData } from '../../utils/dataBus';
import { useT } from '../../translations/index';
import useSealLog from './useSealLog';
import useDrift from './useDrift';
import useDoctorCheck from './useDoctorCheck';
import { driftCount, runHolding } from './history.js';
import SealHistory from './SealHistory';
import SealHealth from './SealHealth';
import './Seal.css';

/** How long an entry the ribbon jumped to stays lit. */
const FLASH_MS = 1600;

export default function SealView({ isActive = false }) {
  const tr = useT();
  const { t, tp, formatNumber } = tr;
  const sealLog = useSealLog(isActive);
  const { log } = sealLog;
  const { drift, loading: driftLoading, error: driftError, refresh: refreshDrift } = useDrift(isActive);
  const doctor = useDoctorCheck();
  const [tab, setTab] = useState('history');
  const [openRuns, setOpenRuns] = useState(() => new Set());
  const [flash, setFlash] = useState(null);
  const [restored, setRestored] = useState(false);
  const [bannerSyncing, setBannerSyncing] = useState(false);
  const flashTimer = useRef(null);
  const outside = driftCount(drift);

  useEffect(() => () => clearTimeout(flashTimer.current), []);

  const toggleRun = (key) => setOpenRuns((open) => {
    const next = new Set(open);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });

  const jump = (oid) => {
    const run = runHolding(log, oid, tr);
    if (run) setOpenRuns((open) => new Set(open).add(run));
    setFlash(oid);
    setTimeout(() => document.getElementById(`seal-entry-${oid}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), FLASH_MS);
  };

  const restore = async (oid) => {
    await rollback(oid);
    setRestored(true);
    sealLog.refresh();
    refreshDrift();
    invalidateData();
  };

  const syncAfterRestore = async () => {
    setBannerSyncing(true);
    try {
      await syncIndex(false);
      setRestored(false);
      refreshDrift();
      invalidateData();
      if (doctor.report) doctor.run().catch(() => {});
    } finally {
      setBannerSyncing(false);
    }
  };

  return (
    <div className="sl-view">
      {restored && (
        <div className="sl-banner" role="status">
          <span>{t('Restored. The index still describes the files as they were before; sync it to the restored files.')}</span>
          <button type="button" className="btn btn--quiet-accent btn--sm" onClick={syncAfterRestore} disabled={bannerSyncing}>
            {bannerSyncing ? t('Syncing…') : t('Sync now')}
          </button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setRestored(false)} disabled={bannerSyncing}>{t('Later')}</button>
        </div>
      )}
      <article className="sl-page">
        <div className="sl-eyebrow">{t('Workspace history')}</div>
        <h1 className="sl-title">{t('Seal')}</h1>
        <p className="sl-lede">
          {t('Every change to your documents, folders and decks is sealed here, and any seal can be restored. Studying never adds one: reviews live in their own store.')}
        </p>
        <div className="tabs sl-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'history'} onClick={() => setTab('history')}>
            {t('History')} {log.length > 0 && <span>{formatNumber(log.length)}{sealLog.hasMore ? '+' : ''}</span>}
          </button>
          <button type="button" role="tab" aria-selected={tab === 'health'} onClick={() => setTab('health')}>
            {t('Health')}
            {outside > 0 && (
              <b className="sl-flag" title={tp('{n} file changed outside Flashback', '{n} files changed outside Flashback', outside)}>{formatNumber(outside)}</b>
            )}
          </button>
        </div>
        <section role="tabpanel" aria-label={tab === 'history' ? t('History') : t('Health')}>
          {tab === 'history' ? (
            <SealHistory
              log={log}
              loading={sealLog.loading}
              loadingMore={sealLog.loadingMore}
              hasMore={sealLog.hasMore}
              error={sealLog.error}
              onLoadMore={sealLog.loadMore}
              outside={outside}
              onShowHealth={() => setTab('health')}
              openRuns={openRuns}
              onToggleRun={toggleRun}
              flash={flash}
              onJump={jump}
              onRestore={restore}
            />
          ) : (
            <SealHealth
              drift={drift}
              driftLoading={driftLoading}
              driftError={driftError}
              onRefreshDrift={refreshDrift}
              doctor={doctor}
              onChanged={() => { sealLog.refresh(); refreshDrift(); }}
            />
          )}
        </section>
      </article>
    </div>
  );
}
