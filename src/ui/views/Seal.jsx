import { useState, useEffect, useCallback, useRef } from 'react';
import { getLog, inspectDrift, rollback, getCommitFiles } from '../api/seal';
import { checkIndex, syncIndex, rebuildIndex } from '../api/doctor';
import { useCan } from '../sessionContext.js';
import Modal from '../components/shared/Modal';
import { invalidateData } from '../utils/dataBus';
import { Rich, useT } from '../translations';
import './Seal.css';

/**
 * Commit actions are stable identifiers in the seal log but labels on screen.
 * A switch of literals rather than the old lookup table: the extractor only
 * sees literal t() arguments, so a map keyed by action would translate nothing.
 */
function useActionLabel() {
    const { t } = useT();
    return useCallback((action) => {
        switch (action) {
            case 'create':    return t('Created');
            case 'edit':      return t('Edited');
            case 'metadata':  return t('Metadata');
            case 'move':      return t('Moved');
            case 'delete':    return t('Deleted');
            case 'reconcile': return t('Reconciled');
            default:          return action;
        }
    }, [t]);
}

const SIDECAR_SUFFIX = '.flashback';

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

const baseName = p => (p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p);
const dirName = p => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const isSidecar = p => p.endsWith(SIDECAR_SUFFIX);
const documentPath = p => (isSidecar(p) ? p.slice(0, -SIDECAR_SUFFIX.length) : p);

// Seal labels commits with the raw path it staged: `notes/Chapter 1.md.flashback` for a
// document, `notes/.flashback` for a folder, `_decks/<uuid>.json` for a deck. None of that
// is meaningful to someone who has never opened a sidecar, so every label is translated
// back into the thing the user actually touched. Returns null when the label isn't a path
// (batch commits say "3 sidecars" / "12 files").
//
// `tr` is the { t, tp } pair from useT(), passed in rather than looked up: keeping these
// helpers plain functions means the caller decides when they run, and they stay callable
// from anywhere in the render tree without becoming hooks themselves.
function describeTarget(raw, tr) {
    if (!raw) return null;
    const p = raw.replace(/\\/g, '/');

    if (/^\d+ sidecars$/.test(p)) {
        const n = parseInt(p, 10);
        return { name: tr.tp('{n} document', '{n} documents', n), dir: '' };
    }
    if (/^\d+ files$/.test(p)) {
        const n = parseInt(p, 10);
        return { name: tr.tp('{n} file', '{n} files', n), dir: '' };
    }
    if (p.startsWith('_decks/')) return { name: tr.t('a deck'), dir: '' };

    if (p === SIDECAR_SUFFIX) return { name: tr.t('the workspace'), dir: '' };
    if (p.endsWith(`/${SIDECAR_SUFFIX}`)) {
        const folder = p.slice(0, -(SIDECAR_SUFFIX.length + 1));
        return { name: `${baseName(folder)}/`, dir: dirName(folder) };
    }

    const doc = documentPath(p);
    return { name: baseName(doc), dir: dirName(doc) };
}

/**
 * Turns a commit into the row the timeline actually renders.
 *
 * The important case is `variant: 'metadata'` — an edit whose diff touched sidecars only.
 * That's what a highlight, a new flashcard, or a tag change looks like from git's side, and
 * it's the bulk of a normal session's history. Without this it reads as "Edited
 * chapter.md.flashback", which tells the user neither what changed nor why a file they
 * never opened is in their history. stats.content is the server-computed count of changed
 * non-sidecar paths, so this is measured, not inferred from the message.
 */
function describeCommit(commit, tr) {
    const { action, detail } = parseCommitMessage(commit.commit.message);
    const stats = commit.stats;
    const touched = stats ? stats.added + stats.modified + stats.deleted : 0;
    const metadataOnly = action === 'edit' && stats && touched > 0 && stats.content === 0;
    const target = action === 'move' ? null : describeTarget(detail, tr);

    if (metadataOnly) {
        return {
            variant: 'metadata',
            detail: tr.t('Metadata updated for {target}', { target: target?.name ?? detail }),
            dir: target?.dir ?? '',
            raw: detail,
        };
    }
    return {
        variant: action,
        detail: target?.name ?? detail,
        dir: target?.dir ?? '',
        raw: detail,
    };
}

function formatOid(oid) {
    return oid ? oid.slice(0, 7) : '';
}

// isomorphic-git commit timestamps are unix seconds, not ms.
function formatCommitTime(unixSeconds, { formatRelative, formatDateTime }) {
    if (!unixSeconds) return { relative: '', absolute: '' };
    const ms = unixSeconds * 1000;
    return { relative: formatRelative(ms), absolute: formatDateTime(ms) };
}

// A small embossed glyph stamped into each wax seal — gives the action a shape, not just a
// color, so the timeline reads at a glance without relying on color alone.
function ActionGlyph({ action }) {
    const p = { width: 11, height: 11, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 3, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };
    switch (action) {
        case 'create': return <svg {...p}><line x1="12" y1="4" x2="12" y2="20" /><line x1="4" y1="12" x2="20" y2="12" /></svg>;
        case 'edit':   return <svg {...p}><path d="M4 20l4-1 11-11-3-3L5 16l-1 4z" /></svg>;
        // A tag: metadata hangs off a document rather than being its content.
        case 'metadata': return <svg {...p}><path d="M4 4h7l9 9-7 7-9-9V4z" /><circle cx="8.5" cy="8.5" r="1" /></svg>;
        case 'move':   return <svg {...p}><line x1="4" y1="12" x2="19" y2="12" /><polyline points="13 6 19 12 13 18" /></svg>;
        case 'delete': return <svg {...p}><line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" /></svg>;
        case 'reconcile': return <svg {...p}><path d="M4 12a8 8 0 0 1 14-5" /><polyline points="18 3 18 7 14 7" /><path d="M20 12a8 8 0 0 1-14 5" /><polyline points="6 21 6 17 10 17" /></svg>;
        default:       return <svg {...p}><circle cx="12" cy="12" r="3.5" /></svg>;
    }
}

const PAGE_SIZE = 25;
// Matches the server's own cap (routes/seal.js MAX_LOG_LIMIT) — every commit in a page
// costs a tree diff, so a restore-depth reload is clamped to the same ceiling.
const MAX_PAGE = 200;

// Views in this app stay mounted after their first visit (see App.jsx's view-slot
// keep-alive) — an effect with no isActive dependency would only ever fetch once,
// then go stale on every later tab switch. Refetch each time the tab becomes active,
// matching the convention already used by GraphView/Trainer's isActive-driven hooks.
//
// History is paged rather than capped: a session that produces a lot of metadata commits
// (highlighting a PDF, say) used to push everything else past a hard 20-entry limit with
// no way to reach it. Pages are cursor-based, so "load older" walks back arbitrarily far.
function useSealLog(isActive) {
    const { t } = useT();
    const [log, setLog] = useState([]);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [hasMore, setHasMore] = useState(false);
    const [error, setError] = useState(null);
    const [refreshToken, setRefreshToken] = useState(0);

    // A plain reload on tab re-activation would collapse the timeline back to one page,
    // silently throwing away however far the user had paged back. Reload the depth they
    // had instead.
    const depthRef = useRef(PAGE_SIZE);
    const logRef = useRef([]);
    useEffect(() => { logRef.current = log; }, [log]);

    useEffect(() => {
        if (!isActive) return;
        let cancelled = false;
        const size = Math.min(depthRef.current, MAX_PAGE);
        setLoading(true);
        setError(null);
        getLog({ limit: size })
            .then(page => {
                if (cancelled) return;
                setLog(page);
                setHasMore(page.length >= size);
                depthRef.current = Math.max(page.length, PAGE_SIZE);
            })
            .catch(err => { if (!cancelled) setError(err.message ?? t('Failed to load history')); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [isActive, refreshToken, t]);

    const loadMore = useCallback(() => {
        const current = logRef.current;
        const last = current[current.length - 1];
        if (!last) return;
        setLoadingMore(true);
        setError(null);
        getLog({ limit: PAGE_SIZE, cursor: last.oid })
            .then(page => {
                setLog(prev => [...prev, ...page]);
                setHasMore(page.length === PAGE_SIZE);
                depthRef.current += page.length;
            })
            .catch(err => setError(err.message ?? t('Failed to load older entries')))
            .finally(() => setLoadingMore(false));
    }, [t]);

    const refresh = useCallback(() => setRefreshToken(t => t + 1), []);

    return { log, loading, loadingMore, hasMore, error, refresh, loadMore };
}

function useDrift(isActive) {
    const { t } = useT();
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
            .catch(err => setError(err.message ?? t('Failed to inspect workspace')))
            .finally(() => setLoading(false));
    }, [isActive, refreshToken, t]);

    const refresh = useCallback(() => setRefreshToken(t => t + 1), []);

    return { drift, loading, error, refresh };
}

const LIST_VISIBLE_CAP = 12;

function LoosePagesGroup({ label, className, paths }) {
    const { t } = useT();
    if (paths.length === 0) return null;
    const overflow = paths.length - LIST_VISIBLE_CAP;
    return (
        <div className="seal-loose-group">
            <span className={`seal-loose-group-label ${className}`}>{label} · {paths.length}</span>
            <ul>
                {paths.slice(0, LIST_VISIBLE_CAP).map(p => <li key={p}>{p}</li>)}
                {overflow > 0 && <li className="seal-loose-more">{t('+{n} more', { n: overflow })}</li>}
            </ul>
        </div>
    );
}

// "Loose pages" — sidecars changed outside Flashback with no seal commit yet. Framed as
// pages that haven't been bound into the ledger, distinct from the stamped, sealed history below.
function LoosePagesPanel({ drift, loading, error, onRefresh }) {
    const { t } = useT();
    const empty = drift && drift.added.length === 0 && drift.modified.length === 0 && drift.deleted.length === 0;
    return (
        <section className="seal-section">
            <div className="seal-section-head">
                <h2 className="seal-eyebrow">{t('Loose pages')}</h2>
                <button type="button" className="seal-btn" onClick={onRefresh} disabled={loading}>
                    {loading ? t('Checking…') : t('Refresh')}
                </button>
            </div>
            <div className="seal-loose-card">
                {error && <div className="seal-error">{error}</div>}
                {!error && empty && (
                    <p className="seal-loose-empty">{t('Nothing changed outside Flashback.')}</p>
                )}
                {!error && drift && !empty && (
                    <div className="seal-loose-groups">
                        <LoosePagesGroup label={t('Added')} className="seal-loose-group-label--added" paths={drift.added} />
                        <LoosePagesGroup label={t('Modified')} className="seal-loose-group-label--modified" paths={drift.modified} />
                        <LoosePagesGroup label={t('Deleted')} className="seal-loose-group-label--deleted" paths={drift.deleted} />
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
// Capped at the most recent slice: the timeline below pages back indefinitely, but a
// ribbon of 200 dots stops being something you can take in at a glance.
const RIBBON_MAX = 60;

function SealOverviewRibbon({ log, onSelect }) {
    const tr = useT();
    if (log.length === 0) return null;
    const chronological = [...log].slice(0, RIBBON_MAX).reverse();
    return (
        <div className="seal-overview">
            <span className="seal-overview-lane-label">{tr.t('Main')}</span>
            <div className="seal-overview-track">
                {chronological.map((commit, i) => {
                    const isCurrent = i === chronological.length - 1;
                    const { variant, detail } = describeCommit(commit, tr);
                    return (
                        <button
                            type="button"
                            key={commit.oid}
                            className={`seal-overview-dot seal-overview-dot--${variant}${isCurrent ? ' seal-overview-dot--current' : ''}`}
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
    const { t } = useT();
    if (!stats) return null;
    const parts = [];
    if (stats.added) parts.push(t('+{n} created', { n: stats.added }));
    if (stats.modified) parts.push(t('{n} modified', { n: stats.modified }));
    if (stats.deleted) parts.push(t('−{n} deleted', { n: stats.deleted }));
    if (parts.length === 0) return null;
    return <span className="seal-entry-stats">{parts.join(' · ')}</span>;
}

// Fetched lazily on first expand — a single commit (e.g. a large import) can touch hundreds
// of paths, so the full list isn't worth bundling into every log entry up front.
function ChangedFiles({ oid, stats }) {
    const { t } = useT();
    const [expanded, setExpanded] = useState(false);
    const [files, setFiles] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [showAll, setShowAll] = useState(false);

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
                .catch(err => setError(err.message ?? t('Failed to load changed files')))
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
    // Split rather than interleaved: seeing "chapter.md" and "chapter.md.flashback" as two
    // opaque siblings is exactly the confusion this view had. Grouped and labelled, the
    // second one explains itself.
    const contentRows = rows.filter(r => !isSidecar(r.p));
    const metaRows = rows.filter(r => isSidecar(r.p));

    return (
        <div className="seal-files">
            <button type="button" className="seal-files-toggle" onClick={toggle} aria-expanded={expanded}>
                <span className={`seal-files-caret${expanded ? ' seal-files-caret--open' : ''}`} aria-hidden="true">▸</span>
                {t('Changed files')}
            </button>
            {expanded && (
                <div className="seal-files-body">
                    {loading && <p className="seal-loading">{t('Loading…')}</p>}
                    {error && <div className="seal-error">{error}</div>}
                    {files && (
                        <>
                            <FileGroup label={t('Documents')} rows={contentRows} showAll={showAll} />
                            <FileGroup label={t('Metadata — highlights, cards, tags')} rows={metaRows} showAll={showAll} transform={documentPath} />
                            {!showAll && rows.length > LIST_VISIBLE_CAP && (
                                <button type="button" className="seal-files-showall" onClick={() => setShowAll(true)}>
                                    {t('Show all {n} files', { n: rows.length })}
                                </button>
                            )}
                        </>
                    )}
                </div>
            )}
        </div>
    );
}

function FileGroup({ label, rows, showAll, transform }) {
    if (rows.length === 0) return null;
    const visible = showAll ? rows : rows.slice(0, LIST_VISIBLE_CAP);
    return (
        <div className="seal-files-group">
            <span className="seal-files-group-label">{label} · {rows.length}</span>
            <ul className="seal-files-list">
                {visible.map(({ p, cls }) => (
                    <li key={p} className={`seal-files-item seal-files-item--${cls}`} title={p}>
                        {transform ? transform(p) : p}
                    </li>
                ))}
            </ul>
        </div>
    );
}

function SealEntry({ commit, isCurrent, isLast, isHighlighted, onRollback }) {
    // Restoring rewinds the workspace for EVERYONE on this server and is not undoable from
    // inside the app, so it is the Author's alone. Hidden rather than disabled: on a shared
    // vault it is not a thing a reader is nearly allowed to do.
    const canRollback = useCan('rollbackHistory');
    const tr = useT();
    const { t } = tr;
    const actionLabel = useActionLabel();
    const { variant, detail, dir, raw } = describeCommit(commit, tr);
    const { relative, absolute } = formatCommitTime(commit.commit.author?.timestamp, tr);
    return (
        <div
            id={`seal-entry-${commit.oid}`}
            className={`seal-entry${isCurrent ? ' seal-entry--current' : ''}${isHighlighted ? ' seal-entry--highlight' : ''}`}
        >
            <div className="seal-entry-rail">
                <span className={`seal-stamp seal-stamp--${variant}`} title={actionLabel(variant)} aria-hidden="true">
                    <ActionGlyph action={variant} />
                </span>
                {!isLast && <span className="seal-rail-line" aria-hidden="true" />}
            </div>
            <div className="seal-card">
                <div className="seal-card-head">
                    <span className="seal-entry-action">{actionLabel(variant)}</span>
                    {/* title keeps the exact sealed path reachable — the visible text is the
                        translated version, but power users still need the real thing. */}
                    <span className="seal-entry-detail" title={raw}>
                        {detail}
                        {dir && <span className="seal-entry-dir"> {t('in {dir}', { dir })}</span>}
                    </span>
                    {isCurrent && <span className="seal-entry-current">{t('current')}</span>}
                </div>
                <div className="seal-card-meta">
                    <span className="seal-entry-time" title={absolute}>{relative}</span>
                    <span className="seal-entry-oid" title={commit.oid}>{formatOid(commit.oid)}</span>
                    <StatsLine stats={commit.stats} />
                </div>
                <ChangedFiles oid={commit.oid} stats={commit.stats} />
                {!isCurrent && canRollback && (
                    <div className="seal-card-actions">
                        <button type="button" className="seal-entry-rollback" onClick={() => onRollback(commit)}>
                            {t('Restore this version')}
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}

function SealTimeline({ log, loading, loadingMore, hasMore, error, highlightOid, onRollback, onLoadMore }) {
    const { t, tp } = useT();
    if (loading) return <p className="seal-loading">{t('Loading…')}</p>;
    if (error && log.length === 0) return <div className="seal-error">{error}</div>;
    if (log.length === 0) return <p className="seal-empty">{t('Nothing sealed yet — changes you make will appear here.')}</p>;
    return (
        <>
            <div className="seal-rail">
                {log.map((commit, i) => (
                    <SealEntry
                        key={commit.oid}
                        commit={commit}
                        isCurrent={i === 0}
                        isLast={i === log.length - 1 && !hasMore}
                        isHighlighted={commit.oid === highlightOid}
                        onRollback={onRollback}
                    />
                ))}
            </div>
            {error && <div className="seal-error">{error}</div>}
            <div className="seal-log-foot">
                <span className="seal-log-count">{tp('{n} entry', '{n} entries', log.length)}</span>
                {hasMore ? (
                    <button type="button" className="seal-btn" onClick={onLoadMore} disabled={loadingMore}>
                        {loadingMore ? t('Loading…') : t('Load older entries')}
                    </button>
                ) : (
                    <span className="seal-log-end">{t('Beginning of history')}</span>
                )}
            </div>
        </>
    );
}

function RollbackConfirmModal({ commit, newerCount, onCancel, onConfirm }) {
    const tr = useT();
    const { t, tp } = tr;
    const [keepSrsProgress, setKeepSrsProgress] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    const { variant, detail } = describeCommit(commit, tr);
    const { absolute } = formatCommitTime(commit.commit.author?.timestamp, tr);

    const handleConfirm = async () => {
        setBusy(true);
        setError(null);
        try {
            await onConfirm(commit.oid, keepSrsProgress);
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
                    <button type="button" className="seal-btn" onClick={onCancel} disabled={busy}>
                        {t('Cancel')}
                    </button>
                    <button type="button" className="seal-btn seal-btn--danger" onClick={handleConfirm} disabled={busy}>
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

            <label className="seal-modal-checkbox">
                <input
                    type="checkbox"
                    checked={keepSrsProgress}
                    onChange={e => setKeepSrsProgress(e.target.checked)}
                    disabled={busy}
                />
                {t('Keep current review progress (recommended)')}
            </label>
            <p className="seal-modal-hint">
                {keepSrsProgress
                    ? t('Flashcard review history and scheduling stay as they are now — only document content and structure roll back.')
                    : t('Flashcard review history and scheduling also roll back to what they were at this point.')}
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
function collectDoctorIssues(report, t) {
    const groups = [];
    const add = (label, tone, paths) => { if (paths && paths.length) groups.push({ label, tone, paths }); };
    const d = report.documents;
    const f = report.folders;
    const m = report.media;
    const dk = report.decks;

    add(t('Documents on disk, not indexed'), 'added', d.missingInDb);
    add(t('Index rows with no file'), 'deleted', d.orphanedInDb);
    add(t('Modified since last index'), 'modified', d.modified.map(x => `${x.relPath}  ·  ${x.reasons.join(', ')}`));
    add(t('Hash conflicts — skipped'), 'warn', d.hashConflicts.map(x => `${x.hash.slice(0, 8)}…  ·  ${x.paths.join('  ,  ')}`));
    add(t('Corrupt document sidecars'), 'warn', d.corruptSidecars);
    add(t('Stray files'), 'warn', d.untracked.map(x => `${x.relPath}  (${x.kind})`));

    add(t('Folders on disk, not indexed'), 'added', f.missingInDb);
    add(t('Folder rows with no directory'), 'deleted', f.orphanedInDb);
    add(t('Ghost directories — no sidecar'), 'warn', f.ghostDirs);
    add(t('Corrupt folder sidecars'), 'warn', f.corruptSidecars);

    add(t('Media files not registered'), 'added', m.unregistered);
    add(t('Media rows missing on disk'), 'deleted', m.missingOnDisk);

    add(t('Deck files not in index'), 'added', dk.fileWithoutDb);
    add(t('Deck rows with no file'), 'deleted', dk.dbWithoutFile);
    add(t('Corrupt deck files'), 'warn', dk.corruptFiles);
    add(t('Deck entry mismatches'), 'modified', dk.entryMismatches.map(x => `${x.deckHash.slice(0, 8)}…  ·  +${x.missingInDb.length} / −${x.missingInFile.length}`));
    add(t('Dangling deck entries'), 'warn', dk.danglingEntries.map(x => `${x.deckHash.slice(0, 8)}… → ${x.cardHash.slice(0, 8)}…`));

    return groups;
}

const TONE_CLASS = {
    added: 'seal-loose-group-label--added',
    modified: 'seal-loose-group-label--modified',
    deleted: 'seal-loose-group-label--deleted',
    warn: 'seal-doctor-group-label--warn',
};

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

// A run-once, on-demand walk of the whole vault — heavier than inspectDrift (integrity
// check + full workspace walk + DB joins), so it is button-triggered rather than auto-run
// on every tab activation.
function useDoctorCheck() {
    const { t } = useT();
    const [report, setReport] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    const run = useCallback(() => {
        setLoading(true);
        setError(null);
        return checkIndex()
            .then(r => { setReport(r); return r; })
            .catch(err => { setError(err.message ?? t('Check failed')); throw err; })
            .finally(() => setLoading(false));
    }, [t]);

    return { report, loading, error, run, setReport };
}

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

// Reconcile the index to disk. The seal-drift checkbox defaults on: unsealed out-of-band
// deletions would resurrect on a later rollback, so binding them into history is the safe
// default (the loose-pages panel above is where the user sees that drift).
function SyncConfirmModal({ report, onCancel, onConfirm }) {
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
                    <button type="button" className="seal-btn" onClick={onCancel} disabled={busy}>{t('Cancel')}</button>
                    <button type="button" className="seal-btn seal-btn--primary" onClick={handleConfirm} disabled={busy}>
                        {busy ? t('Syncing…') : t('Sync index')}
                    </button>
                </>
            }
        >
            <p className="seal-modal-warning">
                {t('Your files on disk are the source of truth. This indexes anything new, refreshes documents that changed outside Flashback, and drops index entries for things that were deleted. Review progress is never lowered.')}
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

// Type-to-confirm because rebuild wipes and regenerates the whole derived layer: card
// levels and ease survive (they live in the sidecars) but per-review ReviewLogs history
// is lost.
function RebuildConfirmModal({ onCancel, onConfirm }) {
    const { t } = useT();
    const [typed, setTyped] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    // The token stays untranslated on purpose: it is a literal the user must retype
    // exactly, and it is shown verbatim right next to the field.
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
                    <button type="button" className="seal-btn" onClick={onCancel} disabled={busy}>{t('Cancel')}</button>
                    <button type="button" className="seal-btn seal-btn--danger" onClick={handleConfirm} disabled={busy || !armed}>
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
                {t('Card levels and ease survive (they are stored in the files), but per-review history (each card’s review log) is lost and scheduling is re-seeded from the saved levels.')}
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

function VaultDoctorPanel({ report, loading, error, onCheck, onSynced, onRebuilt }) {
    const { t } = useT();
    const canRepair = useCan('rebuildIndex');   // sync and rebuild are both the Author's
    const [modal, setModal] = useState(null); // 'sync' | 'rebuild' | null
    const [result, setResult] = useState(null);

    const issues = report ? collectDoctorIssues(report, t) : [];
    const integrityOk = report?.db.integrity === 'ok';
    const clean = report && integrityOk && issues.length === 0;

    const handleSync = async (sealDrift) => {
        const res = await syncIndex(sealDrift);
        setModal(null);
        setResult({ kind: 'sync', ...res });
        // The derived index was rewritten to match the files — every other view's
        // cached data is now potentially stale.
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
                <h2 className="seal-eyebrow">{t('Vault doctor')}</h2>
                <button type="button" className="seal-btn" onClick={() => { setResult(null); onCheck(); }} disabled={loading}>
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

                        {/* Diagnosis is an admin's job; repair is the Author's. A rebuild
                            discards everyone's review history, so an admin gets to SEE the
                            drift and gets to say so — but the button that acts on it is not
                            theirs. Explained rather than silently absent, because an admin
                            reading a drift report and finding no way to fix it deserves to
                            know who can. */}
                        {canRepair ? (
                            <div className="seal-doctor-actions">
                                <button
                                    type="button"
                                    className="seal-btn seal-btn--primary"
                                    onClick={() => setModal('sync')}
                                    disabled={!integrityOk}
                                    title={integrityOk ? undefined : t('Integrity check failed — rebuild the index instead')}
                                >
                                    {t('Sync index now')}
                                </button>
                                <button type="button" className="seal-btn seal-btn--danger-quiet" onClick={() => setModal('rebuild')}>
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
        // The canonical sidecars on disk were rewritten to the restored version, so
        // views that read files directly (file explorer, open documents) must reload.
        // The derived SQLite index still lags until the sync below runs, which fires
        // its own invalidateData() to refresh the DB-backed views (Flashcards/Decks).
        invalidateData();
    };

    const [bannerSyncing, setBannerSyncing] = useState(false);
    const handleBannerSync = async () => {
        setBannerSyncing(true);
        try {
            // Post-rollback there is no git drift (HEAD == workdir), so nothing to seal.
            await syncIndex(false);
            setRollbackDone(false);
            refreshDrift();
            // The derived index now matches the restored files — refresh every view.
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
                            className="seal-restart-btn seal-restart-btn--primary"
                            onClick={handleBannerSync}
                            disabled={bannerSyncing}
                        >
                            {bannerSyncing ? t('Syncing…') : t('Sync index now')}
                        </button>
                        <button type="button" className="seal-restart-btn" onClick={() => setRollbackDone(false)} disabled={bannerSyncing}>
                            {t('Later')}
                        </button>
                    </div>
                </div>
            )}

            {!logLoading && log.length > 0 && (
                <section className="seal-section">
                    <h2 className="seal-eyebrow">{t('Main thread')}</h2>
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
                <h2 className="seal-eyebrow">{t('Seal log')}</h2>
                {/* Said once, at the top, instead of on every row: metadata entries are the
                    bulk of a normal session's history, and without this the user has no way
                    to know why highlighting a page shows up as a change to a file they never
                    opened. */}
                <p className="seal-log-note">
                    {t('Highlights, flashcards and tags are stored beside each document in its own metadata file, so changing them is recorded here as a metadata update — the document’s own text is untouched.')}
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
