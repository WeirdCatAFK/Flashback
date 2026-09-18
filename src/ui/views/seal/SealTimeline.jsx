/**
 * SealTimeline — the commit history as a wax-sealed timeline: the overview
 * ribbon, one entry per commit with its glyph, its changed files (fetched on
 * expand, documents and their sidecars grouped rather than interleaved) and the
 * restore button, which is Author-only and hidden rather than disabled.
 */

import { useState } from 'react';
import { getCommitFiles } from '../../api/seal';
import { useCan } from '../../sessionContext.js';
import { useT } from '../../translations/index';
import { describeCommit, formatOid, formatCommitTime, isSidecar, documentPath, LIST_VISIBLE_CAP } from './describe.js';
import useActionLabel from './useActionLabel';

export function ActionGlyph({ action }) {
    const p = { width: 11, height: 11, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 3, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };
    switch (action) {
        case 'create': return <svg {...p}><line x1="12" y1="4" x2="12" y2="20" /><line x1="4" y1="12" x2="20" y2="12" /></svg>;
        case 'edit':   return <svg {...p}><path d="M4 20l4-1 11-11-3-3L5 16l-1 4z" /></svg>;
        case 'metadata': return <svg {...p}><path d="M4 4h7l9 9-7 7-9-9V4z" /><circle cx="8.5" cy="8.5" r="1" /></svg>;
        case 'move':   return <svg {...p}><line x1="4" y1="12" x2="19" y2="12" /><polyline points="13 6 19 12 13 18" /></svg>;
        case 'delete': return <svg {...p}><line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" /></svg>;
        case 'reconcile': return <svg {...p}><path d="M4 12a8 8 0 0 1 14-5" /><polyline points="18 3 18 7 14 7" /><path d="M20 12a8 8 0 0 1-14 5" /><polyline points="6 21 6 17 10 17" /></svg>;
        default:       return <svg {...p}><circle cx="12" cy="12" r="3.5" /></svg>;
    }
}

const RIBBON_MAX = 60;

export function SealOverviewRibbon({ log, onSelect }) {
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

/**
 * Fetched lazily on first expand — a single commit (e.g. a large import) can touch hundreds
 * of paths, so the full list isn't worth bundling into every log entry up front.
 */
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

export default function SealTimeline({ log, loading, loadingMore, hasMore, error, highlightOid, onRollback, onLoadMore }) {
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
                    <button type="button" className="btn" onClick={onLoadMore} disabled={loadingMore}>
                        {loadingMore ? t('Loading…') : t('Load older entries')}
                    </button>
                ) : (
                    <span className="seal-log-end">{t('Beginning of history')}</span>
                )}
            </div>
        </>
    );
}
