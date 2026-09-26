/**
 * SealHistory — the log read like the Diary: a ribbon of ticks (one per seal, oldest to
 * current), then the seals grouped by day, one sentence each, each pressed with a stamp
 * whose glyph (not colour) says what happened. Consecutive highlight and card edits to one
 * document fold into a run (history.js). An entry's changed files load on demand; Restore
 * asks inline, right under the entry, saying what goes back and what does not. Restore is
 * `rollbackHistory` only, and hidden rather than disabled.
 */

import { useState, useEffect } from 'react';
import { getCommitFiles } from '../../api/seal';
import { useSession } from '../../sessionContext.js';
import { useT } from '../../translations/index';
import { Rich } from '../../translations/components.jsx';
import { formatOid, isSidecar, documentPath, LIST_VISIBLE_CAP } from './describe.js';
import { sealLine, byDay, foldRuns } from './history.js';

/** The ribbon shows the newest seals only: past a few dozen ticks it stops being readable at a glance. */
const RIBBON_MAX = 60;

const GLYPH = {
  create: <path d="M8 4.5v7M4.5 8h7" />,
  edit: <path d="M4.5 11.5l.6-2.3 5-5 1.7 1.7-5 5z" />,
  meta: <><path d="M4 4h4l4 4-4 4-4-4z" /><circle cx="6.3" cy="6.3" r=".6" fill="currentColor" /></>,
  move: <path d="M4 8h7M8.5 5.5 11 8l-2.5 2.5" />,
  delete: <path d="M5.2 5.2l5.6 5.6M10.8 5.2l-5.6 5.6" />,
  reconcile: <><path d="M4.5 8a3.5 3.5 0 0 1 6-2.5M11.5 8a3.5 3.5 0 0 1-6 2.5" /><path d="M10.5 3.8v1.9H8.6M5.5 12.2v-1.9h1.9" /></>,
  other: <circle cx="8" cy="8" r="1.8" />,
};

const GLYPH_OF = {
  folder: 'create', deck: 'create', added: 'create', text: 'edit', metadata: 'meta',
  renamed: 'move', moved: 'move', deleted: 'delete', reconcile: 'reconcile',
};

export function Stamp({ kind }) {
  return (
    <span className="sl-stamp" aria-hidden="true">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
        {GLYPH[GLYPH_OF[kind] ?? 'other']}
      </svg>
    </span>
  );
}

/** What a seal did, as one sentence with the thing it touched in the reading weight. */
function Sentence({ line }) {
  const { t } = useT();
  const name = <b>{line.name}</b>;
  const from = <b>{line.from}</b>;
  switch (line.kind) {
    case 'folder': return <Rich text={t('Created the folder {name}')} values={{ name }} />;
    case 'deck': return t('Created a deck');
    case 'added': return <Rich text={t('Added {name}')} values={{ name }} />;
    case 'text': return <Rich text={t('Edited the text of {name}')} values={{ name }} />;
    case 'metadata': return <Rich text={t('Changed highlights, cards or tags in {name}')} values={{ name }} />;
    case 'renamed': return <Rich text={t('Renamed {from} to {name}')} values={{ name, from }} />;
    case 'moved': return line.from
      ? <Rich text={t('Moved {name} from {from}')} values={{ name, from: line.from }} />
      : <Rich text={t('Moved {name} from the top level')} values={{ name }} />;
    case 'deleted': return <Rich text={t('Deleted {name}')} values={{ name }} />;
    case 'reconcile': return <Rich text={t('Sealed {name} changed outside Flashback')} values={{ name }} />;
    default: return line.name;
  }
}

/** The files a seal touched, fetched on first open: a single import can touch hundreds. */
function ChangedFiles({ oid }) {
  const { t } = useT();
  const [files, setFiles] = useState(null);
  const [error, setError] = useState(null);
  const [all, setAll] = useState(false);
  useEffect(() => {
    let live = true;
    getCommitFiles(oid)
      .then((f) => { if (live) setFiles(f); })
      .catch((e) => { if (live) setError(e.message ?? t('Failed to load changed files')); });
    return () => { live = false; };
  }, [oid, t]);
  if (error) return <div className="sl-files"><p className="sl-error">{error}</p></div>;
  if (!files) return <div className="sl-files"><p className="sl-muted">{t('Loading…')}</p></div>;
  const rows = [...files.added, ...files.modified, ...files.deleted];
  const docs = rows.filter((p) => !isSidecar(p));
  const meta = rows.filter((p) => isSidecar(p)).map(documentPath);
  const cap = (list) => (all ? list : list.slice(0, LIST_VISIBLE_CAP));
  return (
    <div className="sl-files">
      {docs.length > 0 && <div className="sl-label">{t('Documents')}</div>}
      {cap(docs).map((p) => <div key={`d:${p}`} className="sl-file">{p}</div>)}
      {meta.length > 0 && <div className="sl-label">{t('Highlights, cards and tags')}</div>}
      {cap(meta).map((p) => <div key={`m:${p}`} className="sl-file">{p}</div>)}
      {!all && Math.max(docs.length, meta.length) > LIST_VISIBLE_CAP && (
        <button type="button" className="link-action" onClick={() => setAll(true)}>{t('Show all {n} files', { n: rows.length })}</button>
      )}
    </div>
  );
}

function RestoreConfirm({ commit, newer, onCancel, onRestore }) {
  const { t, tp, formatDateTime } = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await onRestore(commit.oid);
    } catch (e) {
      setError(e.message ?? t('Restore failed'));
      setBusy(false);
    }
  };
  return (
    <div className="sl-confirm" role="alert">
      <p>
        <b>{t('Restore the workspace to {when}?', { when: formatDateTime((commit.commit.author?.timestamp ?? 0) * 1000) })}</b>{' '}
        {t('Your documents and folders go back to how they were then, and changes on disk that were never sealed are discarded.')}
        {newer > 0 && ` ${tp('The newer seal stays in the log until you edit again; after that it drops out.', 'The {n} newer seals stay in the log until you edit again; after that they drop out.', newer)}`}
        {' '}{t('Review schedules and study history are kept apart and don’t change.')}
      </p>
      {error && <p className="sl-error">{error}</p>}
      <div className="sl-confirm-acts">
        <button type="button" className="btn btn--ghost btn--sm" onClick={onCancel} disabled={busy} autoFocus>{t('Cancel')}</button>
        <button type="button" className="btn btn--danger-quiet btn--sm" onClick={go} disabled={busy}>{busy ? t('Restoring…') : t('Restore')}</button>
      </div>
    </div>
  );
}

function Entry({ commit, index, inner, flashing, me, canRestore, onRestore }) {
  const tr = useT();
  const { t, formatTime, formatDateTime } = tr;
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const line = sealLine(commit, tr);
  const current = index === 0;
  const ms = (commit.commit.author?.timestamp ?? 0) * 1000;
  const author = commit.commit.author;
  const by = author?.email && me && author.email !== me ? author.name : null;
  const where = [line.dir, by].filter(Boolean).join(' · ');
  return (
    <>
      <div id={`seal-entry-${commit.oid}`} className={`sl-entry${inner ? ' is-inner' : ''}${current ? ' is-current' : ''}${flashing ? ' is-flash' : ''}`}>
        <Stamp kind={line.kind} />
        <div className="sl-text">
          <span className="sl-sentence"><Sentence line={line} /></span>
          {where && <span className="sl-dir">{where}</span>}
        </div>
        {current && <span className="sl-current">{t('current')}</span>}
        <span className="sl-time" title={`${formatDateTime(ms)} · ${formatOid(commit.oid)}`}>{formatTime(ms)}</span>
        <span className="sl-acts">
          {commit.stats && commit.stats.added + commit.stats.modified + commit.stats.deleted > 0 && (
            <button type="button" className="link-action" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              {open ? t('Hide changes') : t('Changes')}
            </button>
          )}
          {!current && canRestore && (
            <button type="button" className="link-action" onClick={() => setConfirming(true)}>{t('Restore to here')}</button>
          )}
        </span>
      </div>
      {open && <ChangedFiles oid={commit.oid} />}
      {confirming && <RestoreConfirm commit={commit} newer={index} onCancel={() => setConfirming(false)} onRestore={onRestore} />}
    </>
  );
}

function Run({ run, open, onToggle, indexOf, entryProps }) {
  const tr = useT();
  const { t, formatTime } = tr;
  const first = run.commits[0];
  const line = sealLine(first, tr);
  const newestMs = (first.commit.author?.timestamp ?? 0) * 1000;
  const oldestMs = (run.commits[run.commits.length - 1].commit.author?.timestamp ?? 0) * 1000;
  const author = first.commit.author;
  const by = author?.email && entryProps.me && author.email !== entryProps.me ? author.name : null;
  return (
    <>
      <div className={`sl-entry is-run${open ? ' is-open' : ''}`} role="button" tabIndex={0} aria-expanded={open}
        onClick={onToggle} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}>
        <Stamp kind="metadata" />
        <div className="sl-text">
          <span className="sl-sentence"><Rich text={t('{n} changes to {name}', { n: run.commits.length })} values={{ name: <b>{line.name}</b> }} /></span>
          <span className="sl-dir">{[t('highlights, cards and tags'), line.dir, by].filter(Boolean).join(' · ')}</span>
        </div>
        {indexOf(first) === 0 && <span className="sl-current">{t('current')}</span>}
        <span className="sl-time">{formatTime(oldestMs)}–{formatTime(newestMs)}</span>
        <span className="sl-acts"><span className="link-action">{open ? t('Fold') : t('Show each')}</span></span>
      </div>
      {open && (
        <div className="sl-run">
          {run.commits.map((c) => <Entry key={c.oid} commit={c} index={indexOf(c)} inner {...entryProps} flashing={entryProps.flash === c.oid} />)}
        </div>
      )}
    </>
  );
}

export function Ribbon({ log, onJump }) {
  const tr = useT();
  const { t, formatDateTime } = tr;
  const ticks = log.slice(0, RIBBON_MAX).reverse();
  return (
    <figure className="sl-ribbon">
      <div className="sl-ticks" role="group" aria-label={t('The last {n} seals, oldest first', { n: ticks.length })}>
        {ticks.map((c, i) => (
          <button key={c.oid} type="button" className={`sl-tick${i === ticks.length - 1 ? ' is-current' : ''}`}
            title={`${formatDateTime((c.commit.author?.timestamp ?? 0) * 1000)}: ${sealLine(c, tr).name}`}
            onClick={() => onJump(c.oid)} />
        ))}
      </div>
      <figcaption><span>{t('Older')}</span><span>{t('Current')}</span></figcaption>
    </figure>
  );
}

export default function SealHistory({ log, loading, loadingMore, hasMore, error, onLoadMore, outside, onShowHealth, openRuns, onToggleRun, flash, onJump, onRestore }) {
  const tr = useT();
  const { t, tp, formatDay, formatNumber } = tr;
  const { account, identity, can } = useSession();
  const me = account?.email ?? identity?.email ?? null;
  const canRestore = can('rollbackHistory');

  if (loading && log.length === 0) return <p className="sl-muted">{t('Loading…')}</p>;
  if (error && log.length === 0) return <p className="sl-error">{error}</p>;
  if (log.length === 0) return <p className="sl-muted">{t('Nothing sealed yet. Changes you make will appear here.')}</p>;

  const positions = new Map(log.map((c, i) => [c.oid, i]));
  const indexOf = (c) => positions.get(c.oid) ?? -1;
  const now = new Date();
  const key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const today = key(now);
  const yesterday = key(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const dayName = (day) => (day === today ? t('Today') : day === yesterday ? t('Yesterday') : formatDay(day));
  const entryProps = { me, canRestore, onRestore, flash };

  return (
    <>
      {outside > 0 && (
        <p className="sl-notice">
          {tp('{n} file changed outside Flashback since the last seal.', '{n} files changed outside Flashback since the last seal.', outside, { n: formatNumber(outside) })}{' '}
          <button type="button" className="link-action" onClick={onShowHealth}>{t('See Health')}</button>
        </p>
      )}
      <Ribbon log={log} onJump={onJump} />
      {byDay(log).map(({ day, commits }) => (
        <section key={day} className="sl-day" aria-label={dayName(day)}>
          <div className="sl-day-head">
            <span>{dayName(day)}</span>
            <span className="sl-day-n">{tp('{n} seal', '{n} seals', commits.length, { n: formatNumber(commits.length) })}</span>
          </div>
          {foldRuns(commits, tr).map((g) => (g.kind === 'run'
            ? <Run key={g.key} run={g} open={openRuns.has(g.key)} onToggle={() => onToggleRun(g.key)} indexOf={indexOf} entryProps={entryProps} />
            : <Entry key={g.commit.oid} commit={g.commit} index={indexOf(g.commit)} flashing={flash === g.commit.oid} {...entryProps} />))}
        </section>
      ))}
      {error && <p className="sl-error">{error}</p>}
      <div className="sl-end">
        {hasMore ? (
          <button type="button" className="btn btn--ghost btn--sm" onClick={onLoadMore} disabled={loadingMore}>
            {loadingMore ? t('Loading…') : t('Load older seals')}
          </button>
        ) : t('Beginning of history')}
      </div>
    </>
  );
}
