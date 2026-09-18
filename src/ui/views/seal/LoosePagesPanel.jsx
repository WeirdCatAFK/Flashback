/**
 * LoosePagesPanel — files changed outside Flashback since the last seal, grouped
 * by what happened to them.
 */

import { useT } from '../../translations/index';
import { LIST_VISIBLE_CAP } from './describe.js';

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

/**
 * "Loose pages" — sidecars changed outside Flashback with no seal commit yet. Framed as
 * pages that haven't been bound into the ledger, distinct from the stamped, sealed history below.
 */
export default function LoosePagesPanel({ drift, loading, error, onRefresh }) {
    const { t } = useT();
    const empty = drift && drift.added.length === 0 && drift.modified.length === 0 && drift.deleted.length === 0;
    return (
        <section className="seal-section">
            <div className="seal-section-head">
                <h2 className="eyebrow seal-eyebrow">{t('Loose pages')}</h2>
                <button type="button" className="btn" onClick={onRefresh} disabled={loading}>
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

/**
 * Condensed horizontal strip — the "Main" thread at a glance. Only one lane exists today
 * (the backend has no branch concept yet), but this is deliberately structured as a single
 * lane rather than a bespoke one-off, so a future multi-user branch model can add lanes here
 * without a rewrite. Clicking a stamp scrolls the matching entry into view below.
 * Capped at the most recent slice: the timeline below pages back indefinitely, but a
 * ribbon of 200 dots stops being something you can take in at a glance.
 */
