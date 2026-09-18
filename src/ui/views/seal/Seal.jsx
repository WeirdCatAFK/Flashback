/**
 * Seal — the workspace's version history: the main-thread ribbon, loose pages,
 * the Vault Doctor and the seal log, plus the restore flow. After a restore the
 * SQLite index diverges from the restored files (HEAD equals the working tree,
 * so drift inspection is blind to it), hence the sync banner.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { rollback } from '../../api/seal';
import { syncIndex } from '../../api/doctor';
import { invalidateData } from '../../utils/dataBus';
import { useT } from '../../translations/index';
import useSealLog from './useSealLog';
import useDrift from './useDrift';
import useDoctorCheck from './useDoctorCheck';
import SealTimeline, { SealOverviewRibbon } from './SealTimeline';
import LoosePagesPanel from './LoosePagesPanel';
import VaultDoctorPanel from './VaultDoctorPanel';
import { RollbackConfirmModal } from './SealDialogs';
import './Seal.css';

export default function SealView({ isActive = false }) {
    const { t } = useT();
    const {
        log,
        loading: logLoading,
        loadingMore,
        hasMore,
        error: logError,
        refresh: refreshLog,
        loadMore,
    } = useSealLog(isActive);
    const { drift, loading: driftLoading, error: driftError, refresh: refreshDrift } = useDrift(isActive);
    const { report: doctorReport, loading: doctorLoading, error: doctorError, run: runDoctorCheck } = useDoctorCheck();

    const [confirmTarget, setConfirmTarget] = useState(null);
    const [rollbackDone, setRollbackDone] = useState(false);
    const [highlightOid, setHighlightOid] = useState(null);
    const highlightTimer = useRef(null);

    useEffect(() => () => {
        if (highlightTimer.current) clearTimeout(highlightTimer.current);
    }, []);

    const handleOverviewSelect = useCallback((oid) => {
        document.getElementById(`seal-entry-${oid}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setHighlightOid(oid);
        if (highlightTimer.current) clearTimeout(highlightTimer.current);
        highlightTimer.current = setTimeout(() => setHighlightOid(null), 1600);
    }, []);

    const handleRollback = async (ref) => {
        await rollback(ref);
        setConfirmTarget(null);
        setRollbackDone(true);
        refreshLog();
        refreshDrift();
        invalidateData();
    };

    const [bannerSyncing, setBannerSyncing] = useState(false);
    const handleBannerSync = async () => {
        setBannerSyncing(true);
        try {
            await syncIndex(false);
            setRollbackDone(false);
            refreshDrift();
            invalidateData();
            if (doctorReport) runDoctorCheck();
        } finally {
            setBannerSyncing(false);
        }
    };

    return (
        <div className="seal-view">
            {rollbackDone && (
                <div className="seal-restart-banner">
                    <span className="seal-restart-message">
                        {t('Restore complete. Flashback’s document index is now out of date — sync it to the restored files.')}
                    </span>
                    <div className="seal-restart-actions">
                        <button
                            type="button"
                            className="btn btn--primary btn--sm"
                            onClick={handleBannerSync}
                            disabled={bannerSyncing}
                        >
                            {bannerSyncing ? t('Syncing…') : t('Sync index now')}
                        </button>
                        <button type="button" className="btn btn--sm" onClick={() => setRollbackDone(false)} disabled={bannerSyncing}>
                            {t('Later')}
                        </button>
                    </div>
                </div>
            )}

            {!logLoading && log.length > 0 && (
                <section className="seal-section">
                    <h2 className="eyebrow seal-eyebrow">{t('Main thread')}</h2>
                    <SealOverviewRibbon log={log} onSelect={handleOverviewSelect} />
                </section>
            )}

            <LoosePagesPanel drift={drift} loading={driftLoading} error={driftError} onRefresh={refreshDrift} />

            <VaultDoctorPanel
                report={doctorReport}
                loading={doctorLoading}
                error={doctorError}
                onCheck={runDoctorCheck}
                onSynced={() => { refreshLog(); refreshDrift(); }}
                onRebuilt={() => { refreshLog(); refreshDrift(); }}
            />

            <section className="seal-section">
                <h2 className="eyebrow seal-eyebrow">{t('Seal log')}</h2>
                <p className="seal-log-note">
                    {t('Highlights, flashcards and tags are saved with the document, so changing one shows up here even though the text itself is untouched.')}
                </p>
                <SealTimeline
                    log={log}
                    loading={logLoading}
                    loadingMore={loadingMore}
                    hasMore={hasMore}
                    error={logError}
                    highlightOid={highlightOid}
                    onRollback={setConfirmTarget}
                    onLoadMore={loadMore}
                />
            </section>

            {confirmTarget && (
                <RollbackConfirmModal
                    commit={confirmTarget}
                    newerCount={Math.max(0, log.findIndex(c => c.oid === confirmTarget.oid))}
                    onCancel={() => setConfirmTarget(null)}
                    onConfirm={handleRollback}
                />
            )}
        </div>
    );
}
