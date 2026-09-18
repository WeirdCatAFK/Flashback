/**
 * VaultDoctorPanel — the index check, its report grouped by what is wrong, and
 * the sync / rebuild actions behind their confirmations.
 */

import { useState } from 'react';
import { useCan } from '../../sessionContext.js';
import { invalidateData } from '../../utils/dataBus';
import { useT } from '../../translations/index';
import { syncIndex, rebuildIndex } from '../../api/doctor';
import { collectDoctorIssues, TONE_CLASS } from './doctor.js';
import { formatOid, LIST_VISIBLE_CAP } from './describe.js';
import { SyncConfirmModal, RebuildConfirmModal } from './SealDialogs';

function DoctorIssueGroup({ label, tone, paths }) {
    const { t } = useT();
    const overflow = paths.length - LIST_VISIBLE_CAP;
    return (
        <div className="seal-loose-group">
            <span className={`seal-loose-group-label ${TONE_CLASS[tone] ?? ''}`}>{label} · {paths.length}</span>
            <ul>
                {paths.slice(0, LIST_VISIBLE_CAP).map((p, i) => <li key={`${p}-${i}`}>{p}</li>)}
                {overflow > 0 && <li className="seal-loose-more">{t('+{n} more', { n: overflow })}</li>}
            </ul>
        </div>
    );
}

/**
 * A run-once, on-demand walk of the whole vault — heavier than inspectDrift (integrity
 * check + full workspace walk + DB joins), so it is button-triggered rather than auto-run
 * on every tab activation.
 */

function DoctorSummary({ report }) {
    const { t } = useT();
    const c = report.counts;
    const items = [
        [t('Documents'), c.documents],
        [t('Folders'), c.folders],
        [t('Flashcards'), c.flashcards],
        [t('Standalone'), c.standaloneCards],
        [t('Pending links'), c.pendingLinks],
    ];
    return (
        <div className="seal-doctor-counts">
            {items.map(([label, n]) => (
                <span key={label} className="seal-doctor-count">
                    <span className="seal-doctor-count-n">{n}</span>
                    <span className="seal-doctor-count-label">{label}</span>
                </span>
            ))}
        </div>
    );
}

/**
 * Reconcile the index to disk. The seal-drift checkbox defaults on: unsealed out-of-band
 * deletions would resurrect on a later rollback, so binding them into history is the safe
 * default (the loose-pages panel above is where the user sees that drift).
 */

function DoctorResult({ result }) {
    const { t, tp } = useT();
    if (!result) return null;

    const warnLine = (warnings) => tp(
        '{n} warning — {first}', '{n} warnings — {first}',
        warnings.length, { first: warnings[0] },
    );

    if (result.kind === 'sync') {
        const a = result.actions;
        const parts = [];
        if (a.foldersIndexed) parts.push(t('{n} folders indexed', { n: a.foldersIndexed }));
        if (a.documentsIndexed) parts.push(t('{n} documents indexed', { n: a.documentsIndexed }));
        if (a.documentsReindexed) parts.push(t('{n} reindexed', { n: a.documentsReindexed }));
        if (a.foldersRemoved) parts.push(t('{n} folders dropped', { n: a.foldersRemoved }));
        if (a.documentsRemoved) parts.push(t('{n} documents dropped', { n: a.documentsRemoved }));
        if (a.mediaRegistered) parts.push(t('{n} media registered', { n: a.mediaRegistered }));
        if (a.mediaRowsRemoved) parts.push(t('{n} media rows dropped', { n: a.mediaRowsRemoved }));
        const summary = parts.length
            ? parts.join(' · ')
            : t('Index already matched the files — nothing to change.');
        return (
            <div className="seal-doctor-result">
                <span className="seal-doctor-result-head">{t('Sync complete')}</span>
                <span className="seal-doctor-result-body">{summary}</span>
                {result.sealedOid && (
                    <span className="seal-doctor-result-meta">
                        {t('Sealed as {oid}', { oid: formatOid(result.sealedOid) })}
                    </span>
                )}
                {result.warnings?.length > 0 && (
                    <span className="seal-doctor-result-warn">{warnLine(result.warnings)}</span>
                )}
            </div>
        );
    }
    const s = result.summary;
    return (
        <div className="seal-doctor-result">
            <span className="seal-doctor-result-head">{t('Rebuild complete')}</span>
            <span className="seal-doctor-result-body">
                {t('{documents} documents · {folders} folders · {cards} cards · {decks} decks rebuilt', {
                    documents: s.documentsIndexed,
                    folders: s.foldersIndexed,
                    cards: s.flashcards,
                    decks: s.decks,
                })}
            </span>
            <span className="seal-doctor-result-meta">
                {t('{standalone} standalone restored · {ease} ease factors preserved · {media} media', {
                    standalone: s.standaloneCardsRestored,
                    ease: s.easeFactorsRestored,
                    media: s.mediaRegistered,
                })}
            </span>
            {result.warnings?.length > 0 && (
                <span className="seal-doctor-result-warn">{warnLine(result.warnings)}</span>
            )}
        </div>
    );
}

export default function VaultDoctorPanel({ report, loading, error, onCheck, onSynced, onRebuilt }) {
    const { t } = useT();
    const canRepair = useCan('rebuildIndex');
    const [modal, setModal] = useState(null);
    const [result, setResult] = useState(null);

    const issues = report ? collectDoctorIssues(report, t) : [];
    const integrityOk = report?.db.integrity === 'ok';
    const clean = report && integrityOk && issues.length === 0;

    const handleSync = async (sealDrift) => {
        const res = await syncIndex(sealDrift);
        setModal(null);
        setResult({ kind: 'sync', ...res });
        invalidateData();
        onSynced?.();
        await onCheck();
    };

    const handleRebuild = async () => {
        const res = await rebuildIndex();
        setModal(null);
        setResult({ kind: 'rebuild', ...res });
        invalidateData();
        onRebuilt?.();
        await onCheck();
    };

    return (
        <section className="seal-section">
            <div className="seal-section-head">
                <h2 className="eyebrow seal-eyebrow">{t('Vault doctor')}</h2>
                <button type="button" className="btn" onClick={() => { setResult(null); onCheck(); }} disabled={loading}>
                    {loading ? t('Checking…') : report ? t('Re-check index') : t('Check index')}
                </button>
            </div>

            <div className="seal-loose-card">
                {error && <div className="seal-error">{error}</div>}

                {!report && !error && (
                    <p className="seal-loose-empty">{t('Check the index to compare every file on disk against Flashback’s database.')}</p>
                )}

                {report && (
                    <>
                        <div className="seal-doctor-status">
                            <span className={`seal-doctor-badge ${integrityOk ? 'seal-doctor-badge--ok' : 'seal-doctor-badge--bad'}`}>
                                {integrityOk
                                    ? t('Database integrity OK')
                                    : t('Integrity: {status}', { status: report.db.integrity })}
                            </span>
                            <DoctorSummary report={report} />
                        </div>

                        {clean && (
                            <p className="seal-loose-empty">{t('Clean bill of health — the index matches your files exactly.')}</p>
                        )}

                        {!clean && (
                            <div className="seal-loose-groups">
                                {issues.map(g => <DoctorIssueGroup key={g.label} {...g} />)}
                            </div>
                        )}

                        <DoctorResult result={result} />

                        {canRepair ? (
                            <div className="seal-doctor-actions">
                                <button
                                    type="button"
                                    className="btn btn--primary"
                                    onClick={() => setModal('sync')}
                                    disabled={!integrityOk}
                                    title={integrityOk ? undefined : t('Integrity check failed — rebuild the index instead')}
                                >
                                    {t('Sync index now')}
                                </button>
                                <button type="button" className="btn btn--danger-quiet" onClick={() => setModal('rebuild')}>
                                    {t('Rebuild index from files')}
                                </button>
                            </div>
                        ) : (
                            <p className="seal-doctor-note">
                                {t('Repairing the index is the vault owner’s to do — ask them to run a sync or a rebuild.')}
                            </p>
                        )}
                    </>
                )}
            </div>

            {modal === 'sync' && report && (
                <SyncConfirmModal report={report} onCancel={() => setModal(null)} onConfirm={handleSync} />
            )}
            {modal === 'rebuild' && (
                <RebuildConfirmModal onCancel={() => setModal(null)} onConfirm={handleRebuild} />
            )}
        </section>
    );
}
