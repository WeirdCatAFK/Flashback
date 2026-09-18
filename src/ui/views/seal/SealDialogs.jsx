/**
 * The Seal view's confirmations: restoring the workspace to a commit, syncing the
 * index to disk (with the seal-drift option that keeps unsealed deletions from
 * resurrecting), and rebuilding the index outright, which loses review logs.
 */

import { useState } from 'react';
import Modal from '../../components/base/Modal';
import { useT } from '../../translations/index';
import { Rich } from '../../translations/components.jsx';
import { describeCommit, formatOid, formatCommitTime } from './describe.js';
import { ActionGlyph } from './SealTimeline';

export function RollbackConfirmModal({ commit, newerCount, onCancel, onConfirm }) {
    const tr = useT();
    const { t, tp } = tr;
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    const { variant, detail } = describeCommit(commit, tr);
    const { absolute } = formatCommitTime(commit.commit.author?.timestamp, tr);

    const handleConfirm = async () => {
        setBusy(true);
        setError(null);
        try {
            await onConfirm(commit.oid);
        } catch (err) {
            setError(err.message ?? t('Restore failed'));
            setBusy(false);
        }
    };

    return (
        <Modal
            title={t('Restore this version')}
            size="md"
            onClose={onCancel}
            dismissible={!busy}
            footer={
                <>
                    <button type="button" className="btn" onClick={onCancel} disabled={busy}>
                        {t('Cancel')}
                    </button>
                    <button type="button" className="btn btn--danger" onClick={handleConfirm} disabled={busy}>
                        {busy ? t('Restoring…') : t('Restore')}
                    </button>
                </>
            }
        >
            <div className="seal-modal-target">
                <span className={`seal-stamp seal-stamp--${variant} seal-stamp--sm`} aria-hidden="true">
                    <ActionGlyph action={variant} />
                </span>
                <span>{detail}</span>
                <span className="seal-entry-oid" title={commit.oid}>{formatOid(commit.oid)}</span>
                <span className="seal-entry-time">{absolute}</span>
            </div>

            <p className="seal-modal-warning">
                {t('This restores the workspace to this point in time and discards any uncommitted changes on disk.')}
                {newerCount > 0 && (
                    <> {tp('If you keep editing afterward, the {n} entry newer than this point will no longer appear in the log.',
                        'If you keep editing afterward, the {n} entries newer than this point will no longer appear in the log.',
                        newerCount)}</>
                )}
            </p>

            <p className="seal-modal-hint">
                {t('Only document content and structure roll back. Flashcard review history and scheduling are stored separately and are not affected.')}
            </p>

            {error && <div className="seal-error">{error}</div>}
        </Modal>
    );
}

/**
 * Flattens a checkIndex() report into a flat list of labelled path groups so the panel
 * can render them uniformly. Tone drives the accent color (reusing the loose-page palette).
 */

export function SyncConfirmModal({ report, onCancel, onConfirm }) {
    const { t } = useT();
    const [sealDrift, setSealDrift] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    const handleConfirm = async () => {
        setBusy(true);
        setError(null);
        try {
            await onConfirm(sealDrift);
        } catch (err) {
            setError(err.message ?? t('Sync failed'));
            setBusy(false);
        }
    };

    const hasConflicts = report.documents.hashConflicts.length > 0;

    return (
        <Modal
            title={t('Sync index to files')}
            size="md"
            onClose={onCancel}
            dismissible={!busy}
            footer={
                <>
                    <button type="button" className="btn" onClick={onCancel} disabled={busy}>{t('Cancel')}</button>
                    <button type="button" className="btn btn--primary" onClick={handleConfirm} disabled={busy}>
                        {busy ? t('Syncing…') : t('Sync index')}
                    </button>
                </>
            }
        >
            <p className="seal-modal-warning">
                {t('Your files on disk are the source of truth. This picks up anything new, refreshes documents that changed outside Flashback, and forgets things that were deleted. Review progress is never lowered.')}
                {hasConflicts && (
                    <> {t('Documents that share a duplicate identity are left untouched and reported.')}</>
                )}
            </p>

            <label className="seal-modal-checkbox">
                <input
                    type="checkbox"
                    checked={sealDrift}
                    onChange={e => setSealDrift(e.target.checked)}
                    disabled={busy}
                />
                {t('Seal out-of-band changes into history (recommended)')}
            </label>
            <p className="seal-modal-hint">
                {sealDrift
                    ? t('Changes made outside Flashback are bound into the seal log as one entry, so a later rollback treats them as real history.')
                    : t('Changes made outside Flashback stay unsealed — a later rollback may undo or resurrect them.')}
            </p>

            {error && <div className="seal-error">{error}</div>}
        </Modal>
    );
}

/**
 * Type-to-confirm because rebuild wipes and regenerates the whole derived layer: card
 * levels and ease survive (they live in the sidecars) but per-review ReviewLogs history
 * is lost.
 */

export function RebuildConfirmModal({ onCancel, onConfirm }) {
    const { t } = useT();
    const [typed, setTyped] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const armed = typed.trim().toUpperCase() === 'REBUILD';

    const handleConfirm = async () => {
        if (!armed) return;
        setBusy(true);
        setError(null);
        try {
            await onConfirm();
        } catch (err) {
            setError(err.message ?? t('Rebuild failed'));
            setBusy(false);
        }
    };

    return (
        <Modal
            title={t('Rebuild index from files')}
            size="md"
            onClose={onCancel}
            dismissible={!busy}
            footer={
                <>
                    <button type="button" className="btn" onClick={onCancel} disabled={busy}>{t('Cancel')}</button>
                    <button type="button" className="btn btn--danger" onClick={handleConfirm} disabled={busy || !armed}>
                        {busy ? t('Rebuilding…') : t('Rebuild index')}
                    </button>
                </>
            }
        >
            <p className="seal-modal-warning">
                <Rich
                    text={t('This discards the entire document index and regenerates it from your {sidecar} files. Use it only when the index is corrupt or badly out of sync — {sync} is the safe everyday choice.')}
                    values={{
                        sidecar: <code>.flashback</code>,
                        sync: <strong>{t('Sync index')}</strong>,
                    }}
                />
            </p>
            <p className="seal-modal-hint">
                {t('Card levels and ease survive, but each card’s review history is lost and scheduling restarts from the saved levels.')}
            </p>

            <label className="seal-doctor-type-label">
                <Rich
                    text={t('Type {token} to confirm')}
                    values={{ token: <span className="seal-doctor-type-token">REBUILD</span> }}
                />
                <input
                    className="seal-doctor-type-input"
                    value={typed}
                    onChange={e => setTyped(e.target.value)}
                    disabled={busy}
                    autoFocus
                    spellCheck={false}
                />
            </label>

            {error && <div className="seal-error">{error}</div>}
        </Modal>
    );
}
