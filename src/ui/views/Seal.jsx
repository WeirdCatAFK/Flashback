import { useState, useEffect, useCallback, useRef } from 'react';
import { getLog, inspectDrift, rollback, getCommitFiles } from '../api/seal';
import { checkIndex, syncIndex, rebuildIndex } from '../api/doctor';
import Modal from '../components/shared/Modal';
import { relativeFromMs } from '../utils/relativeTime';
import './Seal.css';

const ACTION_LABELS = {
    create: 'Created',
    edit: 'Edited',
    move: 'Moved',
    delete: 'Deleted',
    reconcile: 'Reconciled',
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
    return { relative: relativeFromMs(date.getTime()), absolute: date.toLocaleString() };
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
        case 'reconcile': return <svg {...p}><path d="M4 12a8 8 0 0 1 14-5" /><polyline points="18 3 18 7 14 7" /><path d="M20 12a8 8 0 0 1-14 5" /><polyline points="6 21 6 17 10 17" /></svg>;
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
                    <p className="seal-loose-empty">Mothing changed outside Flashback.</p>
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
        <Modal
            title="Restore this version"
            size="md"
            onClose={onCancel}
            dismissible={!busy}
            footer={
                <>
                    <button type="button" className="seal-btn" onClick={onCancel} disabled={busy}>
                        Cancel
                    </button>
                    <button type="button" className="seal-btn seal-btn--danger" onClick={handleConfirm} disabled={busy}>
                        {busy ? 'Restoring…' : 'Restore'}
                    </button>
                </>
            }
        >
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
        </Modal>
    );
}

// --- Vault Doctor ---
// The Seal view already surfaces "loose pages" (out-of-band sidecar drift); the Doctor
// goes further and reconciles the whole derived SQLite index against the canonical files.

// Flattens a checkIndex() report into a flat list of labelled path groups so the panel
// can render them uniformly. Tone drives the accent color (reusing the loose-page palette).
function collectDoctorIssues(report) {
    const groups = [];
    const add = (label, tone, paths) => { if (paths && paths.length) groups.push({ label, tone, paths }); };
    const d = report.documents;
    const f = report.folders;
    const m = report.media;
    const dk = report.decks;

    add('Documents on disk, not indexed', 'added', d.missingInDb);
    add('Index rows with no file', 'deleted', d.orphanedInDb);
    add('Modified since last index', 'modified', d.modified.map(x => `${x.relPath}  ·  ${x.reasons.join(', ')}`));
    add('Hash conflicts — skipped', 'warn', d.hashConflicts.map(x => `${x.hash.slice(0, 8)}…  ·  ${x.paths.join('  ,  ')}`));
    add('Corrupt document sidecars', 'warn', d.corruptSidecars);
    add('Stray files', 'warn', d.untracked.map(x => `${x.relPath}  (${x.kind})`));

    add('Folders on disk, not indexed', 'added', f.missingInDb);
    add('Folder rows with no directory', 'deleted', f.orphanedInDb);
    add('Ghost directories — no sidecar', 'warn', f.ghostDirs);
    add('Corrupt folder sidecars', 'warn', f.corruptSidecars);

    add('Media files not registered', 'added', m.unregistered);
    add('Media rows missing on disk', 'deleted', m.missingOnDisk);

    add('Deck files not in index', 'added', dk.fileWithoutDb);
    add('Deck rows with no file', 'deleted', dk.dbWithoutFile);
    add('Corrupt deck files', 'warn', dk.corruptFiles);
    add('Deck entry mismatches', 'modified', dk.entryMismatches.map(x => `${x.deckHash.slice(0, 8)}…  ·  +${x.missingInDb.length} / −${x.missingInFile.length}`));
    add('Dangling deck entries', 'warn', dk.danglingEntries.map(x => `${x.deckHash.slice(0, 8)}… → ${x.cardHash.slice(0, 8)}…`));

    return groups;
}

const TONE_CLASS = {
    added: 'seal-loose-group-label--added',
    modified: 'seal-loose-group-label--modified',
    deleted: 'seal-loose-group-label--deleted',
    warn: 'seal-doctor-group-label--warn',
};

function DoctorIssueGroup({ label, tone, paths }) {
    const overflow = paths.length - LIST_VISIBLE_CAP;
    return (
        <div className="seal-loose-group">
            <span className={`seal-loose-group-label ${TONE_CLASS[tone] ?? ''}`}>{label} · {paths.length}</span>
            <ul>
                {paths.slice(0, LIST_VISIBLE_CAP).map((p, i) => <li key={`${p}-${i}`}>{p}</li>)}
                {overflow > 0 && <li className="seal-loose-more">+{overflow} more</li>}
            </ul>
        </div>
    );
}

// A run-once, on-demand walk of the whole vault — heavier than inspectDrift (integrity
// check + full workspace walk + DB joins), so it is button-triggered rather than auto-run
// on every tab activation.
function useDoctorCheck() {
    const [report, setReport] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    const run = useCallback(() => {
        setLoading(true);
        setError(null);
        return checkIndex()
            .then(r => { setReport(r); return r; })
            .catch(err => { setError(err.message ?? 'Check failed'); throw err; })
            .finally(() => setLoading(false));
    }, []);

    return { report, loading, error, run, setReport };
}

function DoctorSummary({ report }) {
    const c = report.counts;
    const items = [
        ['Documents', c.documents],
        ['Folders', c.folders],
        ['Flashcards', c.flashcards],
        ['Standalone', c.standaloneCards],
        ['Pending links', c.pendingLinks],
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

// Reconcile the index to disk. The seal-drift checkbox defaults on: unsealed out-of-band
// deletions would resurrect on a later rollback, so binding them into history is the safe
// default (the loose-pages panel above is where the user sees that drift).
function SyncConfirmModal({ report, onCancel, onConfirm }) {
    const [sealDrift, setSealDrift] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    const handleConfirm = async () => {
        setBusy(true);
        setError(null);
        try {
            await onConfirm(sealDrift);
        } catch (err) {
            setError(err.message ?? 'Sync failed');
            setBusy(false);
        }
    };

    const hasConflicts = report.documents.hashConflicts.length > 0;

    return (
        <Modal
            title="Sync index to files"
            size="md"
            onClose={onCancel}
            dismissible={!busy}
            footer={
                <>
                    <button type="button" className="seal-btn" onClick={onCancel} disabled={busy}>Cancel</button>
                    <button type="button" className="seal-btn seal-btn--primary" onClick={handleConfirm} disabled={busy}>
                        {busy ? 'Syncing…' : 'Sync index'}
                    </button>
                </>
            }
        >
            <p className="seal-modal-warning">
                Your files on disk are the source of truth. This indexes anything new, refreshes
                documents that changed outside Flashback, and drops index entries for things that
                were deleted. Review progress is never lowered.
                {hasConflicts && (
                    <> Documents that share a duplicate identity are left untouched and reported.</>
                )}
            </p>

            <label className="seal-modal-checkbox">
                <input
                    type="checkbox"
                    checked={sealDrift}
                    onChange={e => setSealDrift(e.target.checked)}
                    disabled={busy}
                />
                Seal out-of-band changes into history (recommended)
            </label>
            <p className="seal-modal-hint">
                {sealDrift
                    ? 'Changes made outside Flashback are bound into the seal log as one entry, so a later rollback treats them as real history.'
                    : 'Changes made outside Flashback stay unsealed — a later rollback may undo or resurrect them.'}
            </p>

            {error && <div className="seal-error">{error}</div>}
        </Modal>
    );
}

// Type-to-confirm because rebuild wipes and regenerates the whole derived layer: card
// levels and ease survive (they live in the sidecars) but per-review ReviewLogs history
// is lost.
function RebuildConfirmModal({ onCancel, onConfirm }) {
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
            setError(err.message ?? 'Rebuild failed');
            setBusy(false);
        }
    };

    return (
        <Modal
            title="Rebuild index from files"
            size="md"
            onClose={onCancel}
            dismissible={!busy}
            footer={
                <>
                    <button type="button" className="seal-btn" onClick={onCancel} disabled={busy}>Cancel</button>
                    <button type="button" className="seal-btn seal-btn--danger" onClick={handleConfirm} disabled={busy || !armed}>
                        {busy ? 'Rebuilding…' : 'Rebuild index'}
                    </button>
                </>
            }
        >
            <p className="seal-modal-warning">
                This discards the entire document index and regenerates it from your <code>.flashback</code>{' '}
                files. Use it only when the index is corrupt or badly out of sync — <strong>Sync index</strong>{' '}
                is the safe everyday choice.
            </p>
            <p className="seal-modal-hint">
                Card levels and ease survive (they are stored in the files), but per-review history
                (each card&apos;s review log) is lost and scheduling is re-seeded from the saved levels.
            </p>

            <label className="seal-doctor-type-label">
                Type <span className="seal-doctor-type-token">REBUILD</span> to confirm
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

function DoctorResult({ result }) {
    if (!result) return null;
    if (result.kind === 'sync') {
        const a = result.actions;
        const parts = [];
        if (a.foldersIndexed) parts.push(`${a.foldersIndexed} folders indexed`);
        if (a.documentsIndexed) parts.push(`${a.documentsIndexed} documents indexed`);
        if (a.documentsReindexed) parts.push(`${a.documentsReindexed} reindexed`);
        if (a.foldersRemoved) parts.push(`${a.foldersRemoved} folders dropped`);
        if (a.documentsRemoved) parts.push(`${a.documentsRemoved} documents dropped`);
        if (a.mediaRegistered) parts.push(`${a.mediaRegistered} media registered`);
        if (a.mediaRowsRemoved) parts.push(`${a.mediaRowsRemoved} media rows dropped`);
        const summary = parts.length ? parts.join(' · ') : 'Index already matched the files — nothing to change.';
        return (
            <div className="seal-doctor-result">
                <span className="seal-doctor-result-head">Sync complete</span>
                <span className="seal-doctor-result-body">{summary}</span>
                {result.sealedOid && <span className="seal-doctor-result-meta">Sealed as {formatOid(result.sealedOid)}</span>}
                {result.warnings?.length > 0 && (
                    <span className="seal-doctor-result-warn">{result.warnings.length} warning{result.warnings.length === 1 ? '' : 's'} — {result.warnings[0]}</span>
                )}
            </div>
        );
    }
    const s = result.summary;
    return (
        <div className="seal-doctor-result">
            <span className="seal-doctor-result-head">Rebuild complete</span>
            <span className="seal-doctor-result-body">
                {s.documentsIndexed} documents · {s.foldersIndexed} folders · {s.flashcards} cards · {s.decks} decks rebuilt
            </span>
            <span className="seal-doctor-result-meta">
                {s.standaloneCardsRestored} standalone restored · {s.easeFactorsRestored} ease factors preserved · {s.mediaRegistered} media
            </span>
            {result.warnings?.length > 0 && (
                <span className="seal-doctor-result-warn">{result.warnings.length} warning{result.warnings.length === 1 ? '' : 's'} — {result.warnings[0]}</span>
            )}
        </div>
    );
}

function VaultDoctorPanel({ report, loading, error, onCheck, onSynced, onRebuilt }) {
    const [modal, setModal] = useState(null); // 'sync' | 'rebuild' | null
    const [result, setResult] = useState(null);

    const issues = report ? collectDoctorIssues(report) : [];
    const integrityOk = report?.db.integrity === 'ok';
    const clean = report && integrityOk && issues.length === 0;

    const handleSync = async (sealDrift) => {
        const res = await syncIndex(sealDrift);
        setModal(null);
        setResult({ kind: 'sync', ...res });
        onSynced?.();
        await onCheck();
    };

    const handleRebuild = async () => {
        const res = await rebuildIndex();
        setModal(null);
        setResult({ kind: 'rebuild', ...res });
        onRebuilt?.();
        await onCheck();
    };

    return (
        <section className="seal-section">
            <div className="seal-section-head">
                <h2 className="seal-eyebrow">Vault doctor</h2>
                <button type="button" className="seal-btn" onClick={() => { setResult(null); onCheck(); }} disabled={loading}>
                    {loading ? 'Checking…' : report ? 'Re-check index' : 'Check index'}
                </button>
            </div>

            <div className="seal-loose-card">
                {error && <div className="seal-error">{error}</div>}

                {!report && !error && (
                    <p className="seal-loose-empty">Check the index to compare every file on disk against Flashback&apos;s database.</p>
                )}

                {report && (
                    <>
                        <div className="seal-doctor-status">
                            <span className={`seal-doctor-badge ${integrityOk ? 'seal-doctor-badge--ok' : 'seal-doctor-badge--bad'}`}>
                                {integrityOk ? 'Database integrity OK' : `Integrity: ${report.db.integrity}`}
                            </span>
                            <DoctorSummary report={report} />
                        </div>

                        {clean && (
                            <p className="seal-loose-empty">Clean bill of health — the index matches your files exactly.</p>
                        )}

                        {!clean && (
                            <div className="seal-loose-groups">
                                {issues.map(g => <DoctorIssueGroup key={g.label} {...g} />)}
                            </div>
                        )}

                        <DoctorResult result={result} />

                        <div className="seal-doctor-actions">
                            <button
                                type="button"
                                className="seal-btn seal-btn--primary"
                                onClick={() => setModal('sync')}
                                disabled={!integrityOk}
                                title={integrityOk ? undefined : 'Integrity check failed — rebuild the index instead'}
                            >
                                Sync index now
                            </button>
                            <button type="button" className="seal-btn seal-btn--danger-quiet" onClick={() => setModal('rebuild')}>
                                Rebuild index from files
                            </button>
                        </div>
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

export default function SealView({ isActive = false }) {
    const { log, loading: logLoading, error: logError, refresh: refreshLog } = useSealLog(20, isActive);
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

    // Rollback leaves the SQLite derived layer diverged from the rolled-back sidecars.
    // The Vault Doctor's syncIndex() reconciles that divergence (a direct workspace-walk
    // vs. DB comparison — sealTools.inspect() is blind here because HEAD == workdir after
    // a rollback). The banner below offers it inline; a restart also works because the
    // boot-time validator can be pointed at the same path, but Sync is the immediate fix.
    const handleRollback = async (ref, keepSrsProgress) => {
        await rollback(ref, keepSrsProgress);
        setConfirmTarget(null);
        setRollbackDone(true);
        refreshLog();
        refreshDrift();
    };

    const [bannerSyncing, setBannerSyncing] = useState(false);
    const handleBannerSync = async () => {
        setBannerSyncing(true);
        try {
            // Post-rollback there is no git drift (HEAD == workdir), so nothing to seal.
            await syncIndex(false);
            setRollbackDone(false);
            refreshDrift();
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
                        Restore complete. Flashback&apos;s document index is now out of date — sync it to the restored files.
                    </span>
                    <div className="seal-restart-actions">
                        <button
                            type="button"
                            className="seal-restart-btn seal-restart-btn--primary"
                            onClick={handleBannerSync}
                            disabled={bannerSyncing}
                        >
                            {bannerSyncing ? 'Syncing…' : 'Sync index now'}
                        </button>
                        <button type="button" className="seal-restart-btn" onClick={() => setRollbackDone(false)} disabled={bannerSyncing}>
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

            <VaultDoctorPanel
                report={doctorReport}
                loading={doctorLoading}
                error={doctorError}
                onCheck={runDoctorCheck}
                onSynced={() => { refreshLog(); refreshDrift(); }}
                onRebuilt={() => { refreshLog(); refreshDrift(); }}
            />

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
