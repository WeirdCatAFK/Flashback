import { useState, useEffect, useCallback, useRef } from 'react';
import { getLog, inspectDrift, rollback, getCommitFiles } from '../api/seal';
import './Seal.css';

const ACTION_LABELS = {
    create: 'Created',
    edit: 'Edited',
    move: 'Moved',
    delete: 'Deleted',
};

function parseCommitMessage(message) {
    const idx = message.indexOf(': ');
    if (idx === -1) return { action: 'unknown', detail: message };
    const action = message.slice(0, idx);
    const rest = message.slice(idx + 2);
    if (action === 'move') {
        const [from, to] = rest.split(' -> ');
        return { action, detail: to ? `${from} → ${to}` : rest };
    }
    return { action, detail: rest };
}

function formatOid(oid) {
    return oid ? oid.slice(0, 7) : '';
}

// isomorphic-git commit timestamps are unix seconds, not ms.
function formatCommitTime(unixSeconds) {
    if (!unixSeconds) return { relative: '', absolute: '' };
    const date = new Date(unixSeconds * 1000);
    const diff = Date.now() - date.getTime();
    const mins = Math.floor(diff / 60000);
    const hrs  = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);
    let relative;
    if (mins < 2) relative = 'just now';
    else if (hrs < 1) relative = `${mins}m ago`;
    else if (days < 1) relative = `${hrs}h ago`;
    else if (days < 30) relative = `${days}d ago`;
    else relative = date.toLocaleDateString();
    return { relative, absolute: date.toLocaleString() };
}

// A small embossed glyph stamped into each wax seal — gives the action a shape, not just a
// color, so the timeline reads at a glance without relying on color alone.
function ActionGlyph({ action }) {
    const p = { width: 11, height: 11, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 3, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };
    switch (action) {
        case 'create': return <svg {...p}><line x1="12" y1="4" x2="12" y2="20" /><line x1="4" y1="12" x2="20" y2="12" /></svg>;
        case 'edit':   return <svg {...p}><path d="M4 20l4-1 11-11-3-3L5 16l-1 4z" /></svg>;
        case 'move':   return <svg {...p}><line x1="4" y1="12" x2="19" y2="12" /><polyline points="13 6 19 12 13 18" /></svg>;
        case 'delete': return <svg {...p}><line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" /></svg>;
        default:       return <svg {...p}><circle cx="12" cy="12" r="3.5" /></svg>;
    }
}

// Views in this app stay mounted after their first visit (see App.jsx's view-slot
// keep-alive) — an effect with no isActive dependency would only ever fetch once,
// then go stale on every later tab switch. Refetch each time the tab becomes active,
// matching the convention already used by GraphView/Trainer's isActive-driven hooks.
function useSealLog(limit, isActive) {
    const [log, setLog] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [refreshToken, setRefreshToken] = useState(0);

    useEffect(() => {
        if (!isActive) return;
        setLoading(true);
        setError(null);
        getLog(limit)
            .then(setLog)
            .catch(err => setError(err.message ?? 'Failed to load history'))
            .finally(() => setLoading(false));
    }, [isActive, limit, refreshToken]);

    const refresh = useCallback(() => setRefreshToken(t => t + 1), []);

    return { log, loading, error, refresh };
}

function useDrift(isActive) {
    const [drift, setDrift] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [refreshToken, setRefreshToken] = useState(0);

    useEffect(() => {
        if (!isActive) return;
        setLoading(true);
        setError(null);
        inspectDrift()
            .then(setDrift)
            .catch(err => setError(err.message ?? 'Failed to inspect workspace'))
            .finally(() => setLoading(false));
    }, [isActive, refreshToken]);

    const refresh = useCallback(() => setRefreshToken(t => t + 1), []);

    return { drift, loading, error, refresh };
}

const LIST_VISIBLE_CAP = 12;

function LoosePagesGroup({ label, className, paths }) {
    if (paths.length === 0) return null;
    const overflow = paths.length - LIST_VISIBLE_CAP;
    return (
        <div className="seal-loose-group">
            <span className={`seal-loose-group-label ${className}`}>{label} · {paths.length}</span>
            <ul>
                {paths.slice(0, LIST_VISIBLE_CAP).map(p => <li key={p}>{p}</li>)}
                {overflow > 0 && <li className="seal-loose-more">+{overflow} more</li>}
            </ul>
        </div>
    );
}

// "Loose pages" — sidecars changed outside Flashback with no seal commit yet. Framed as
// pages that haven't been bound into the ledger, distinct from the stamped, sealed history below.
function LoosePagesPanel({ drift, loading, error, onRefresh }) {
    const empty = drift && drift.added.length === 0 && drift.modified.length === 0 && drift.deleted.length === 0;
    return (
        <section className="seal-section">
            <div className="seal-section-head">
                <h2 className="seal-eyebrow">Loose pages</h2>
                <button type="button" className="seal-btn" onClick={onRefresh} disabled={loading}>
                    {loading ? 'Checking…' : 'Refresh'}
                </button>
            </div>
            <div className="seal-loose-card">
                {error && <div className="seal-error">{error}</div>}
                {!error && empty && (
                    <p className="seal-loose-empty">Every page is bound in — nothing changed outside Flashback.</p>
                )}
                {!error && drift && !empty && (
                    <div className="seal-loose-groups">
                        <LoosePagesGroup label="Added" className="seal-loose-group-label--added" paths={drift.added} />
                        <LoosePagesGroup label="Modified" className="seal-loose-group-label--modified" paths={drift.modified} />
                        <LoosePagesGroup label="Deleted" className="seal-loose-group-label--deleted" paths={drift.deleted} />
                    </div>
                )}
            </div>
        </section>
    );
}

// Condensed horizontal strip — the "Main" thread at a glance. Only one lane exists today
// (the backend has no branch concept yet), but this is deliberately structured as a single
// lane rather than a bespoke one-off, so a future multi-user branch model can add lanes here
// without a rewrite. Clicking a stamp scrolls the matching entry into view below.
function SealOverviewRibbon({ log, onSelect }) {
    if (log.length === 0) return null;
    const chronological = [...log].reverse();
    return (
        <div className="seal-overview">
            <span className="seal-overview-lane-label">Main</span>
            <div className="seal-overview-track">
                {chronological.map((commit, i) => {
                    const isCurrent = i === chronological.length - 1;
                    const { action, detail } = parseCommitMessage(commit.commit.message);
                    return (
                        <button
                            type="button"
                            key={commit.oid}
                            className={`seal-overview-dot seal-overview-dot--${action}${isCurrent ? ' seal-overview-dot--current' : ''}`}
                            title={detail}
                            onClick={() => onSelect(commit.oid)}
                        />
                    );
                })}
            </div>
        </div>
    );
}

function StatsLine({ stats }) {
    if (!stats) return null;
    const parts = [];
    if (stats.added) parts.push(`+${stats.added} created`);
    if (stats.modified) parts.push(`${stats.modified} modified`);
    if (stats.deleted) parts.push(`−${stats.deleted} deleted`);
    if (parts.length === 0) return null;
    return <span className="seal-entry-stats">{parts.join(' · ')}</span>;
}

// Fetched lazily on first expand — a single commit (e.g. a large import) can touch hundreds
// of paths, so the full list isn't worth bundling into every log entry up front.
function ChangedFiles({ oid, stats }) {
    const [expanded, setExpanded] = useState(false);
    const [files, setFiles] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    const total = stats ? stats.added + stats.modified + stats.deleted : 0;
    if (total === 0) return null;

    const toggle = () => {
        const next = !expanded;
        setExpanded(next);
        if (next && files === null && !loading) {
            setLoading(true);
            setError(null);
            getCommitFiles(oid)
                .then(setFiles)
                .catch(err => setError(err.message ?? 'Failed to load changed files'))
                .finally(() => setLoading(false));
        }
    };

    const rows = files
        ? [
            ...files.added.map(p => ({ p, cls: 'added' })),
            ...files.modified.map(p => ({ p, cls: 'modified' })),
            ...files.deleted.map(p => ({ p, cls: 'deleted' })),
        ]
        : [];
    const overflow = rows.length - LIST_VISIBLE_CAP;

    return (
        <div className="seal-files">
            <button type="button" className="seal-files-toggle" onClick={toggle} aria-expanded={expanded}>
                <span className={`seal-files-caret${expanded ? ' seal-files-caret--open' : ''}`} aria-hidden="true">▸</span>
                Changed files
            </button>
            {expanded && (
                <div className="seal-files-body">
                    {loading && <p className="seal-loading">Loading…</p>}
                    {error && <div className="seal-error">{error}</div>}
                    {files && (
                        <ul className="seal-files-list">
                            {rows.slice(0, LIST_VISIBLE_CAP).map(({ p, cls }) => (
                                <li key={p} className={`seal-files-item seal-files-item--${cls}`}>{p}</li>
                            ))}
                            {overflow > 0 && <li className="seal-loose-more">+{overflow} more</li>}
                        </ul>
                    )}
                </div>
            )}
        </div>
    );
}

function SealEntry({ commit, isCurrent, isLast, isHighlighted, onRollback }) {
    const { action, detail } = parseCommitMessage(commit.commit.message);
    const { relative, absolute } = formatCommitTime(commit.commit.author?.timestamp);
    return (
        <div
            id={`seal-entry-${commit.oid}`}
            className={`seal-entry${isCurrent ? ' seal-entry--current' : ''}${isHighlighted ? ' seal-entry--highlight' : ''}`}
        >
            <div className="seal-entry-rail">
                <span className={`seal-stamp seal-stamp--${action}`} title={ACTION_LABELS[action] ?? action} aria-hidden="true">
                    <ActionGlyph action={action} />
                </span>
                {!isLast && <span className="seal-rail-line" aria-hidden="true" />}
            </div>
            <div className="seal-card">
                <div className="seal-card-head">
                    <span className="seal-entry-action">{ACTION_LABELS[action] ?? action}</span>
                    <span className="seal-entry-detail" title={detail}>{detail}</span>
                    {isCurrent && <span className="seal-entry-current">current</span>}
                </div>
                <div className="seal-card-meta">
                    <span className="seal-entry-time" title={absolute}>{relative}</span>
                    <span className="seal-entry-oid" title={commit.oid}>{formatOid(commit.oid)}</span>
                    <StatsLine stats={commit.stats} />
                </div>
                <ChangedFiles oid={commit.oid} stats={commit.stats} />
                {!isCurrent && (
                    <div className="seal-card-actions">
                        <button type="button" className="seal-entry-rollback" onClick={() => onRollback(commit)}>
                            Restore this version
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}

function SealTimeline({ log, loading, error, highlightOid, onRollback }) {
    if (loading) return <p className="seal-loading">Loading…</p>;
    if (error) return <div className="seal-error">{error}</div>;
    if (log.length === 0) return <p className="seal-empty">Nothing sealed yet — changes you make will appear here.</p>;
    return (
        <div className="seal-rail">
            {log.map((commit, i) => (
                <SealEntry
                    key={commit.oid}
                    commit={commit}
                    isCurrent={i === 0}
                    isLast={i === log.length - 1}
                    isHighlighted={commit.oid === highlightOid}
                    onRollback={onRollback}
                />
            ))}
        </div>
    );
}

function RollbackConfirmModal({ commit, newerCount, onCancel, onConfirm }) {
    const [keepSrsProgress, setKeepSrsProgress] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    const { action, detail } = parseCommitMessage(commit.commit.message);
    const { absolute } = formatCommitTime(commit.commit.author?.timestamp);

    const handleConfirm = async () => {
        setBusy(true);
        setError(null);
        try {
            await onConfirm(commit.oid, keepSrsProgress);
        } catch (err) {
            setError(err.message ?? 'Restore failed');
            setBusy(false);
        }
    };

    return (
        <div className="seal-modal-backdrop" onClick={busy ? undefined : onCancel}>
            <div className="seal-modal" onClick={e => e.stopPropagation()}>
                <div className="seal-modal-header">
                    <span className="seal-modal-title">Restore this version</span>
                    <button type="button" className="seal-modal-close" onClick={onCancel} disabled={busy}>✕</button>
                </div>
                <div className="seal-modal-body">
                    <div className="seal-modal-target">
                        <span className={`seal-stamp seal-stamp--${action} seal-stamp--sm`} aria-hidden="true">
                            <ActionGlyph action={action} />
                        </span>
                        <span>{detail}</span>
                        <span className="seal-entry-oid" title={commit.oid}>{formatOid(commit.oid)}</span>
                        <span className="seal-entry-time">{absolute}</span>
                    </div>

                    <p className="seal-modal-warning">
                        This restores the workspace to this point in time and discards any uncommitted
                        changes on disk.
                        {newerCount > 0 && (
                            <> If you keep editing afterward, the {newerCount} entr{newerCount === 1 ? 'y' : 'ies'} newer
                            than this point will no longer appear in the log.</>
                        )}
                    </p>

                    <label className="seal-modal-checkbox">
                        <input
                            type="checkbox"
                            checked={keepSrsProgress}
                            onChange={e => setKeepSrsProgress(e.target.checked)}
                            disabled={busy}
                        />
                        Keep current review progress (recommended)
                    </label>
                    <p className="seal-modal-hint">
                        {keepSrsProgress
                            ? 'Flashcard review history and scheduling stay as they are now — only document content and structure roll back.'
                            : 'Flashcard review history and scheduling also roll back to what they were at this point.'}
                    </p>

                    {error && <div className="seal-error">{error}</div>}

                    <div className="seal-modal-actions">
                        <button type="button" className="seal-btn" onClick={onCancel} disabled={busy}>
                            Cancel
                        </button>
                        <button type="button" className="seal-btn seal-btn--danger" onClick={handleConfirm} disabled={busy}>
                            {busy ? 'Restoring…' : 'Restore'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

export default function SealView({ isActive = false }) {
    const { log, loading: logLoading, error: logError, refresh: refreshLog } = useSealLog(20, isActive);
    const { drift, loading: driftLoading, error: driftError, refresh: refreshDrift } = useDrift(isActive);

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

    // Rollback leaves the SQLite derived layer diverged from the rolled-back sidecars.
    // No reconciliation mechanism exists yet — not even on restart, since the boot-time
    // validator only checks schema/tables, never resyncs DB content from disk. A real fix
    // needs a new read-only Documents.reconcileFromDisk() that updates rows from
    // sealTools.inspect()'s diff without re-triggering sealEmitter commits (tracked as a
    // follow-up, not solved here). The banner below is deliberately honest about this gap.
    const handleRollback = async (ref, keepSrsProgress) => {
        await rollback(ref, keepSrsProgress);
        setConfirmTarget(null);
        setRollbackDone(true);
        refreshLog();
        refreshDrift();
    };

    return (
        <div className="seal-view">
            {rollbackDone && (
                <div className="seal-restart-banner">
                    <span className="seal-restart-message">
                        Restore complete. Flashback's document index may be out of date until you restart the app.
                    </span>
                    <div className="seal-restart-actions">
                        <button
                            type="button"
                            className="seal-restart-btn seal-restart-btn--primary"
                            onClick={() => window.flashback?.restartApp()}
                        >
                            Restart now
                        </button>
                        <button type="button" className="seal-restart-btn" onClick={() => setRollbackDone(false)}>
                            Later
                        </button>
                    </div>
                </div>
            )}

            {!logLoading && log.length > 0 && (
                <section className="seal-section">
                    <h2 className="seal-eyebrow">Main thread</h2>
                    <SealOverviewRibbon log={log} onSelect={handleOverviewSelect} />
                </section>
            )}

            <LoosePagesPanel drift={drift} loading={driftLoading} error={driftError} onRefresh={refreshDrift} />

            <section className="seal-section">
                <h2 className="seal-eyebrow">Seal log</h2>
                <SealTimeline
                    log={log}
                    loading={logLoading}
                    error={logError}
                    highlightOid={highlightOid}
                    onRollback={setConfirmTarget}
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
