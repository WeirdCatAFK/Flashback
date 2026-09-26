/**
 * SealHealth — the maintenance behind History: one sentence on how things stand, the
 * files changed outside Flashback since the last seal, and the index. Checking the index
 * walks every file and changes nothing, so it runs on request. Syncing reads the files
 * back in, sealing the outside changes by default: an unsealed deletion would come back on
 * a later restore. Rebuilding throws the index away and reads every sidecar again, behind
 * a typed word, and says what it does not touch: study progress lives in its own store.
 * Sync and rebuild are `rebuildIndex` only.
 */

import { useState } from 'react';
import { useCan } from '../../sessionContext.js';
import { invalidateData } from '../../utils/dataBus';
import { useT } from '../../translations/index';
import { Rich } from '../../translations/components.jsx';
import { syncIndex, rebuildIndex } from '../../api/doctor';
import { collectDoctorIssues, TONE_CLASS } from './doctor.js';
import { formatOid, LIST_VISIBLE_CAP } from './describe.js';
import { driftCount } from './history.js';

/** The word that arms a rebuild. Compared without case. */
const REBUILD_WORD = 'rebuild';

function Paths({ label, tone, paths }) {
  const { t } = useT();
  if (!paths?.length) return null;
  const more = paths.length - LIST_VISIBLE_CAP;
  return (
    <div className="sl-group">
      <div className={`sl-label ${TONE_CLASS[tone] ?? ''}`}>{label} · {paths.length}</div>
      {paths.slice(0, LIST_VISIBLE_CAP).map((p, i) => <div key={`${p}-${i}`} className="sl-file">{p}</div>)}
      {more > 0 && <div className="sl-file sl-muted">{t('+{n} more', { n: more })}</div>}
    </div>
  );
}

/** What a sync or a rebuild did, as one line. */
function resultLine(result, t) {
  if (result.kind === 'sync') {
    const a = result.actions ?? {};
    const parts = [];
    if (a.foldersIndexed) parts.push(t('{n} folders indexed', { n: a.foldersIndexed }));
    if (a.documentsIndexed) parts.push(t('{n} documents indexed', { n: a.documentsIndexed }));
    if (a.documentsReindexed) parts.push(t('{n} reindexed', { n: a.documentsReindexed }));
    if (a.foldersRemoved) parts.push(t('{n} folders dropped', { n: a.foldersRemoved }));
    if (a.documentsRemoved) parts.push(t('{n} documents dropped', { n: a.documentsRemoved }));
    if (a.mediaRegistered) parts.push(t('{n} media registered', { n: a.mediaRegistered }));
    if (a.mediaRowsRemoved) parts.push(t('{n} media rows dropped', { n: a.mediaRowsRemoved }));
    const head = parts.length ? parts.join(' · ') : t('The index already matched your files; nothing to change.');
    return result.sealedOid ? `${head} · ${t('Sealed as {oid}', { oid: formatOid(result.sealedOid) })}` : head;
  }
  const s = result.summary ?? {};
  return t('Rebuilt: {documents} documents, {folders} folders, {cards} cards and {decks} decks read from your files.', {
    documents: s.documentsIndexed ?? 0, folders: s.foldersIndexed ?? 0, cards: s.flashcards ?? 0, decks: s.decks ?? 0,
  });
}

function Report({ report }) {
  const { t, tp, formatNumber } = useT();
  const c = report.counts;
  const ok = report.db.integrity === 'ok';
  const issues = collectDoctorIssues(report, t);
  return (
    <div className="sl-report">
      <p className="sl-p">
        {ok
          ? <span className="sl-ok">{t('Database integrity OK.')}</span>
          : <span className="sl-bad">{t('Integrity check failed: {status}.', { status: report.db.integrity })}</span>}{' '}
        {t('The index lists {documents}, {folders}, {cards} ({standalone} without a document) and {links}.', {
          documents: tp('{n} document', '{n} documents', c.documents, { n: formatNumber(c.documents) }),
          folders: tp('{n} folder', '{n} folders', c.folders, { n: formatNumber(c.folders) }),
          cards: tp('{n} card', '{n} cards', c.flashcards, { n: formatNumber(c.flashcards) }),
          standalone: formatNumber(c.standaloneCards),
          links: tp('{n} pending link', '{n} pending links', c.pendingLinks, { n: formatNumber(c.pendingLinks) }),
        })}
      </p>
      {ok && issues.length === 0 && <p className="sl-p">{t('It matches your files exactly.')}</p>}
      {issues.length > 0 && (
        <>
          <p className="sl-p">{t('It differs from your files here. Syncing reads them in.')}</p>
          {issues.map((g) => <Paths key={g.label} label={g.label} tone={g.tone} paths={g.paths} />)}
        </>
      )}
      {!ok && <p className="sl-p">{t('A sync can’t repair a damaged database; rebuild the index below.')}</p>}
    </div>
  );
}

function Rebuild({ onRebuilt }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const armed = typed.trim().toLowerCase() === REBUILD_WORD;

  if (!open) {
    return <button type="button" className="link-action" onClick={() => setOpen(true)}>{t('Rebuild the index from scratch')}</button>;
  }
  const go = async () => {
    if (!armed) return;
    setBusy(true);
    setError(null);
    try {
      await onRebuilt(await rebuildIndex());
      setOpen(false);
      setTyped('');
    } catch (e) {
      setError(e.message ?? t('Rebuild failed'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="sl-confirm">
      <p>
        <b>{t('Rebuild the index from your files?')}</b>{' '}
        <Rich
          text={t('Flashback throws away its index and reads every {sidecar} file again. Your files aren’t touched, and study progress lives in its own store, so no one’s schedule or review history is lost. Use it only when a sync can’t repair the index.')}
          values={{ sidecar: <code>.flashback</code> }}
        />
      </p>
      <label className="sl-type">
        <Rich text={t('Type {word} to confirm')} values={{ word: <code>{REBUILD_WORD}</code> }} />
        <input className="field field--sm" value={typed} onChange={(e) => setTyped(e.target.value)} disabled={busy}
          autoFocus spellCheck={false} autoComplete="off"
          onKeyDown={(e) => { if (e.key === 'Enter') go(); if (e.key === 'Escape') setOpen(false); }} />
      </label>
      {error && <p className="sl-error">{error}</p>}
      <div className="sl-confirm-acts">
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setOpen(false)} disabled={busy}>{t('Cancel')}</button>
        <button type="button" className="btn btn--danger-quiet btn--sm" onClick={go} disabled={busy || !armed}>{busy ? t('Rebuilding…') : t('Rebuild index')}</button>
      </div>
    </div>
  );
}

export default function SealHealth({ drift, driftLoading, driftError, onRefreshDrift, doctor, onChanged }) {
  const { t, tp, formatNumber } = useT();
  const canRepair = useCan('rebuildIndex');
  const [sealOutside, setSealOutside] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const outside = driftCount(drift);
  const report = doctor.report;
  const integrityOk = report?.db.integrity === 'ok';

  const after = async (res) => {
    setResult(res);
    invalidateData();
    onChanged();
    try { await doctor.run(); } catch {}
  };
  const sync = async () => {
    setSyncing(true);
    setError(null);
    try {
      await after({ kind: 'sync', ...(await syncIndex(sealOutside)) });
    } catch (e) {
      setError(e.message ?? t('Sync failed'));
    } finally {
      setSyncing(false);
    }
  };

  return (
    <>
      <p className="sl-status">
        {driftError ? <span className="sl-error">{driftError}</span>
          : outside > 0 ? (
            <Rich
              text={tp('{n} file changed outside Flashback. Nothing is wrong: sealing it into history makes a later restore treat it as a real change.',
                '{n} files changed outside Flashback. Nothing is wrong: sealing them into history makes a later restore treat them as real changes.',
                outside, { n: '{n}' })}
              values={{ n: <b>{formatNumber(outside)}</b> }}
            />
          ) : drift ? t('Every file is sealed, and nothing changed outside Flashback.')
            : t('Looking for changes made outside Flashback…')}
      </p>

      <section className="sl-sec" aria-labelledby="sl-outside">
        <div className="sl-sec-head">
          <h2 id="sl-outside" className="sl-h">{t('Changed outside Flashback')}</h2>
          <button type="button" className="link-action" onClick={onRefreshDrift} disabled={driftLoading}>{driftLoading ? t('Looking…') : t('Look again')}</button>
        </div>
        <p className="sl-p">{t('Files edited, added or removed by another program since the last seal.')}</p>
        {drift && outside === 0 && <p className="sl-muted">{t('Nothing changed outside Flashback.')}</p>}
        {drift && outside > 0 && (
          <>
            <Paths label={t('Added')} tone="added" paths={drift.added} />
            <Paths label={t('Modified')} tone="modified" paths={drift.modified} />
            <Paths label={t('Deleted')} tone="deleted" paths={drift.deleted} />
          </>
        )}
      </section>

      <section className="sl-sec" aria-labelledby="sl-index">
        <h2 id="sl-index" className="sl-h">{t('The index')}</h2>
        {report ? <Report report={report} /> : (
          <p className="sl-p">{t('Checking compares every file on disk with Flashback’s index. It changes nothing.')}</p>
        )}
        {doctor.error && <p className="sl-error">{doctor.error}</p>}
        <div className="sl-row">
          <button type="button" className="btn btn--sm" onClick={() => { setResult(null); doctor.run().catch(() => {}); }} disabled={doctor.loading}>
            {doctor.loading ? t('Checking…') : report ? t('Check again') : t('Check the index')}
          </button>
        </div>

        {report && canRepair && integrityOk && (
          <div className="sl-action">
            <label className="sl-check">
              <input type="checkbox" checked={sealOutside} onChange={(e) => setSealOutside(e.target.checked)} disabled={syncing} />
              {t('Seal the changes made outside Flashback into history (recommended)')}
            </label>
            <p className="sl-hint">
              {sealOutside
                ? t('They become one entry in History, so a later restore treats them as real changes.')
                : t('They stay unsealed, so a later restore may undo them or bring them back.')}
            </p>
            {report.documents.hashConflicts.length > 0 && (
              <p className="sl-hint">{t('Documents that share a duplicate identity are left untouched and reported.')}</p>
            )}
            <button type="button" className="btn btn--quiet-accent btn--sm" onClick={sync} disabled={syncing}>
              {syncing ? t('Syncing…') : t('Sync index to files')}
            </button>
          </div>
        )}
        {error && <p className="sl-error">{error}</p>}
        {result && (
          <p className="sl-done">
            {resultLine(result, t)}
            {result.warnings?.length > 0 && ` · ${tp('{n} warning: {first}', '{n} warnings, the first: {first}', result.warnings.length, { first: result.warnings[0] })}`}
          </p>
        )}

        <div className="sl-deep">
          <div className="sl-label">{t('If the index is damaged')}</div>
          {canRepair
            ? <Rebuild onRebuilt={(res) => after({ kind: 'rebuild', ...res })} />
            : <p className="sl-muted">{t('Repairing the index is the vault owner’s to do. Ask them to run a sync or a rebuild.')}</p>}
        </div>
      </section>
    </>
  );
}
